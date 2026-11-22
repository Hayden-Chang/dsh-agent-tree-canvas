/** Domain persistence, snapshot inheritance, and independent summary inference. */
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import SessionStore, { SessionId, SessionLogOffset, SessionSeq, pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SessionTitle from '@deepseek-ai/dsh-session-title'
import LlmRuntime, { LlmAdapter, createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import SessionCanvas from '../src/index.ts'
import { mindmapProjection, mindmapMessage, parseMindmap, parseMindmapReview } from '../src/mindmap.ts'
import { transcriptProjection } from '../src/projection.ts'

class Adapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  beforeReply: ((options: GenerateOptions) => Promise<void>) | undefined
  reply = '# Branch notes\n\nA useful conclusion.'
  reviewReply = '{"replacements":[],"append":[]}'
  finish: 'stop' | 'max-tokens' = 'stop'
  reviewFinish: 'stop' | 'max-tokens' = 'stop'
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    await this.beforeReply?.(options)
    options.signal?.throwIfAborted()
    const reviewing = options.purpose === 'session-canvas-mindmap-review'
    yield { type: 'text-delta', index: 0, text: reviewing ? this.reviewReply : this.reply }
    yield { type: 'finish', reason: { kind: reviewing ? this.reviewFinish : this.finish } }
  }
}

function turn(session: Session, number: number, input: string, answer: string): void {
  session.append('turn/start', { turn: number })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: input }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('step/start', { turn: number, step: 1 })
  session.append('assistant/message', { turn: number, step: 1, stream: [],
    message: createMessage({ role: 'assistant', content: [{ type: 'text', text: answer }], source: { kind: 'model', provider: 'fixture', model: 'fixture' } }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: number, step: 1 })
  session.append('turn/end', { turn: number, reason: { kind: 'completed' } })
}

async function fixture(root?: string) {
  const path = await realpath(root ?? await mkdtemp(join(tmpdir(), 'session-canvas-')))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); if (root === undefined) await rm(path, { recursive: true, force: true }) })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: path })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(LlmRuntime)
  const adapter = new Adapter()
  ctx.llm.registerAdapter(['fixture'], adapter)
  const route = { provider: 'fixture', model: 'fixture' }
  ctx.provide('agentDefaultModel', { currentSelection: () => route } as Context['agentDefaultModel'])
  ctx.provide('agentPresets', { register: async () => async () => {}, resolve: async (id: string) => ({ id }),
    presetForSession: (session: Session) => session.header.agentPreset } as never)
  const live = new Map<SessionId, AgentHandle>(), stored = new Map<SessionId, Session>()
  const file = (id: SessionId) => join(path, 'sessions', id, 'session.v4.jsonl')
  const created = vi.fn(async (options: CreateAgentOptions): Promise<AgentHandle> => {
    const session = ctx.sessions.prepare(options.sessionId, options)
    const detach = ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    await mkdir(join(path, 'sessions', session.id), { recursive: true })
    await writeFile(file(session.id), 'fixture log')
    stored.set(session.id, session)
    const agent = { id: session.id, session, model: { current: () => route } } as AgentHandle['agent']
    const handle = { agent, dispose: async () => { detach(); live.delete(session.id) } }
    live.set(session.id, handle)
    return handle
  })
  ctx.provide('agents', { get: (id: SessionId) => live.get(id)?.agent, create: created,
    resume: async (options: ResumeAgentOptions) => {
      const session = stored.get(options.resumeSessionId)!
      return created({ sessionId: session.id, seed: session.snapshotEvents(), inheritedEventCount: session.inheritedEventCount,
        meta: session.header })
    } } as never)
  ctx.provide('workspaceRegistry', { list: () => [], unpinSession: async () => {}, unarchiveSession: async () => {} } as never)
  ctx.provide('sessionPersistence', { stat: async (id: SessionId) => {
    try { await access(file(id)) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    return { header: stored.get(id)!.header, location: { kind: 'jsonl', path: file(id) } }
  }, open: async () => ({ close: async () => {} }) } as never)
  ctx.provide('sessionController', { resolveAgent: async (id: SessionId) => ({ agent: live.get(id)!.agent }) } as never)
  ctx.provide('sessionQuery', {
    searchSessions: async () => ({ items: [] }),
    observeSession: async (id: SessionId) => {
      const session = ctx.sessions.get(id) ?? stored.get(id)!
      return { header: session.header, events: session.snapshotEvents(), projections: ctx.sessionProjections.snapshot(session), [Symbol.dispose]() {} }
    },
  } as never)
  await ctx.plugin(SessionTitle, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 })
  const plugin = ctx.plugin(SessionCanvas, SessionCanvas.Config({}))
  await plugin
  return { ctx, api: ctx.sessionCanvas, adapter, path, plugin, created }
}

it('names a fork from its own first prompt, projects changes, and pins manual names across remounts', async () => {
  const { api, ctx, adapter, plugin } = await fixture()
  let canvas = await api.addRoot((await api.create('Names')).id, 'New conversation')
  const parent = ctx.sessions.get(canvas.nodes[0]!.sessionId)!
  ctx.sessionTitle.rename(parent, 'Parent manual name')
  turn(parent, 1, 'Parent topic', 'Parent response')
  canvas = await api.fork(canvas.id, parent.id, parent.seq - 1, 'Branch placeholder')
  const child = ctx.sessions.get(canvas.nodes[1]!.sessionId)!
  expect(ctx.sessionProjections.snapshot(child).values.sessionCanvas?.title).toBeUndefined()
  child.append('request/header', { header: { config: { provider: 'fixture', model: 'fixture' } }, reason: 'initial' })
  adapter.reply = '**Child topic**'
  turn(child, 2, 'Explain this child question', 'Child response')
  await vi.waitFor(() => { expect(ctx.sessionTitle.get(child)?.title).toBe('Child topic') })
  const request = adapter.requests.find(request => request.purpose === 'session-title')!
  expect(JSON.stringify(request.messages)).toContain('Explain this child question')
  expect(JSON.stringify(request.messages)).not.toContain('Parent topic')
  expect(ctx.sessionProjections.snapshot(child).values.sessionCanvas?.title).toBe('Child topic')
  ctx.sessionTitle.rename(child, 'My chosen name')
  turn(child, 3, 'Continue the topic', 'More detail')
  expect(adapter.requests.filter(request => request.purpose === 'session-title')).toHaveLength(1)
  await plugin.dispose()
  await ctx.plugin(SessionCanvas, SessionCanvas.Config({}))
  expect(ctx.sessionProjections.snapshot(ctx.sessions.get(child.id)!).values.sessionCanvas?.title).toBe('My chosen name')
})

