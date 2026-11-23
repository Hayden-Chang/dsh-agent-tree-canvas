/** In-flight responses must preserve the user's current editor and candidate. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { quoteReference } from '../src/client/quote-reference.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CanvasDocument, CanvasId, SummaryDocument } from '../src/types.ts'
import { CanvasController } from '../src/client/controller.ts'
import type { DraftJournal, EditorDraft } from '../src/client/draft-journal.ts'

const id = 'controller-session' as SessionId
const initial: SummaryDocument = { sessionId: id, version: 0, revision: 0, markdown: 'Saved', versions: [], excerpts: [], draft: null }

it('renames the owning DSH Session and reports rejection without discarding the edit', async () => {
  const f = fixture(), rename = vi.fn(async (_title: string) => ({ ok: true as const, value: { title: 'Manual title', seq: 12 } }))
  const using = vi.fn(async (_id: SessionId, _options: object, operation: (reference: object) => Promise<unknown>) =>
    operation({ ready: Promise.resolve({ session: { rename } }) }))
  f.ctx.provide('sessions', { using } as never)
  expect(await f.controller.face.renameNode(id, 'Manual title')).toBe(true)
  expect(rename).toHaveBeenCalledWith('Manual title')
  expect(using.mock.calls[0]?.[0]).toBe(id)
  rename.mockRejectedValueOnce(new Error('unavailable'))
  expect(await f.controller.face.renameNode(id, 'Keep my edit')).toBe(false)
  expect(f.snapshot().notice?.kind).toBe('renameFailed')
})

function fixture(journal?: DraftJournal) {
  const ctx = new Context()
  let saved = initial
  const remote = {
    arrange: vi.fn(),
    mindmap: vi.fn(),
    list: vi.fn(async () => ({ ok: true as const, value: [] as CanvasDocument[] })),
    removeNode: vi.fn<(...args: [CanvasId, SessionId]) => Promise<{ ok: true; value: CanvasDocument }>>(),
    updateNode: vi.fn(),
    fork: vi.fn<(...args: [CanvasId, SessionId, number | null, string]) => Promise<{ ok: true; value: CanvasDocument }>>(),
    summary: vi.fn(async () => ({ ok: true as const, value: saved })),
    saveSummary: vi.fn(async (request: { markdown: string; revision: number }) => {
      if (request.revision !== saved.revision) return { ok: false as const, error: { code: 'canvas/conflict' } }
      saved = { ...saved, markdown: request.markdown, revision: saved.revision + 1, version: saved.version + 1 }
      return { ok: true as const, value: saved }
    }),
    generate: vi.fn(async (_id: SessionId, _signal: AbortSignal) => {
      saved = { ...saved, version: saved.version + 1, draft: { markdown: 'Generated', baseRevision: saved.revision, throughSeq: 3 } }
      return { ok: true as const, value: saved }
    }),
    excerpt: vi.fn(async (_id: SessionId, text: string) => {
      saved = { ...saved, markdown: saved.markdown + '\n\n' + text, revision: saved.revision + 1, version: saved.version + 1 }
      return { ok: true as const, value: saved }
    }),
  }
  ctx.provide('remote', { sessionCanvas: remote } as never)
  const insertQuote = vi.fn(() => true)
  const conversation = { input: { for: () => ({ insertReference: insertQuote, state: { getSnapshot: () => ({ draft: '', occurrences: [], draftRev: 0 }) } }) } }
  ctx.provide('conversation', conversation as never)
  const controller = new CanvasController(ctx, () => {}, 400, journal)
  onTestFinished(async () => { await controller.dispose(); await ctx.fiber.dispose() })
  return { ctx, controller, remote, conversation, insertQuote, snapshot: () => controller.source.getSnapshot(),
    changeSaved: (value: SummaryDocument) => { saved = value } }
}

it('settles a placement only after its response is applied and reports a rejected save', async () => {
  const f = fixture(), canvasId = 'moving-canvas' as CanvasId
  const canvas: CanvasDocument = { id: canvasId, title: 'Moving', revision: 1, nodes: [
    { sessionId: id, parentId: null, forkSeq: null, title: 'Root', x: 80, y: 80, mode: 'chat', collapsed: false },
  ] }
  f.controller.source.set({ ...f.snapshot(), canvases: [canvas], activeId: canvasId })
  const pending = Promise.withResolvers<{ ok: true; value: CanvasDocument }>()
  f.remote.arrange.mockReturnValueOnce(pending.promise)
  let settled = false
  const save = f.controller.face.arrange(canvasId, [{ sessionId: id, x: 240, y: 180 }]).then(() => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(f.snapshot().busy).toBe(true)
  const updated = { ...canvas, revision: 2, nodes: [{ ...canvas.nodes[0]!, x: 240, y: 180 }] }
  pending.resolve({ ok: true, value: updated })
  await save
  expect(f.snapshot().canvases).toEqual([updated])
  expect(f.snapshot().busy).toBe(false)
  f.remote.arrange.mockRejectedValueOnce(new Error('Offline'))
  await f.controller.face.arrange(canvasId, [{ sessionId: id, x: 400, y: 300 }])
  expect(f.snapshot().canvases).toEqual([updated])
  expect(f.snapshot().busy).toBe(false)
  expect(f.snapshot().notice?.kind).toBe('failed')
})

it('quotes exact selected text only after the child is retained and retries a blocked draft without another fork', async () => {
  const f = fixture(), childId = 'quoted-child' as SessionId, canvasId = 'quote-canvas' as CanvasId
  const canvas: CanvasDocument = { id: canvasId, title: 'Notes', revision: 1, nodes: [
    { sessionId: childId, parentId: id, forkSeq: 8, title: 'Child', x: 640, y: 0, mode: 'chat', collapsed: false },
  ] }
  f.remote.fork.mockResolvedValue({ ok: true, value: canvas })
  const text = 'Selected paragraph\n\nWith another line.'
  const source = { sessionId: id, seq: 6, turn: 1, offset: 3 }
  f.controller.face.quoteChild(canvasId, id, 8, 'Child', text, source)
  await vi.waitFor(() => { expect(f.snapshot().canvases).toEqual([canvas]) })
  expect(f.remote.fork).toHaveBeenCalledWith(canvasId, id, 8, 'Child', { text, source })
  expect(f.insertQuote).not.toHaveBeenCalled()
  const binding = { sessionId: childId, ctx: f.ctx } as never
  f.ctx.provide('sessions', { binding: () => binding } as never)
  f.insertQuote.mockReturnValueOnce(false)
  expect(() => { f.controller.prepareChat(binding) }).toThrow('Child conversation could not accept the quote')
  f.controller.prepareChat(binding)
  f.controller.prepareChat(binding)
  expect(f.insertQuote.mock.calls).toEqual([[quoteReference(text, source), { start: 0, end: 0, draftRev: 0 }], [quoteReference(text, source), { start: 0, end: 0, draftRev: 0 }]])
  expect(f.remote.fork).toHaveBeenCalledTimes(1)
})

it('keeps an explicit source when text repeats and refuses to guess for ambiguous old quotes', () => {
  const f = fixture(), childId = 'child' as SessionId
  const nodes: CanvasDocument['nodes'] = [
    { sessionId: id, parentId: null, forkSeq: null, title: 'Parent', x: 0, y: 0, mode: 'chat', collapsed: false },
    { sessionId: childId, parentId: id, forkSeq: 8, title: 'Child', x: 640, y: 0, mode: 'chat', collapsed: false },
  ]
  f.controller.source.set({ ...f.snapshot(), canvases: [{ id: 'canvas' as CanvasId, title: 'Notes', revision: 1, nodes }] })
  let messages = [
    { seq: 6, role: 'assistant' as const, text: 'repeated sentence', inherited: true },
    { seq: 12, role: 'assistant' as const, text: 'repeated sentence', inherited: false },
  ]
  f.ctx.provide('sessions', { binding: () => ({ session: { projections: { faceOf: () => ({ getSnapshot: () => ({
    inheritedEventCount: 9, messages, turns: [{ turn: 1, seq: 8 }, { turn: 2, seq: 14 }],
  }) }) } } }) } as never)
  const original = { sessionId: id, seq: 6, turn: 1, offset: 0 }
  expect(f.controller.quoteSource(childId, 'repeated sentence', original)).toEqual(original)
  expect(f.controller.quoteSource(childId, 'repeated sentence')).toBeUndefined()
  messages = messages.slice(0, 1)
  expect(f.controller.quoteSource(childId, 'repeated sentence')).toEqual({ ...original, sessionId: childId })
  expect(f.controller.quoteSource(childId, 'missing')).toBeUndefined()
})

function explanation() {
  const f = fixture(), child = 'explanation-child' as SessionId, canvasId = 'explanation-canvas' as CanvasId
  const canvas: CanvasDocument = { id: canvasId, title: 'Explanation', revision: 1, nodes: [
    { sessionId: child, parentId: id, forkSeq: 8, title: 'Child', x: 640, y: 80, mode: 'chat', collapsed: false },
  ] }
  const binding = { sessionId: child, ctx: f.ctx } as never
  let draft = ''
  const initialize = vi.fn((_binding: unknown, request: { prompt: string }) => { draft = request.prompt; return 'applied' as 'applied' | 'preserved' | 'blocked' })
  const submit = vi.fn()
  Object.assign(f.conversation.input, { requestDraftInitialization: initialize,
    for: () => ({ insertReference: f.insertQuote, submit, state: { getSnapshot: () => ({ draft, occurrences: [], draftRev: 1 }) } }),
  })
  f.ctx.provide('locale', { bind: () => () => 'Please explain this passage in context.' } as never)
  f.ctx.provide('sessions', { binding: () => binding } as never)
  f.remote.fork.mockResolvedValue({ ok: true, value: canvas })
  const source = { sessionId: id, seq: 6, turn: 1, offset: 7 }
  const explain = (text = 'Exact selected passage') => f.controller.face.explainChild(canvasId, id, 8, 'Child', text, source)
  return { ...f, binding, initialize, submit, explain, canvas, child, source, draft: () => draft }
}

it('explains a selection once through the retained child input and keeps its source origin', async () => {
  const f = explanation()
  f.explain(); f.explain()
  await vi.waitFor(() => { expect(f.snapshot().canvases).toEqual([f.canvas]) })
  expect(f.submit).not.toHaveBeenCalled()
  f.controller.prepareChat(f.binding); f.controller.prepareChat(f.binding)
  expect(f.remote.fork).toHaveBeenCalledExactlyOnceWith(f.canvas.id, id, 8, 'Child', { text: 'Exact selected passage', source: f.source })
  expect(f.initialize).toHaveBeenCalledExactlyOnceWith(f.binding, { prompt: 'Please explain this passage in context.\n\n', whenDraftExists: 'keep' })
  expect(f.insertQuote).toHaveBeenCalledExactlyOnceWith(quoteReference('Exact selected passage', f.source), { start: f.draft().length, end: f.draft().length, draftRev: 1 })
  expect(f.submit).toHaveBeenCalledExactlyOnceWith('queue', 'click')
  expect(f.submit.mock.invocationCallOrder[0]).toBeGreaterThan(f.insertQuote.mock.invocationCallOrder[0]!)
})

it('retries blocked explanation preparation without creating another child or sending twice', async () => {
  const f = explanation()
  f.explain()
  await vi.waitFor(() => { expect(f.snapshot().canvases).toHaveLength(1) })
  f.initialize.mockReturnValueOnce('blocked')
  expect(() => f.controller.prepareChat(f.binding)).toThrow('not ready')
  expect(f.submit).not.toHaveBeenCalled()
  f.insertQuote.mockReturnValueOnce(false)
  expect(() => f.controller.prepareChat(f.binding)).toThrow('could not accept')
  expect(f.submit).not.toHaveBeenCalled()
  f.controller.prepareChat(f.binding); f.controller.prepareChat(f.binding)
  expect(f.remote.fork).toHaveBeenCalledTimes(1)
  expect(f.initialize).toHaveBeenCalledTimes(2)
  expect(f.submit).toHaveBeenCalledTimes(1)
})

it('preserves an unexpected existing child draft and does not auto-send it', async () => {
  const f = explanation()
  f.explain()
  await vi.waitFor(() => { expect(f.snapshot().canvases).toHaveLength(1) })
  f.initialize.mockReturnValueOnce('preserved')
  f.controller.prepareChat(f.binding); f.controller.prepareChat(f.binding)
  expect(f.insertQuote).not.toHaveBeenCalled()
  expect(f.submit).not.toHaveBeenCalled()
  expect(f.snapshot().notice?.kind).toBe('explainFailed')
})

it('does not fork blank explanations or send after a fork fails, and never auto-retries a rejected submit', async () => {
  const f = explanation()
  f.explain('  '); expect(f.remote.fork).not.toHaveBeenCalled()
  f.remote.fork.mockRejectedValueOnce(new Error('Offline'))
  f.explain()
  await vi.waitFor(() => { expect(f.snapshot().busy).toBe(false) })
  expect(f.submit).not.toHaveBeenCalled()
  expect(f.snapshot().notice?.kind).toBe('failed')
  f.explain()
  await vi.waitFor(() => { expect(f.snapshot().canvases).toHaveLength(1) })
  f.submit.mockImplementationOnce(() => { throw new Error('Cannot submit') })
  f.controller.prepareChat(f.binding); f.controller.prepareChat(f.binding)
  expect(f.submit).toHaveBeenCalledTimes(1)
  expect(f.snapshot().canvases).toEqual([f.canvas])
  expect(f.snapshot().notice?.kind).toBe('explainFailed')
})

it('ignores an older summary read that completes after a new candidate', async () => {
  const f = fixture(), read = Promise.withResolvers<{ ok: true; value: SummaryDocument }>()
  f.remote.summary.mockImplementationOnce(() => read.promise)
  f.controller.face.loadSummary(id)
  f.controller.face.generate(id)
  await vi.waitFor(() => { expect(f.snapshot().summaries[id]?.draft?.markdown).toBe('Generated') })
  read.resolve({ ok: true, value: initial })
  await vi.waitFor(() => { expect(f.snapshot().generating).toEqual([]) })
  await f.controller.dispose()
  expect(f.snapshot().summaries[id]?.draft?.markdown).toBe('Generated')
})

it('keeps typing during save and appends exact excerpts to the unsaved editor', async () => {
  const f = fixture()
  f.controller.face.loadSummary(id)
  await vi.waitFor(() => { expect(f.snapshot().summaries[id]).toEqual(initial) })
  f.controller.face.editSummary(id, 'First edit')
  const save = Promise.withResolvers<{ ok: true; value: SummaryDocument }>()
  f.remote.saveSummary.mockImplementationOnce(() => save.promise)
  f.controller.face.saveSummary(id)
  await vi.waitFor(() => { expect(f.remote.saveSummary).toHaveBeenCalledTimes(1) })
  f.controller.face.editSummary(id, 'Continued typing')
  const accepted = { ...initial, markdown: 'First edit', revision: 1, version: 1 }
  f.changeSaved(accepted); save.resolve({ ok: true, value: accepted })
  await vi.waitFor(() => { expect(f.snapshot().drafts[id]).toEqual({ markdown: 'Continued typing', revision: 1 }) })
  f.controller.face.excerpt(id, '  exact\ntext  ', 1)
  await vi.waitFor(() => { expect(f.snapshot().drafts[id]?.markdown).toBe('Continued typing\n\n  exact\ntext  ') })
  f.controller.face.saveSummary(id)
  await vi.waitFor(() => { expect(f.snapshot().drafts[id]).toBeUndefined() })
  expect(f.snapshot().summaries[id]?.markdown).toBe('Continued typing\n\n  exact\ntext  ')
})

it('retains a conflicting draft and prevents late publications after disposal', async () => {
  const f = fixture()
  f.controller.face.loadSummary(id)
  await vi.waitFor(() => { expect(f.snapshot().summaries[id]).toEqual(initial) })
  f.controller.face.editSummary(id, 'Local work')
  f.changeSaved({ ...initial, markdown: 'Remote work', revision: 1, version: 1 })
  f.controller.face.saveSummary(id)
  await vi.waitFor(() => { expect(f.snapshot().notice?.kind).toBe('conflict') })
  expect(f.snapshot().drafts[id]?.markdown).toBe('Local work')
  const read = Promise.withResolvers<{ ok: true; value: SummaryDocument }>()
  f.remote.summary.mockImplementationOnce(() => read.promise)
  f.controller.face.loadSummary(id)
  const before = f.snapshot(), disposing = f.controller.dispose()
  read.resolve({ ok: true, value: { ...initial, version: 2 } })
  await disposing
  expect(f.snapshot()).toBe(before)
})

it('journals each edit immediately and coalesces idle typing into one save', async () => {
  const journal = { read: () => undefined, write: vi.fn() }, f = fixture(journal)
  f.controller.face.loadSummary(id)
  await vi.waitFor(() => { expect(f.snapshot().summaries[id]).toEqual(initial) })
  f.controller.face.editSummary(id, 'First')
  f.controller.face.editSummary(id, 'Second')
  expect(journal.write.mock.calls).toEqual([[id, { markdown: 'First', revision: 0 }], [id, { markdown: 'Second', revision: 0 }]])
  expect(f.remote.saveSummary).not.toHaveBeenCalled()
  await vi.waitFor(() => { expect(f.snapshot().drafts[id]).toBeUndefined() })
  expect(f.remote.saveSummary).toHaveBeenCalledExactlyOnceWith({ sessionId: id, markdown: 'Second', revision: 0 })
  expect(journal.write).toHaveBeenLastCalledWith(id, undefined)
})

it('keeps a failed autosave in recovery storage and retries without dropping edits', async () => {
  const journal = { read: () => undefined, write: vi.fn() }, f = fixture(journal)
  f.controller.face.loadSummary(id)
  await vi.waitFor(() => { expect(f.snapshot().summaries[id]).toEqual(initial) })
  f.remote.saveSummary.mockRejectedValueOnce(new Error('Offline'))
  f.controller.face.editSummary(id, 'Recoverable text')
  await vi.waitFor(() => { expect(f.snapshot().saveStates[id]).toBe('failed') })
  expect(journal.write).toHaveBeenLastCalledWith(id, { markdown: 'Recoverable text', revision: 0 })
  f.controller.face.saveSummary(id)
  await vi.waitFor(() => { expect(f.snapshot().saveStates[id]).toBeUndefined() })
  expect(f.snapshot().summaries[id]?.markdown).toBe('Recoverable text')
  expect(journal.write).toHaveBeenLastCalledWith(id, undefined)
})

it('recovers pending edits after remount and blocks automatic overwrite of a newer revision', async () => {
  let retained: EditorDraft | undefined = { markdown: 'Recovered', revision: 0 }
  const journal: DraftJournal = { read: () => retained, write: (_id, draft) => { retained = draft } }
  const f = fixture(journal)
  f.controller.face.loadSummary(id)
  await vi.waitFor(() => { expect(f.snapshot().summaries[id]?.markdown).toBe('Recovered') })
  expect(retained).toBeUndefined()
  retained = { markdown: 'Stale but valuable', revision: 0 }
  const other = fixture(journal)
  other.changeSaved({ ...initial, markdown: 'Newer saved text', revision: 3, version: 3 })
  other.controller.face.loadSummary(id)
  await vi.waitFor(() => { expect(other.snapshot().saveStates[id]).toBe('conflict') })
  expect(other.snapshot().drafts[id]).toEqual(retained)
  expect(other.remote.saveSummary).not.toHaveBeenCalled()
  other.controller.face.editSummary(id, 'Keep editing the conflict')
  expect(other.snapshot().saveStates[id]).toBe('conflict')
  await other.controller.dispose()
  expect(retained?.markdown).toBe('Keep editing the conflict')
})

it('keeps pending recovery data and cancels idle writes when the plugin unloads', async () => {
  const journal = { read: () => undefined, write: vi.fn() }, f = fixture(journal)
  f.controller.face.loadSummary(id)
  await vi.waitFor(() => { expect(f.snapshot().summaries[id]).toEqual(initial) })
  f.controller.face.editSummary(id, 'Before unload')
  await f.controller.dispose()
  expect(f.remote.saveSummary).not.toHaveBeenCalled()
  expect(journal.write).toHaveBeenLastCalledWith(id, { markdown: 'Before unload', revision: 0 })
})

it('does not start a queued excerpt after unload or erase unacknowledged recovery text', async () => {
  const journal = { read: () => undefined, write: vi.fn() }, f = fixture(journal)
  f.controller.face.loadSummary(id)
  await vi.waitFor(() => { expect(f.snapshot().summaries[id]).toEqual(initial) })
  const save = Promise.withResolvers<{ ok: true; value: SummaryDocument }>()
  f.remote.saveSummary.mockImplementationOnce(() => save.promise)
  f.controller.face.editSummary(id, 'In flight')
  f.controller.face.saveSummary(id)
  await vi.waitFor(() => { expect(f.remote.saveSummary).toHaveBeenCalledTimes(1) })
  f.controller.face.excerpt(id, 'Queued', 1)
  const disposing = f.controller.dispose()
  save.resolve({ ok: true, value: { ...initial, markdown: 'In flight', revision: 1, version: 1 } })
  await disposing
  expect(f.remote.excerpt).not.toHaveBeenCalled()
  expect(journal.write).toHaveBeenLastCalledWith(id, { markdown: 'In flight', revision: 0 })
})

it('reports an excerpt conflict when another writer advanced the saved note', async () => {
  const f = fixture()
  f.controller.face.loadSummary(id)
  await vi.waitFor(() => { expect(f.snapshot().summaries[id]).toEqual(initial) })
  f.controller.face.editSummary(id, 'Local text')
  f.changeSaved({ ...initial, markdown: 'Other writer', revision: 1, version: 1 })
  f.controller.face.excerpt(id, 'Exact excerpt', 1)
  await vi.waitFor(() => { expect(f.snapshot().saveStates[id]).toBe('conflict') })
  expect(f.snapshot().drafts[id]?.markdown).toBe('Local text')
  expect(f.snapshot().summaries[id]?.markdown).toBe('Other writer\n\nExact excerpt')
  expect(f.remote.saveSummary).not.toHaveBeenCalled()
})


it('keeps the current canvas and reports failure when creating a child fails', async () => {
  const f = fixture(), canvasId = 'failed-fork-canvas' as CanvasId
  const canvas: CanvasDocument = { id: canvasId, title: 'Notes', revision: 1, nodes: [
    { sessionId: id, parentId: null, forkSeq: null, title: 'Parent', x: 0, y: 0, mode: 'chat', collapsed: false },
  ] }
  f.controller.source.set({ ...f.snapshot(), canvases: [canvas], activeId: canvasId })
  f.remote.fork.mockRejectedValueOnce(new Error('Offline'))
  f.controller.face.fork(canvasId, id, 8, 'Child')
  await vi.waitFor(() => { expect(f.snapshot().notice?.kind).toBe('failed') })
  expect(f.remote.fork).toHaveBeenCalledExactlyOnceWith(canvasId, id, 8, 'Child')
  expect(f.snapshot().canvases).toEqual([canvas])
  expect(f.snapshot().activeId).toBe(canvasId)
  expect(f.snapshot().viewportTarget).toBeNull()
  expect(f.snapshot().busy).toBe(false)
})


it('retains drafts on failure and erases all local note state after confirmed deletion without saving it', async () => {
  const journal: DraftJournal = { read: () => undefined, write: vi.fn() }
  const f = fixture(journal), canvasId = 'delete-canvas' as CanvasId
  f.ctx.provide('sessions', { binding: () => undefined } as never)
  const canvas: CanvasDocument = { id: canvasId, title: 'Notes', revision: 1, nodes: [
    { sessionId: id, parentId: null, forkSeq: null, title: 'Root', x: 0, y: 0, mode: 'summary', collapsed: false },
  ] }
  f.controller.source.set({ ...f.snapshot(), canvases: [canvas], activeId: canvasId, summaries: { [id]: initial } })
  f.controller.face.editSummary(id, 'Unsaved notes')
  f.remote.removeNode.mockRejectedValueOnce(new Error('Offline'))
  f.controller.face.removeNode(canvasId, id)
  await vi.waitFor(() => { expect(f.remote.removeNode).toHaveBeenCalledOnce(); expect(f.snapshot().busy).toBe(false) })
  expect(f.snapshot().canvases).toEqual([canvas])
  expect(f.snapshot().drafts[id]?.markdown).toBe('Unsaved notes')
  expect(f.snapshot().notice?.kind).toBe('deleteFailed')
  const late = Promise.withResolvers<{ ok: true; value: SummaryDocument }>()
  f.remote.summary.mockReturnValueOnce(late.promise)
  f.controller.face.loadSummary(id)
  for (const key of [`dsh.conversation.${id}`, `session-canvas.legacy-draft.${id}`, `dsh-session-canvas-draft:${id}`]) localStorage.setItem(key, 'secret')
  f.remote.removeNode.mockResolvedValue({ ok: true, value: { ...canvas, revision: 2, nodes: [] } })
  f.controller.face.removeNode(canvasId, id)
  await vi.waitFor(() => { expect(f.snapshot().notice?.kind).toBe('removed') })
  late.resolve({ ok: true, value: initial })
  await vi.waitFor(() => expect(f.snapshot().busy).toBe(false))
  expect(f.snapshot().summaries[id]).toBeUndefined()
  expect(f.snapshot().drafts[id]).toBeUndefined()
  expect(f.snapshot().saveStates[id]).toBeUndefined()
  expect(journal.write).toHaveBeenLastCalledWith(id, undefined)
  expect(f.remote.saveSummary).not.toHaveBeenCalled()
  for (const key of [`dsh.conversation.${id}`, `session-canvas.legacy-draft.${id}`, `dsh-session-canvas-draft:${id}`]) expect(localStorage.getItem(key)).toBeNull()
})

it('quotes a summary into the existing draft and opens only that node in chat mode', async () => {
  const f = fixture(), canvasId = 'summary-canvas' as CanvasId
  const canvas: CanvasDocument = { id: canvasId, title: 'Notes', revision: 1, nodes: [
    { sessionId: id, parentId: null, forkSeq: null, title: 'Root', x: 0, y: 0, mode: 'summary', collapsed: false },
  ] }
  f.controller.source.set({ ...f.snapshot(), canvases: [canvas], activeId: canvasId, summaryOnly: [canvasId] })
  f.ctx.provide('sessions', { binding: () => ({ sessionId: id, ctx: f.ctx }) } as never)
  f.remote.updateNode.mockResolvedValue({ ok: true, value: { ...canvas, revision: 2, nodes: canvas.nodes.map(node => ({ ...node, mode: 'chat' })) } })
  f.controller.face.quoteSummary(canvasId, id, '  exact text  ', 4)
  await vi.waitFor(() => { expect(f.snapshot().summaryOnly).toEqual([]) })
  expect(f.insertQuote).toHaveBeenCalledWith(quoteReference('  exact text  ', { kind: 'summary', sessionId: id, offset: 4 }), { start: 0, end: 0, draftRev: 0 })
  expect(f.snapshot().canvases[0]?.nodes[0]?.mode).toBe('chat')
  expect(f.remote.fork).not.toHaveBeenCalled()
})

it('publishes a completed map in compact view and retains unsaved notes while blocking duplicate requests', async () => {
  const f = fixture(), canvasId = 'mindmap-canvas' as CanvasId
  const result: CanvasDocument = { id: canvasId, title: 'Map', revision: 2, nodes: [] }
  const pending = Promise.withResolvers<{ ok: true; value: { canvas: CanvasDocument; createdSessionIds: SessionId[] } }>()
  f.remote.mindmap.mockReturnValue(pending.promise)
  f.controller.face.loadSummary(id)
  await vi.waitFor(() => expect(f.snapshot().summaries[id]).toBeDefined())
  f.controller.face.editSummary(id, 'Unsaved original notes')
  f.controller.face.mindmap(canvasId, id, 9, 'EXACT SELECTION')
  f.controller.face.mindmap(canvasId, id, 9, 'duplicate')
  expect(f.remote.mindmap).toHaveBeenCalledTimes(1)
  expect(f.remote.mindmap.mock.calls[0]!.slice(0, 4)).toEqual([canvasId, id, 9, 'EXACT SELECTION'])
  expect(f.snapshot().mapping).toBe(canvasId)
  expect(f.snapshot().busy).toBe(true)
  pending.resolve({ ok: true, value: { canvas: result, createdSessionIds: [id] } })
  await vi.waitFor(() => expect(f.snapshot().mapping).toBeNull())
  expect(f.snapshot().canvases).toEqual([result])
  expect(f.snapshot().summaryOnly).toContain(canvasId)
  expect(f.snapshot().fitRequest?.canvasId).toBe(canvasId)
  expect(f.snapshot().drafts[id]?.markdown).toBe('Unsaved original notes')
})

it('cancels a mind map without publishing stale content and reloads to reconcile a late commit', async () => {
  const f = fixture(), canvasId = 'cancel-map' as CanvasId
  f.remote.mindmap.mockImplementation((_canvas, _session, _seq, _text, signal: AbortSignal) =>
    new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })))
  f.controller.face.mindmap(canvasId, id, null, 'selection')
  f.controller.face.cancelMindmap()
  await vi.waitFor(() => expect(f.snapshot().mapping).toBeNull())
  expect(f.remote.list).toHaveBeenCalledTimes(1)
  expect(f.snapshot().canvases).toEqual([])
  expect(f.snapshot().busy).toBe(false)
})


it('shows model reselection guidance for unavailable providers without retrying inference on another route', async () => {
  const f = fixture(), canvasId = 'model-canvas' as CanvasId
  const canvas: CanvasDocument = { id: canvasId, title: 'Notes', revision: 1, nodes: [
    { sessionId: id, parentId: null, forkSeq: null, title: 'Root', x: 0, y: 0, mode: 'chat', collapsed: false },
  ] }
  f.controller.source.set({ ...f.snapshot(), canvases: [canvas], activeId: canvasId, summaries: { [id]: initial } })
  f.remote.mindmap.mockResolvedValue({ ok: false, error: { code: 'canvas/model-unavailable', details: { provider: 'removed-provider', model: 'old-model' } } })
  f.controller.face.mindmap(canvasId, id, null, 'Selected text')
  await vi.waitFor(() => expect(f.snapshot().notice?.kind).toBe('modelUnavailable'))
  expect(f.snapshot().canvases).toEqual([canvas])
  expect(f.snapshot().summaries[id]).toEqual(initial)
  expect(f.remote.mindmap).toHaveBeenCalledOnce()
  expect(f.remote.updateNode).not.toHaveBeenCalled()
})

it('reports no useful subdivision without changing view, zoom or unsaved notes', async () => {
  const f = fixture(), canvasId = 'concise' as CanvasId
  const canvas: CanvasDocument = { id: canvasId, title: 'Concise', revision: 1, nodes: [] }
  f.remote.mindmap.mockResolvedValue({ ok: true, value: { canvas, createdSessionIds: [] } })
  f.controller.face.loadSummary(id)
  await vi.waitFor(() => expect(f.snapshot().summaries[id]).toBeDefined())
  f.controller.face.editSummary(id, 'Unsaved notes')
  f.controller.face.mindmap(canvasId, id, null, 'One clear point')
  await vi.waitFor(() => expect(f.snapshot().notice?.kind).toBe('mapUnchanged'))
  expect(f.snapshot().summaryOnly).toEqual([])
  expect(f.snapshot().fitRequest).toBeNull()
  expect(f.snapshot().drafts[id]?.markdown).toBe('Unsaved notes')
  expect(f.snapshot().busy).toBe(false)
})

it('distinguishes deletion preflight failures from partially completed deletions', async () => {
  const f = fixture(), canvasId = 'preflight' as CanvasId
  const canvas: CanvasDocument = { id: canvasId, title: 'Saved', revision: 1, nodes: [
    { sessionId: id, parentId: null, forkSeq: null, title: 'Root', x: 0, y: 0, collapsed: false, mode: 'summary' },
  ] }
  f.controller.source.set({ ...f.snapshot(), canvases: [canvas], activeId: canvasId })
  f.remote.list.mockResolvedValue({ ok: true, value: [canvas] })
  f.remote.removeNode.mockRejectedValue({ code: 'canvas/delete-not-started' })
  f.controller.face.removeNode(canvasId, id)
  await vi.waitFor(() => expect(f.snapshot().notice?.kind).toBe('deleteNotStarted'))
  expect(f.snapshot().canvases).toEqual([canvas])
})