it('keeps a manual name when automatic naming completes late', async () => {
  const { api, ctx, adapter } = await fixture()
  let canvas = await api.addRoot((await api.create('Names')).id, 'Parent')
  const parent = ctx.sessions.get(canvas.nodes[0]!.sessionId)!
  turn(parent, 1, 'Parent topic', 'Parent response')
  canvas = await api.fork(canvas.id, parent.id, parent.seq - 1, 'Child')
  const child = ctx.sessions.get(canvas.nodes[1]!.sessionId)!
  child.append('request/header', { header: { config: { provider: 'fixture', model: 'fixture' } }, reason: 'initial' })
  const delayed = Promise.withResolvers<void>()
  adapter.beforeReply = () => delayed.promise
  adapter.reply = 'Late generated name'
  turn(child, 2, 'Child topic', 'Child response')
  await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
  ctx.sessionTitle.rename(child, 'Manual wins')
  delayed.resolve()
  await vi.waitFor(() => { expect(adapter.requests[0]!.signal?.aborted).toBe(true) })
  expect(ctx.sessionProjections.snapshot(child).values.sessionCanvas?.title).toBe('Manual wins')
  expect(ctx.sessionTitle.get(child)?.source.kind).toBe('user')
})

it('persists exact excerpts and manual versions across plugin remounts', async () => {
  const { api, ctx, plugin, created } = await fixture()
  const canvas = await api.create('Research')
  const tree = await api.addRoot(canvas.id, 'A'), id = tree.nodes[0]!.sessionId
  expect(created).toHaveBeenCalledWith(expect.objectContaining({ meta: { cwd: process.cwd(), agentPreset: 'session-canvas' } }))
  const text = '  original **Markdown**\n\n```ts\nconst x = 1\n```\n'
  const added = await api.excerpt(id, text, 1)
  expect(added.markdown).toBe(text)
  await api.saveSummary({ sessionId: id, revision: added.revision, markdown: '# Handwritten\n' })
  await expect(api.saveSummary({ sessionId: id, revision: 0, markdown: 'stale' })).rejects.toMatchObject({ code: 'canvas/conflict' })
  await plugin.dispose()
  await ctx.plugin(SessionCanvas, SessionCanvas.Config({}))
  expect(ctx.sessionCanvas.list()[0]?.nodes[0]?.sessionId).toBe(id)
  const loaded = ctx.sessionCanvas.summary(id)
  expect(loaded.markdown).toBe('# Handwritten\n')
  expect(loaded.excerpts[0]?.text).toBe(text)
  expect(loaded.versions.at(-1)?.markdown).toBe(text)
  expect((await ctx.sessionCanvas.restore(id, loaded.revision, 1)).markdown).toBe(text)
})

it('forks a completed snapshot and keeps future parent messages and summaries out of the child', async () => {
  const { api, ctx, adapter } = await fixture()
  let canvas = await api.addRoot((await api.create('Tree')).id, 'A')
  const a = ctx.sessions.get(canvas.nodes[0]!.sessionId)!
  turn(a, 1, 'Parent question', 'Parent answer')
  const boundary = a.seq - 1
  await api.saveSummary({ sessionId: a.id, revision: 0, markdown: 'PRIVATE HUMAN NOTES' })
  canvas = await api.fork(canvas.id, a.id, boundary, 'B')
  const b = ctx.sessions.get(canvas.nodes[1]!.sessionId)!
  turn(a, 2, 'Later parent question', 'Later parent answer')
  turn(b, 2, 'Branch question', 'Branch answer')
  expect(api.summary(b.id).markdown).toBe('')
  const candidate = await api.generate(b.id, new AbortController().signal)
  expect(candidate.markdown).toBe('')
  expect(candidate.draft?.markdown).toContain('Branch notes')
  const input = adapter.requests[0]!.messages[0]!.content
  const text = JSON.stringify(input)
  expect(text).toContain('Parent question')
  expect(text).toContain('Branch question')
  expect(text).not.toContain('Later parent')
  expect(text).not.toContain('PRIVATE HUMAN NOTES')
  const transcript = ctx.sessionProjections.snapshot(b).values.sessionCanvas!
  expect(transcript.messages.filter(value => value.inherited).map(value => value.text)).toEqual(['Parent question', 'Parent answer'])
  expect(transcript.messages.filter(value => !value.inherited).map(value => value.text)).toEqual(['Branch question', 'Branch answer'])
  expect(b.snapshotEvents().at(-1)).toMatchObject({ type: 'plugin:session-canvas/summary-request', ignorable: true })
  expect(b.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(2)
  await expect(api.fork(canvas.id, a.id, 1, 'Invalid')).rejects.toMatchObject({ code: 'canvas/invalid' })
})

it('retains edits and excerpts made while a summary is generating', async () => {
  const { api, ctx, adapter } = await fixture()
  const canvas = await api.addRoot((await api.create('Concurrent')).id, 'A'), id = canvas.nodes[0]!.sessionId
  turn(ctx.sessions.get(id)!, 1, 'Question', 'Answer')
  const barrier = Promise.withResolvers<undefined>()
  adapter.beforeReply = () => barrier.promise
  const pending = api.generate(id, new AbortController().signal).then(
    value => ({ value }), (error: unknown) => ({ error }),
  )
  await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
  await expect(api.generate(id, new AbortController().signal)).rejects.toMatchObject({ code: 'canvas/busy' })
  await api.saveSummary({ sessionId: id, revision: 0, markdown: 'Manual note' })
  await api.excerpt(id, 'Exact excerpt', 1)
  barrier.resolve(undefined)
  const outcome = await pending
  if ('error' in outcome) throw outcome.error
  const candidate = outcome.value
  expect(candidate.markdown).toBe('Manual note\n\nExact excerpt')
  expect(candidate.draft?.baseRevision).toBe(0)
  const adopted = await api.resolveDraft(id, candidate.version, true)
  expect(adopted.versions.at(-1)?.markdown).toBe('Manual note\n\nExact excerpt')
  expect(adopted.draft).toBeNull()
})

it('records the captured conversation cut when chat advances during model preparation', async () => {
  const { api, ctx, adapter } = await fixture()
  const canvas = await api.addRoot((await api.create('Snapshot')).id, 'A')
  const id = canvas.nodes[0]!.sessionId, session = ctx.sessions.get(id)!
  turn(session, 1, 'Original question', 'Original answer')
  const throughSeq = session.seq - 1
  const prepared = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const original = ctx.llm.prepareCall.bind(ctx.llm)
  vi.spyOn(ctx.llm, 'prepareCall').mockImplementation(async (...args) => {
    prepared.resolve(undefined)
    await release.promise
    return original(...args)
  })
  const pending = api.generate(id, new AbortController().signal).then(
    value => ({ value }), (error: unknown) => ({ error }),
  )
  try {
    await prepared.promise
    turn(session, 2, 'Later question', 'Later answer')
  } finally { release.resolve(undefined) }
  const outcome = await pending
  if ('error' in outcome) throw outcome.error
  expect(outcome.value.draft?.throughSeq).toBe(throughSeq)
  expect(session.snapshotEvents().at(-1)).toMatchObject({ type: 'plugin:session-canvas/summary-request', data: { throughSeq } })
  expect(JSON.stringify(adapter.requests[0]?.messages)).not.toContain('Later question')
})

it('keeps saved text and the prior candidate when a response is truncated or cancelled', async () => {
  const { api, ctx, adapter } = await fixture()
  const canvas = await api.addRoot((await api.create('Failures')).id, 'A'), id = canvas.nodes[0]!.sessionId
  turn(ctx.sessions.get(id)!, 1, 'Question', 'Answer')
  await api.saveSummary({ sessionId: id, revision: 0, markdown: 'Keep me' })
  await api.generate(id, new AbortController().signal)
  const before = api.summary(id)
  adapter.finish = 'max-tokens'
  await expect(api.generate(id, new AbortController().signal)).rejects.toMatchObject({ code: 'canvas/summary-failed' })
  expect(api.summary(id)).toEqual(before)
  const controller = new AbortController(); controller.abort()
  await expect(api.generate(id, controller.signal)).rejects.toThrow()
  expect(api.summary(id)).toEqual(before)
})

it('drains cancelled inference before closing notes during plugin unload', async () => {
  const { api, ctx, adapter, plugin } = await fixture()
  const canvas = await api.addRoot((await api.create('Unload')).id, 'A'), id = canvas.nodes[0]!.sessionId
  turn(ctx.sessions.get(id)!, 1, 'Question', 'Answer')
  await api.saveSummary({ sessionId: id, revision: 0, markdown: 'Saved before unloading' })
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  adapter.beforeReply = async () => { entered.resolve(undefined); await release.promise }
  const pending = api.generate(id, new AbortController().signal).then(
    value => ({ value }), (error: unknown) => ({ error }),
  )
  await entered.promise
  let disposed = false
  const disposing = plugin.dispose().then(() => { disposed = true })
  try {
    await vi.waitFor(() => { expect(adapter.requests[0]?.signal?.aborted).toBe(true) })
    expect(disposed).toBe(false)
    expect(api.summary(id).markdown).toBe('Saved before unloading')
  } finally { release.resolve(undefined); await disposing }
  expect(await pending).toHaveProperty('error')
  await ctx.plugin(SessionCanvas, SessionCanvas.Config({}))
  expect(ctx.sessionCanvas.summary(id).markdown).toBe('Saved before unloading')
  expect(ctx.sessionCanvas.summary(id).draft).toBeNull()
})

it('switches every node without inference and allows a later per-node override', async () => {
  const { api, adapter } = await fixture()
  let canvas = await api.addRoot((await api.create('Modes')).id, 'A')
  canvas = await api.addRoot(canvas.id, 'B')
  canvas = await api.setMode(canvas.id, 'summary')
  expect(canvas.nodes.map(node => node.mode)).toEqual(['summary', 'summary'])
  canvas = await api.updateNode({ canvasId: canvas.id, sessionId: canvas.nodes[0]!.sessionId, mode: 'chat' })
  expect(canvas.nodes.map(node => node.mode)).toEqual(['chat', 'summary'])
  expect(adapter.requests).toHaveLength(0)
})

it('replays nested fork projections with only the latest branch messages marked as new', async () => {
  const ctx = new Context(); onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections)
  const handle = await ctx.sessionProjections.register(transcriptProjection)
  const a = ctx.sessions.create(SessionId('projection-a')); turn(a, 1, 'A', 'Answer A')
  const b = ctx.sessions.create(SessionId('projection-b'), { seed: buildForkSeed(a.snapshotEvents(), SessionSeq(a.seq - 1)), inheritedEventCount: a.seq, meta: { isSeeded: true } })
  turn(b, 2, 'B', 'Answer B')
  const c = ctx.sessions.create(SessionId('projection-c'), { seed: buildForkSeed(b.snapshotEvents(), SessionSeq(b.seq - 1)), inheritedEventCount: b.seq, meta: { isSeeded: true } })
  turn(c, 3, 'C', 'Answer C')
  expect(handle.stateOf(c).messages.filter(message => !message.inherited).map(message => message.text)).toEqual(['C', 'Answer C'])
  const state = handle.stateOf(c)
  c.append('session/end-seed', { inherited: true })
  expect(handle.stateOf(c)).toBe(state)
})


it('permanently deletes a subtree and its summaries while preserving unrelated nodes across remounts', async () => {
  const { api, ctx, plugin } = await fixture()
  let canvas = await api.addRoot((await api.create('Deletion')).id, 'Root')
  const root = canvas.nodes[0]!.sessionId
  turn(ctx.sessions.get(root)!, 1, 'Question', 'Answer')
  canvas = await api.fork(canvas.id, root, null, 'Child')
  const child = canvas.nodes.at(-1)!.sessionId
  canvas = await api.fork(canvas.id, child, null, 'Grandchild')
  const grandchild = canvas.nodes.at(-1)!.sessionId
  canvas = await api.fork(canvas.id, root, null, 'Sibling')
  const sibling = canvas.nodes.at(-1)!.sessionId
  canvas = await api.addRoot(canvas.id, 'Other root')
  const other = canvas.nodes.at(-1)!.sessionId
  for (const id of [root, child, grandchild, sibling, other]) await api.excerpt(id, `Note ${id}`, null)
  const histories = new Map(canvas.nodes.map(node => [node.sessionId, ctx.sessions.get(node.sessionId)!.snapshotEvents()]))
  const removed = await api.removeNode(canvas.id, child)
  expect(removed.nodes.map(node => node.sessionId)).toEqual([root, sibling, other])
  expect(removed.revision).toBe(canvas.revision + 1)
  await expect(api.removeNode(canvas.id, child)).rejects.toMatchObject({ code: 'canvas/deleting' })
  for (const id of [child, grandchild]) {
    expect(ctx.sessions.get(id)).toBeUndefined()
    expect(await ctx.sessionPersistence.stat(id)).toBeUndefined()
    expect(() => api.summary(id)).toThrow()
  }
  for (const id of [root, sibling, other]) expect(ctx.sessions.get(id)!.snapshotEvents()).toEqual(histories.get(id))
  await plugin.dispose(); await ctx.plugin(SessionCanvas, SessionCanvas.Config({}))
  expect(ctx.sessionCanvas.list()[0]!.nodes).toEqual(removed.nodes)
  expect((await ctx.sessionCanvas.removeNode(canvas.id, root)).nodes.map(node => node.sessionId)).toEqual([other])
  expect((await ctx.sessionCanvas.removeNode(canvas.id, other)).nodes).toEqual([])
  for (const [id, events] of histories) {
    expect(events).toBeDefined()
    expect(ctx.sessions.get(id)).toBeUndefined()
    expect(await ctx.sessionPersistence.stat(id)).toBeUndefined()
    expect(() => ctx.sessionCanvas.summary(id)).toThrow()
  }
})

it('starts an empty child for summary-only notes without copying human notes into history', async () => {
  const { api, ctx } = await fixture()
  const canvas = await api.addRoot((await api.create('Notes')).id, 'Blank')
  const parent = canvas.nodes[0]!.sessionId
  await api.excerpt(parent, 'Handwritten notes', null)
  const forked = await api.fork(canvas.id, parent, null, 'Quote child')
  const child = forked.nodes.at(-1)!
  expect(child).toMatchObject({ parentId: parent, forkSeq: null })
  expect(ctx.sessions.get(child.sessionId)!.snapshotEvents()).toEqual([])
  expect(api.summary(child.sessionId).markdown).toBe('')
  await expect(api.fork(canvas.id, parent, 0, 'Invalid')).rejects.toMatchObject({ code: 'canvas/invalid' })
})

it('does not restore a removed parent when child creation completes later', async () => {
  const { api, ctx, created } = await fixture()
  const canvas = await api.addRoot((await api.create('Concurrent deletion')).id, 'Parent')
  const parent = canvas.nodes[0]!.sessionId
  const release = Promise.withResolvers<void>(), started = Promise.withResolvers<void>()
  const create = created.getMockImplementation()!
  created.mockImplementationOnce(async options => { const child = await create(options); started.resolve(); await release.promise; return child })
  const pending = api.fork(canvas.id, parent, null, 'Child').catch((error: unknown) => error)
  await started.promise
  const deleting = api.removeNode(canvas.id, parent)
  release.resolve()
  await pending
  await deleting
  expect(api.list()[0]!.nodes).toEqual([])
  expect(ctx.sessions.get(parent)).toBeUndefined()
  for (const call of created.mock.calls) expect(await ctx.sessionPersistence.stat(call[0].sessionId)).toBeUndefined()
})

const outline = [{ depth: 0, text: '评测维度' }, { depth: 1, text: '**结果**' },
  { depth: 2, text: 'pass@k：至少一次成功' }, { depth: 2, text: 'pass^k：全部成功的稳定性' },
  { depth: 1, text: '过程：步数、工具调用次数' }]

it('creates a connected summary subtree from a frozen turn and retains focus after edits and replay', async () => {
  const { api, ctx, adapter, plugin } = await fixture()
  const initial = await api.addRoot((await api.create('Map')).id, '当前节点')
  const parent = ctx.sessions.get(initial.nodes[0]!.sessionId)!
  turn(parent, 1, 'Original question', 'Original answer')
  const cut = parent.seq - 1
  const selection = '结果：pass@k 至少一次成功；pass^k 全部成功的稳定性。过程：步数、工具调用次数。'
  adapter.reply = JSON.stringify({ nodes: outline })
  adapter.beforeReply = async options => { if (options.purpose === 'session-canvas-mindmap') turn(parent, 2, 'Later question', 'Later answer') }
  const { canvas: result } = await api.mindmap(initial.id, parent.id, cut, selection, new AbortController().signal)
  expect(result.nodes).toHaveLength(6)
  expect(result.nodes[0]).toEqual(initial.nodes[0])
  const nodes = result.nodes.slice(1)
  expect(nodes.map(node => node.parentId)).toEqual([parent.id, nodes[0]!.sessionId, nodes[1]!.sessionId, nodes[1]!.sessionId, nodes[0]!.sessionId])
  expect(nodes.map(node => api.summary(node.sessionId).markdown)).toEqual(outline.map(entry => entry.text))
  expect(nodes.every(node => node.mode === 'summary' && node.forkSeq === cut)).toBe(true)
  expect(JSON.stringify(adapter.requests[0]!.messages)).toContain(selection)
  expect(JSON.stringify(adapter.requests[0]!.messages)).not.toContain('Original question')
  const leaf = ctx.sessions.get(nodes[2]!.sessionId)!
  const focus = await ctx.sessionProjections.register(mindmapProjection)
  const saved = focus.stateOf(leaf)
  expect(saved.context).toEqual({ selection, path: ['当前节点', '评测维度', '**结果**', 'pass@k：至少一次成功'], content: 'pass@k：至少一次成功' })
  expect(ctx.sessionProjections.snapshot(leaf).values.sessionCanvas!.messages.map(value => value.text)).toEqual(['Original question', 'Original answer'])
  await api.saveSummary({ sessionId: leaf.id, revision: 1, markdown: 'MODIFIED NOTES' })
  const fresh = ctx.sessions.create(SessionId('replayed-map'), { seed: leaf.snapshotEvents(), inheritedEventCount: leaf.inheritedEventCount, meta: { isSeeded: true } })
  expect(focus.stateOf(fresh)).toEqual(saved)
  await plugin.dispose()
  await ctx.plugin(SessionCanvas, SessionCanvas.Config({}))
  const restored = await ctx.sessionProjections.register(mindmapProjection)
  expect(restored.stateOf(leaf)).toEqual(saved)
  const context = mindmapMessage(saved.context!)
  expect(JSON.stringify(context)).not.toContain('MODIFIED NOTES')
  const resumed = ctx.sessions.get(leaf.id)!
  resumed.append('user/message', context, { surfaceOp: 'append' })
  expect(restored.stateOf(resumed).delivered).toBe(true)
  // Forking before this node has its own completed turn must retain its generated focus.
  const forked = await ctx.sessionCanvas.fork(initial.id, nodes[1]!.sessionId, null, '继续分叉')
  const fork = ctx.sessions.get(forked.nodes.at(-1)!.sessionId)!
  expect(restored.stateOf(fork).context).toEqual(restored.stateOf(ctx.sessions.get(nodes[1]!.sessionId)!).context)
})

it('rejects malformed, oversized, disconnected, and truncated mind maps before publishing Sessions', async () => {
  const { api, ctx, adapter, created } = await fixture()
  const initial = await api.addRoot((await api.create('Map')).id, 'Root')
  const id = initial.nodes[0]!.sessionId
  const invalid = ['not json', JSON.stringify({ nodes: [{ depth: 1, text: 'wrong root' }] }),
    JSON.stringify({ nodes: [{ depth: 0, text: 'root' }, { depth: 2, text: 'skipped' }] }),
    JSON.stringify({ nodes: [{ depth: 0, text: 'x'.repeat(2001) }] })]
  for (const reply of invalid) {
    adapter.reply = reply
    await expect(api.mindmap(initial.id, id, null, 'source', new AbortController().signal)).rejects.toMatchObject({ code: 'canvas/mindmap-failed' })
  }
  adapter.reply = JSON.stringify({ nodes: outline }); adapter.finish = 'max-tokens'
  await expect(api.mindmap(initial.id, id, null, 'source', new AbortController().signal)).rejects.toMatchObject({ code: 'canvas/mindmap-failed' })
  expect(api.list()[0]).toEqual(initial)
  expect(created).toHaveBeenCalledTimes(1)
  expect(ctx.sessions.get(id)!.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(0)
  expect(() => parseMindmap(JSON.stringify({ nodes: outline }), { ...SessionCanvas.Config({}), maxMindmapNodes: 2 })).toThrow()
})

it('cancels inference and refuses late results when the parent was removed', async () => {
  const { api, adapter, created } = await fixture()
  const initial = await api.addRoot((await api.create('Map')).id, 'Root'), id = initial.nodes[0]!.sessionId
  const barrier = Promise.withResolvers<void>()
  adapter.reply = JSON.stringify({ nodes: outline }); adapter.beforeReply = () => barrier.promise
  const abort = new AbortController()
  const pending = api.mindmap(initial.id, id, null, 'source', abort.signal)
  const rejected = expect(pending).rejects.toThrow()
  await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))
  await expect(api.mindmap(initial.id, id, null, 'duplicate', new AbortController().signal)).rejects.toMatchObject({ code: 'canvas/busy' })
  abort.abort(); barrier.resolve(); await rejected
  expect(api.list()[0]).toEqual(initial)
  const waiting = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  adapter.beforeReply = async () => { waiting.resolve(); await release.promise }
  const mapping = api.mindmap(initial.id, id, null, 'source', new AbortController().signal)
  await waiting.promise
  const deleting = api.removeNode(initial.id, id)
  release.resolve()
  await mapping; await deleting
  expect(api.list()[0]!.nodes).toHaveLength(0)
  expect(created).toHaveBeenCalledTimes(outline.length + 1)
})

it('leaves no partial canvas subtree when a later Session creation fails', async () => {
  const { api, ctx, adapter, created } = await fixture()
  const initial = await api.addRoot((await api.create('Atomic map')).id, 'Root'), id = initial.nodes[0]!.sessionId
  adapter.reply = JSON.stringify({ nodes: outline })
  const create = created.getMockImplementation()!
  let unattached!: SessionId
  created.mockImplementationOnce(async options => { unattached = options.sessionId; return create(options) })
    .mockRejectedValueOnce(new Error('Session store unavailable'))
  await expect(api.mindmap(initial.id, id, null, 'source', new AbortController().signal)).rejects.toMatchObject({
    code: 'canvas/mindmap-failed',
  })
  expect(api.list()[0]).toEqual(initial)
  expect(api.summary(unattached).markdown).toBe('评测维度')
})


it('cancels an in-flight summary before erasing the Session and rejects subsequent writes', async () => {
  const { api, ctx, adapter } = await fixture()
  const canvas = await api.addRoot((await api.create('Cancel on deletion')).id, 'Root'), id = canvas.nodes[0]!.sessionId
  turn(ctx.sessions.get(id)!, 1, 'Secret question', 'Secret answer')
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  adapter.beforeReply = async () => { entered.resolve(); await release.promise }
  const generating = api.generate(id, new AbortController().signal)
  const rejected = expect(generating).rejects.toThrow()
  await entered.promise
  const deleting = api.removeNode(canvas.id, id)
  await vi.waitFor(() => expect(adapter.requests[0]!.signal?.aborted).toBe(true))
  release.resolve(); await rejected; await deleting
  expect(await ctx.sessionPersistence.stat(id)).toBeUndefined()
  await expect(api.saveSummary({ sessionId: id, revision: 0, markdown: 'Late private text' })).rejects.toMatchObject({ code: 'canvas/deleting' })
  await expect(api.excerpt(id, 'Late excerpt', 1)).rejects.toMatchObject({ code: 'canvas/deleting' })
})

it('resumes an interrupted deletion after plugin restart without restoring deleted histories', async () => {
  const { api, ctx, plugin } = await fixture()
  let canvas = await api.addRoot((await api.create('Recovery')).id, 'Root')
  const root = canvas.nodes[0]!.sessionId
  canvas = await api.fork(canvas.id, root, null, 'Child')
  const child = canvas.nodes[1]!.sessionId
  await api.excerpt(child, 'Child secret', null)
  const open = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
  vi.spyOn(ctx.sessionPersistence, 'open').mockImplementationOnce(open).mockRejectedValueOnce(new Error('Disk busy'))
  await expect(api.removeNode(canvas.id, root)).rejects.toMatchObject({ code: 'canvas/delete-failed' })
  expect(await ctx.sessionPersistence.stat(root)).toBeUndefined()
  expect(await ctx.sessionPersistence.stat(child)).toBeDefined()
  expect(api.list()[0]!.nodes).toHaveLength(2)
  await plugin.dispose()
  await ctx.plugin(SessionCanvas, SessionCanvas.Config({}))
  expect(ctx.sessionCanvas.list()[0]!.nodes).toEqual([])
  for (const id of [root, child]) {
    expect(await ctx.sessionPersistence.stat(id)).toBeUndefined()
    expect(() => ctx.sessionCanvas.summary(id)).toThrow()
  }
})

it('refuses an unowned Session before erasing any subtree data', async () => {
  const { api, ctx } = await fixture()
  const canvas = await api.addRoot((await api.create('Ownership')).id, 'Root'), id = canvas.nodes[0]!.sessionId
  const agent = ctx.agents.get(id)!
  vi.spyOn(ctx.agents, 'get').mockReturnValue({ ...agent })
  await expect(api.removeNode(canvas.id, id)).rejects.toMatchObject({ code: 'canvas/delete-unavailable' })
  expect(api.list()[0]).toEqual(canvas)
  expect(await ctx.sessionPersistence.stat(id)).toBeDefined()
  expect(api.summary(id).markdown).toBe('')
})


it('reports an unavailable recorded model without falling back or changing notes and succeeds after reselection', async () => {
  const { api, ctx, adapter } = await fixture()
  const canvas = await api.addRoot((await api.create('Missing provider')).id, 'Existing conversation'), id = canvas.nodes[0]!.sessionId
  turn(ctx.sessions.get(id)!, 1, 'Original question', 'Original answer')
  await api.saveSummary({ sessionId: id, revision: 0, markdown: 'Keep these notes' })
  const original = ctx.sessions.get(id)!.snapshotEvents(), summary = api.summary(id)
  const selection = vi.spyOn(ctx.agents.get(id)!.model, 'current').mockReturnValue({ provider: 'removed-provider', model: 'old-model' })
  for (const request of [() => api.mindmap(canvas.id, id, null, 'Original answer', new AbortController().signal),
    () => api.generate(id, new AbortController().signal)]) {
    await expect(request()).rejects.toMatchObject({ code: 'canvas/model-unavailable', details: { provider: 'removed-provider', model: 'old-model' } })
    expect(ctx.sessions.get(id)!.snapshotEvents()).toEqual(original)
    expect(api.summary(id)).toEqual(summary)
    expect(api.list()[0]).toEqual(canvas)
    expect(adapter.requests).toHaveLength(0)
  }
  selection.mockRestore()
  adapter.reply = JSON.stringify({ nodes: [{ depth: 0, text: 'Original answer' }] })
  expect((await api.mindmap(canvas.id, id, null, 'Original answer', new AbortController().signal)).canvas.nodes).toHaveLength(2)
  expect(api.summary(id)).toEqual(summary)
})

it('keeps the canvas and summary unchanged when the model finds no useful subdivision', async () => {
  const { api, ctx, adapter, created } = await fixture()
  const canvas = await api.addRoot((await api.create('Concise')).id, 'A complete thought')
  const id = canvas.nodes[0]!.sessionId
  const notes = await api.saveSummary({ sessionId: id, revision: 0, markdown: 'Keep my notes' })
  adapter.reply = '{"nodes":[]}'
  const result = await api.mindmap(canvas.id, id, null, 'A complete thought', new AbortController().signal)
  expect(result).toEqual({ canvas, createdSessionIds: [] })
  expect(api.summary(id)).toEqual(notes)
  expect(api.list()[0]).toEqual(canvas)
  expect(created).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('parentPath')
  expect(JSON.stringify(ctx.sessions.get(id)!.snapshotEvents())).toContain('mindmap-request')
})

it('attaches peer topics directly to the existing node without a synthetic root', async () => {
  const { api, adapter } = await fixture()
  const canvas = await api.addRoot((await api.create('Direct children')).id, 'Evaluation')
  const entries = [{ depth: 0, text: 'Result: completion' }, { depth: 0, text: 'Cost: tokens and latency' }]
  adapter.reply = JSON.stringify({ nodes: entries })
  const result = await api.mindmap(canvas.id, canvas.nodes[0]!.sessionId, null, 'Result and cost', new AbortController().signal)
  expect(result.createdSessionIds).toHaveLength(2)
  expect(result.canvas.nodes.slice(1).map(node => node.parentId)).toEqual([canvas.nodes[0]!.sessionId, canvas.nodes[0]!.sessionId])
})

it('reviews coarse leaves against the source before creating Sessions and preserves unrelated branches', async () => {
  const { api, ctx, adapter, created } = await fixture()
  const canvas = await api.addRoot((await api.create('Review')).id, 'Delivery')
  const parent = canvas.nodes[0]!.sessionId
  const draft = [{ depth: 0, text: 'Checks' }, { depth: 1, text: 'Temperature and density' }, { depth: 0, text: 'Keep this point exactly' }]
  const source = 'Checks require temperature and density. Keep this point exactly. Owner: Lin.'
  adapter.reply = JSON.stringify({ nodes: draft })
  adapter.reviewReply = JSON.stringify({ replacements: [{ index: 1, reason: 'The source names independent conditions.', nodes: [
    { depth: 0, text: 'Conditions' }, { depth: 1, text: 'Temperature' }, { depth: 1, text: 'Density' },
  ] }], append: [{ depth: 0, text: 'Owner: Lin' }] })
  adapter.beforeReply = async options => {
    if (options.purpose !== 'session-canvas-mindmap-review') return
    expect(created).toHaveBeenCalledTimes(1)
    const request = JSON.stringify(options.messages)
    expect(request).toContain(source)
    expect(request).toContain('Temperature and density')
    expect(request).toContain('parentPath')
  }
  const result = await api.mindmap(canvas.id, parent, null, source, new AbortController().signal)
  const nodes = result.canvas.nodes.slice(1)
  expect(nodes.map(node => api.summary(node.sessionId).markdown)).toEqual(['Checks', 'Conditions', 'Temperature', 'Density', 'Keep this point exactly', 'Owner: Lin'])
  expect(nodes.map(node => node.parentId)).toEqual([parent, nodes[0]!.sessionId, nodes[1]!.sessionId, nodes[1]!.sessionId, parent, parent])
  expect(adapter.requests.map(request => request.purpose)).toEqual(['session-canvas-mindmap', 'session-canvas-mindmap-review'])
  const events = JSON.stringify(ctx.sessions.get(parent)!.snapshotEvents())
  expect(events).toContain('mindmap-response')
  expect(events).toContain('The source names independent conditions.')
})

it('checks an empty draft and can recover source details without accepting empty output prematurely', async () => {
  const { api, adapter } = await fixture()
  const canvas = await api.addRoot((await api.create('Empty draft')).id, 'System')
  adapter.reply = '{"nodes":[]}'
  adapter.reviewReply = JSON.stringify({ replacements: [], append: [{ depth: 0, text: 'Authentication' }, { depth: 1, text: 'Expired token: 401' }, { depth: 1, text: 'Insufficient permission: 403' }] })
  const result = await api.mindmap(canvas.id, canvas.nodes[0]!.sessionId, null, 'Expired token: 401; insufficient permission: 403.', new AbortController().signal)
  expect(result.createdSessionIds).toHaveLength(3)
  expect(adapter.requests).toHaveLength(2)
})

it('rejects invalid or truncated reviews without publishing a valid draft', async () => {
  const { api, adapter, created } = await fixture()
  const canvas = await api.addRoot((await api.create('Failed review')).id, 'Root')
  adapter.reply = JSON.stringify({ nodes: outline })
  for (const reply of ['not json', '{"replacements":[{"index":99,"reason":"missing","nodes":[]}],"append":[]}']) {
    adapter.reviewReply = reply
    await expect(api.mindmap(canvas.id, canvas.nodes[0]!.sessionId, null, 'source', new AbortController().signal)).rejects.toMatchObject({ code: 'canvas/mindmap-failed', details: { sessionIds: [] } })
  }
  adapter.reviewReply = '{"replacements":[],"append":[]}'; adapter.reviewFinish = 'max-tokens'
  await expect(api.mindmap(canvas.id, canvas.nodes[0]!.sessionId, null, 'source', new AbortController().signal)).rejects.toMatchObject({ code: 'canvas/mindmap-failed' })
  expect(api.list()[0]).toEqual(canvas)
  expect(created).toHaveBeenCalledTimes(1)
})

it('cancels a pending source review before creating any generated Session', async () => {
  const { api, adapter, created } = await fixture()
  const canvas = await api.addRoot((await api.create('Cancel review')).id, 'Root')
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  adapter.reply = JSON.stringify({ nodes: outline })
  adapter.beforeReply = async options => { if (options.purpose === 'session-canvas-mindmap-review') { entered.resolve(); await release.promise } }
  const abort = new AbortController()
  const pending = api.mindmap(canvas.id, canvas.nodes[0]!.sessionId, null, 'source', abort.signal)
  const rejected = expect(pending).rejects.toThrow()
  await entered.promise
  abort.abort(); release.resolve(); await rejected
  expect(created).toHaveBeenCalledTimes(1)
  expect(api.list()[0]).toEqual(canvas)
})

it('retries malformed drafts and truncated reviews within their own attempt bounds before publication', async () => {
  const { api, adapter, created, ctx } = await fixture()
  const canvas = await api.addRoot((await api.create('Output retry')).id, 'Root')
  const attempts = { draft: 0, review: 0 }
  adapter.beforeReply = async options => {
    expect(created).toHaveBeenCalledTimes(1)
    expect(options.maxTokens).toBe(16384)
    if (options.purpose === 'session-canvas-mindmap') {
      adapter.reply = ++attempts.draft === 1 ? '{"nodes":[{"depth":0","text":"bad"}]}' : JSON.stringify({ nodes: outline })
    } else {
      adapter.reviewFinish = ++attempts.review === 1 ? 'max-tokens' : 'stop'
    }
  }
  const result = await api.mindmap(canvas.id, canvas.nodes[0]!.sessionId, null, 'Result and cost', new AbortController().signal)
  expect(result.createdSessionIds).toHaveLength(outline.length)
  expect(attempts).toEqual({ draft: 2, review: 2 })
  expect(adapter.requests[1]!.system).toContain('failed JSON or outline validation')
  expect(adapter.requests[3]!.system).toContain('exhausted its token budget')
  const responses = ctx.sessions.get(canvas.nodes[0]!.sessionId)!.snapshotEvents().filter(event => pluginRecordOf(event)?.type === 'plugin:session-canvas/mindmap-response')
  expect(responses).toHaveLength(4)
})

it('does not retry transport errors or exceed the configured output-attempt limit', async () => {
  const { api, adapter, created } = await fixture()
  const canvas = await api.addRoot((await api.create('Retry bound')).id, 'Root')
  adapter.reply = 'invalid JSON'
  await expect(api.mindmap(canvas.id, canvas.nodes[0]!.sessionId, null, 'Source', new AbortController().signal)).rejects.toMatchObject({ code: 'canvas/mindmap-failed' })
  expect(adapter.requests).toHaveLength(2)
  adapter.beforeReply = async () => { throw new Error('Transport unavailable') }
  await expect(api.mindmap(canvas.id, canvas.nodes[0]!.sessionId, null, 'Source', new AbortController().signal)).rejects.toMatchObject({ code: 'canvas/mindmap-failed' })
  expect(adapter.requests).toHaveLength(3)
  expect(created).toHaveBeenCalledTimes(1)
  expect(api.list()[0]).toEqual(canvas)
})

it('validates replacement ranges, relative depths, appended roots, duplicate topics and final combined limits', () => {
  const limits = SessionCanvas.Config({})
  const draft = [{ depth: 0, text: 'A' }, { depth: 1, text: 'B' }, { depth: 0, text: 'C' }]
  const replace = (index: number, nodes: typeof draft) => ({ index, nodes, reason: 'Source correction' })
  const check = (replacements: ReturnType<typeof replace>[], append: typeof draft = [], config = limits) => parseMindmapReview(JSON.stringify({ replacements, append }), draft, config, ['Root'])
  expect(() => check([replace(0, []), replace(1, [])])).toThrow('overlapping-review-edits')
  expect(() => check([replace(2, []), replace(2, [])])).toThrow('overlapping-review-edits')
  expect(() => check([replace(3, [])])).toThrow('invalid-review-index')
  expect(() => check([replace(1, [{ depth: 1, text: 'Wrong relative root' }])])).toThrow('invalid-outline-depth')
  expect(() => check([], [{ depth: 1, text: 'Wrong appended root' }])).toThrow('invalid-outline-depth')
  expect(() => check([], [{ depth: 0, text: 'Root' }])).toThrow('repeated-outline-topic')
  expect(() => check([], [{ depth: 0, text: 'A' }])).toThrow('repeated-outline-topic')
  expect(() => check([], [{ depth: 0, text: 'D' }], { ...limits, maxMindmapNodes: 3 })).toThrow()
  expect(() => check([replace(1, [{ depth: 0, text: 'B' }, { depth: 1, text: 'Detail' }])], [], { ...limits, maxMindmapDepth: 2 })).toThrow()
  expect(check([replace(0, [])])).toEqual([{ depth: 0, text: 'C' }])
  expect(check([])).toEqual(draft)
})

it('rejects immediate parent and sibling restatements while allowing a subject beneath a comparison', () => {
  const limits = SessionCanvas.Config({})
  for (const entries of [
    [{ depth: 0, text: '**Evaluation**' }],
    [{ depth: 0, text: 'Cost' }, { depth: 1, text: 'Cost!' }],
    [{ depth: 0, text: 'Cost' }, { depth: 0, text: '**cost**' }],
  ]) expect(() => parseMindmap(JSON.stringify({ nodes: entries }), limits, ['Evaluation'])).toThrow('repeated-outline-topic')
  const entries = [{ depth: 0, text: 'Retry only transient failures' }, { depth: 1, text: 'Stop after three attempts' }]
  expect(parseMindmap(JSON.stringify({ nodes: entries }), limits, ['Reliability'])).toEqual(entries)
  expect(parseMindmap('{"nodes":[]}', limits, ['Evaluation'])).toEqual([])
  const metrics = [{ depth: 0, text: 'pass@k' }, { depth: 0, text: 'pass^k' }, { depth: 0, text: 'a*b' }, { depth: 0, text: 'ab' }]
  expect(parseMindmap(JSON.stringify({ nodes: metrics }), limits)).toEqual(metrics)
  const comparison = [
    { depth: 0, text: '与核裂变的比较' }, { depth: 1, text: '核聚变' }, { depth: 2, text: '轻核合并' },
    { depth: 1, text: '核裂变' }, { depth: 2, text: '重核分裂' },
  ]
  expect(parseMindmap(JSON.stringify({ nodes: comparison }), limits, ['核聚变'])).toEqual(comparison)
})

it('deletes histories and notes when the optional full-text search service is disabled', async () => {
  const { api, ctx } = await fixture()
  let canvas = await api.addRoot((await api.create('Search disabled')).id, 'Root')
  const root = canvas.nodes[0]!.sessionId
  canvas = await api.fork(canvas.id, root, null, 'Child')
  for (const node of canvas.nodes) await api.excerpt(node.sessionId, 'Private notes', null)
  const search = vi.spyOn(ctx.sessionQuery, 'searchSessions').mockRejectedValue(
    new SessionQueryError('Search is off', 'SESSION_QUERY_SEARCH_DISABLED'))
  expect((await api.removeNode(canvas.id, root)).nodes).toEqual([])
  expect(search).toHaveBeenCalledTimes(2)
  for (const node of canvas.nodes) {
    expect(await ctx.sessionPersistence.stat(node.sessionId)).toBeUndefined()
    expect(() => api.summary(node.sessionId)).toThrow()
  }
})

it('reports a preflight failure without deleting data and permits a later retry', async () => {
  const { api, ctx } = await fixture()
  const canvas = await api.addRoot((await api.create('Index failure')).id, 'Root'), id = canvas.nodes[0]!.sessionId
  const summary = await api.excerpt(id, 'Preserve notes', null)
  const search = vi.spyOn(ctx.sessionQuery, 'searchSessions').mockRejectedValueOnce(
    new SessionQueryError('Index cannot open', 'SESSION_QUERY_INDEX_FAILED'))
  await expect(api.removeNode(canvas.id, id)).rejects.toMatchObject({ code: 'canvas/delete-not-started' })
  expect(api.list()[0]).toEqual(canvas)
  expect(await ctx.sessionPersistence.stat(id)).toBeDefined()
  expect(api.summary(id)).toEqual(summary)
  expect(ctx.storageDomain.get('session_canvas_deletions')!.table('jobs').get(canvas.id)).toBeUndefined()
  search.mockRestore()
  expect((await api.removeNode(canvas.id, id)).nodes).toEqual([])
})

it('retains a deletion job when enabled search reconciliation fails after removal', async () => {
  const { api, ctx } = await fixture()
  const canvas = await api.addRoot((await api.create('Reconcile failure')).id, 'Root'), id = canvas.nodes[0]!.sessionId
  await api.excerpt(id, 'Private notes', null)
  const original = ctx.sessionQuery.searchSessions.bind(ctx.sessionQuery)
  const search = vi.spyOn(ctx.sessionQuery, 'searchSessions').mockImplementationOnce(original).mockRejectedValueOnce(
    new SessionQueryError('Index cannot reconcile', 'SESSION_QUERY_INDEX_FAILED'))
  await expect(api.removeNode(canvas.id, id)).rejects.toMatchObject({ code: 'canvas/delete-failed' })
  expect(await ctx.sessionPersistence.stat(id)).toBeUndefined()
  expect(ctx.storageDomain.get('session_canvas_deletions')!.table('jobs').get(canvas.id)).toBeDefined()
  search.mockRestore()
  expect((await api.removeNode(canvas.id, id)).nodes).toEqual([])
  expect(() => api.summary(id)).toThrow()
})


it('retains a child quote origin across reloads without adding it to model history', async () => {
  const { api, ctx, plugin } = await fixture()
  const canvas = await api.addRoot((await api.create('Quote origins')).id, 'Parent')
  const parent = canvas.nodes[0]!.sessionId
  const origin = { text: 'Selected summary', source: { kind: 'summary' as const, sessionId: parent, offset: 19 } }
  const forked = await Reflect.apply(api.fork.bind(api), null, [canvas.id, parent, null, 'Child', origin])
  expect(forked.nodes.at(-1)).toMatchObject({ origin })
  const child = forked.nodes.at(-1)!.sessionId
  expect(ctx.sessions.get(child)!.snapshotEvents()).toEqual([])
  await plugin.dispose()
  await ctx.plugin(SessionCanvas, SessionCanvas.Config({}))
  expect(ctx.sessionCanvas.list()[0]!.nodes.at(-1)).toMatchObject({ sessionId: child, origin })
})

it('rejects a quote from a different parent before creating a child', async () => {
  const { api, created } = await fixture()
  const canvas = await api.addRoot((await api.create('Origins')).id, 'Parent')
  const count = created.mock.calls.length
  await expect(api.fork(canvas.id, canvas.nodes[0]!.sessionId, null, 'Child', {
    text: 'Wrong parent', source: { kind: 'summary', sessionId: SessionId('elsewhere'), offset: 0 },
  })).rejects.toMatchObject({ code: 'canvas/invalid' })
  expect(created).toHaveBeenCalledTimes(count)
  expect(api.list()[0]!.nodes).toHaveLength(1)
})
