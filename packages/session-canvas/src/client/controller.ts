/** Browser data owner: durable responses, retained editor drafts, and request lifetimes. */
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import { subtreeIds } from '../subtree.ts'
import type { DraftQuoteSource, QuoteSource } from './quote-reference.ts'
import { quoteReference, endOfDraft, QUOTE_SOURCE, readQuoteReference, removeQuote } from './quote-reference.ts'
import { decorateChat, selectedSource } from './chat-decoration.ts'
import { NS } from './locales.ts'
import css from './view.module.css'
import type {} from '@deepseek-ai/dsh-session-canvas/remote'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { CanvasDocument, CanvasId, CanvasMode, CanvasNode, CanvasTranscript, NodePlacement, QuoteOrigin, SummaryDocument, UpdateNodeRequest } from '../types.ts'
import { quoteRange, visibleSourceRow } from './quote-highlight.ts'
import { branchAppearance } from './appearance.ts'
import type { NodeAppearance } from './appearance.ts'
import { paintQuoteOrigins } from './quote-links.ts'
import type { ColoredQuote } from './quote-links.ts'
import type { DraftJournal, EditorDraft } from './draft-journal.ts'
import { createSummaryEditor } from './summary-editor.ts'
import type { SummaryEditorHandle } from './summary-editor.ts'

/** Unsaved human text survives mode switches and page remounts. */
export type { EditorDraft } from './draft-journal.ts'
/** Following a child scrolls its parent while retaining the child's viewport and focus. */
interface QuoteNavigation { readonly follow?: boolean; readonly tone?: NodeAppearance['tone'] }
/** Published application state; every change is delivered through the framework hook. */
export interface CanvasState {
  readonly canvases: readonly CanvasDocument[]
  readonly activeId: CanvasId | null
  readonly loading: boolean
  readonly failed: boolean
  readonly busy: boolean
  readonly summaries: Readonly<Record<string, SummaryDocument>>
  readonly drafts: Readonly<Record<string, EditorDraft>>
  readonly saveStates: Readonly<Record<string, 'pending' | 'saving' | 'failed' | 'conflict'>>
  readonly summaryOnly: readonly CanvasId[]
  readonly generating: readonly SessionId[]
  readonly mapping: CanvasId | null
  readonly fitRequest: { readonly canvasId: CanvasId; readonly request: number } | null
  readonly viewportTarget: { readonly sessionId: SessionId; readonly request: number } | null
  readonly sourceTarget: QuoteNavigation & ({
    readonly sessionId: SessionId
    readonly turn: number
    readonly quote?: { readonly seq: number; readonly text: string; readonly offset: number }
  } | { readonly kind: 'summary'; readonly sessionId: SessionId; readonly quote: { readonly text: string; readonly offset: number } }) | null
  readonly notice: { readonly id: number; readonly kind: 'failed' | 'conflict' | 'saved' | 'added' | 'removed' | 'mapped' | 'mapUnchanged' | 'mapFailed' | 'deleteFailed' | 'deleteNotStarted' | 'deleteUnavailable' | 'modelUnavailable'; readonly sessionId?: SessionId } | null
}
/** Injected actions and bare reactive source; components receive a bound useCanvas hook. */
export interface CanvasFace {
  readonly hooks: { readonly canvas: HostObservable<CanvasState> }
  readonly reload: () => void
  readonly selectCanvas: (id: CanvasId) => void
  readonly createCanvas: (title: string) => void
  readonly renameCanvas: (id: CanvasId, title: string) => void
  readonly addRoot: (id: CanvasId, title: string) => void
  readonly fork: (id: CanvasId, sessionId: SessionId, seq: number | null, title: string) => void
  readonly quoteChild: (id: CanvasId, sessionId: SessionId, seq: number | null, title: string, text: string, source?: QuoteSource) => void
  readonly mindmap: (id: CanvasId, sessionId: SessionId, seq: number | null, text: string) => void
  readonly cancelMindmap: () => void
  readonly selectedSource: (id: SessionId) => DraftQuoteSource | undefined
  readonly insertQuote: (id: SessionId, text: string, source?: QuoteSource) => boolean
  readonly removeNode: (id: CanvasId, sessionId: SessionId) => void
  readonly quoteSummary: (id: CanvasId, sessionId: SessionId, text: string, offset: number) => void
  readonly openQuote: (source: QuoteSource, text: string, navigation?: QuoteNavigation) => void
  readonly followParent: (id: SessionId) => void
  readonly updateNode: (request: UpdateNodeRequest) => void
  readonly arrange: (id: CanvasId, nodes: readonly NodePlacement[]) => void
  readonly setMode: (id: CanvasId, mode: CanvasMode) => void
  readonly loadSummary: (id: SessionId) => void
  readonly editSummary: (id: SessionId, markdown: string) => void
  readonly discardEdits: (id: SessionId) => void
  readonly saveSummary: (id: SessionId) => void
  readonly generate: (id: SessionId) => void
  readonly cancelGeneration: (id: SessionId) => void
  readonly resolveDraft: (id: SessionId, adopt: boolean) => void
  readonly restore: (id: SessionId, revision: number) => void
  readonly excerpt: (id: SessionId, text: string, turn: number | null) => void
  readonly showSummary: (id: SessionId) => void
  readonly revealSource: (id: SessionId, turn: number | null, seq: number,
    quote?: { readonly seq: number; readonly text: string; readonly offset: number }, navigation?: QuoteNavigation) => void
  readonly registerSourceRoot: (id: SessionId, element: HTMLElement | null) => void
  readonly dismissNotice: () => void
  readonly editorFailed: (id: SessionId) => void
}

/** Owns requests independently of a particular canvas or card mount. */
export class CanvasController {
  /** Readable canvas state, including unsaved notes and pending model requests. */
  readonly source = createSnapshotStore<CanvasState>({
    canvases: [], activeId: null, loading: false, failed: false, busy: false,
    summaries: {}, drafts: {}, saveStates: {}, summaryOnly: [], generating: [], mapping: null, fitRequest: null, sourceTarget: null, viewportTarget: null, notice: null,
  })
  private readonly lifetime = new AbortController()
  private readonly tasks = new Set<Promise<void>>()
  private readonly generations = new Map<SessionId, AbortController>()
  private mapping: AbortController | null = null
  private readonly deleting = new Set<SessionId>()
  private readonly deleted = new Set<SessionId>()
  private readonly reads = new Set<SessionId>()
  private readonly pendingQuotes = new Map<SessionId, { readonly text: string; readonly source?: QuoteSource }>()
  private sourceMarker: HTMLElement | null = null
  private focusChild: SessionId | null = null
  private readonly sourceRoots = new Map<SessionId, { element: HTMLElement; dispose: () => void }>()
  private noticeId = 0
  private viewportRequest = 0
  private sourceRequest = 0
  private writes = 0
  private readonly saveTimers = new Map<SessionId, ReturnType<typeof setTimeout>>()
  private readonly saves = new Map<SessionId, Promise<void>>()
  private readonly noteWrites = new Map<SessionId, Promise<void>>()
  private readonly recovered = new Set<SessionId>()
  private readonly editors = new Map<SessionId, Set<SummaryEditorHandle>>()

  constructor(private readonly ctx: Context, private readonly openPanel: () => void,
    private readonly autosaveDelayMs: number, private readonly journal?: DraftJournal) {}

  private keepDraft(id: SessionId, draft: EditorDraft | undefined): void {
    if (this.lifetime.signal.aborted || this.deleted.has(id)) return
    const drafts = { ...this.source.getSnapshot().drafts }
    if (draft === undefined) Reflect.deleteProperty(drafts, id)
    else drafts[id] = draft
    this.patch({ drafts })
    const markdown = draft?.markdown ?? this.source.getSnapshot().summaries[id]?.markdown
    if (markdown !== undefined) for (const editor of this.editors.get(id) ?? []) editor.update(markdown)
    try { this.journal?.write(id, draft) }
    catch (error) { this.notice('failed', id); this.ctx.logger.warn('Could not retain summary recovery draft', error) }
  }

  private saveState(id: SessionId, status?: CanvasState['saveStates'][string]): void {
    const saveStates = { ...this.source.getSnapshot().saveStates }
    if (status === undefined) Reflect.deleteProperty(saveStates, id)
    else saveStates[id] = status
    this.patch({ saveStates })
  }

  private scheduleSave(id: SessionId): void {
    clearTimeout(this.saveTimers.get(id))
    if (this.lifetime.signal.aborted) return
    if (this.deleting.has(id) || this.deleted.has(id) || this.source.getSnapshot().saveStates[id] === 'conflict') return
    this.saveState(id, 'pending')
    this.saveTimers.set(id, setTimeout(() => { this.saveTimers.delete(id); this.face.saveSummary(id) }, this.autosaveDelayMs))
  }

  private save(id: SessionId): Promise<void> {
    if (this.deleting.has(id) || this.deleted.has(id)) return Promise.resolve()
    const active = this.saves.get(id)
    if (active !== undefined) return active
    clearTimeout(this.saveTimers.get(id)); this.saveTimers.delete(id)
    if (this.lifetime.signal.aborted) return Promise.resolve()
    const task = this.queueNote(id, async () => {
      const draft = this.source.getSnapshot().drafts[id]
      if (draft === undefined || this.lifetime.signal.aborted) return
      this.saveState(id, 'saving')
      const saved = await this.value(this.ctx.remote.sessionCanvas.saveSummary({ sessionId: id, ...draft }))
      this.lifetime.signal.throwIfAborted()
      this.receiveSummary(saved)
      const current = this.source.getSnapshot().drafts[id]
      this.saveState(id)
      if (current === draft) this.keepDraft(id, undefined)
      else if (current !== undefined && current.revision === draft.revision) {
        this.keepDraft(id, { ...current, revision: saved.revision })
        this.scheduleSave(id)
      }
    }).catch((error: unknown) => {
      if (this.lifetime.signal.aborted) return
      const conflict = typeof error === 'object' && error !== null && 'code' in error && error.code === 'canvas/conflict'
      const status = conflict ? 'conflict' : 'failed'
      this.saveState(id, status); this.notice(status, id)
    }).finally(() => { this.saves.delete(id) })
    this.saves.set(id, task)
    return task
  }

  private queueNote(id: SessionId, work: () => Promise<void>): Promise<void> {
    const previous = this.noteWrites.get(id) ?? Promise.resolve()
    const execute = async (): Promise<void> => { if (!this.lifetime.signal.aborted && !this.deleting.has(id) && !this.deleted.has(id)) await work() }
    const task = previous.then(execute, execute).finally(() => {
      if (this.noteWrites.get(id) === task) this.noteWrites.delete(id)
    })
    this.noteWrites.set(id, task)
    return task
  }

  private patch(value: Partial<CanvasState>): void {
    if (!this.lifetime.signal.aborted) this.source.set({ ...this.source.getSnapshot(), ...value })
  }

  private notice(kind: NonNullable<CanvasState['notice']>['kind'], sessionId?: SessionId): void {
    this.patch({ notice: { id: ++this.noticeId, kind, ...sessionId === undefined ? {} : { sessionId } } })
  }

  private async value<T>(request: Promise<RemoteResult<T>>): Promise<T> {
    const result = await request
    if (!result.ok) throw result.error
    return result.value
  }

  private run(work: () => Promise<void>, write = false): void {
    if (this.lifetime.signal.aborted) return
    if (write) { this.writes++; this.patch({ busy: true }) }
    const task = work().catch((error: unknown) => {
      if (this.lifetime.signal.aborted) return
      const conflict = typeof error === 'object' && error !== null && 'code' in error && error.code === 'canvas/conflict'
      const unavailable = typeof error === 'object' && error !== null && 'code' in error && error.code === 'canvas/model-unavailable'
      this.notice(conflict ? 'conflict' : unavailable ? 'modelUnavailable' : 'failed')
    }).finally(() => {
      this.tasks.delete(task)
      if (write) { this.writes--; this.patch({ busy: this.writes > 0 }) }
    })
    this.tasks.add(task)
  }

  private receiveCanvas(value: CanvasDocument): void {
    const state = this.source.getSnapshot()
    const current = state.canvases.find(canvas => canvas.id === value.id)
    if (current !== undefined && current.revision > value.revision) return
    this.patch({
      canvases: current === undefined ? [...state.canvases, value] : state.canvases.map(canvas => canvas.id === value.id ? value : canvas),
      activeId: state.activeId ?? value.id,
    })
    this.paintQuotes()
  }

  private nodeOrigin(node: CanvasNode): QuoteOrigin | undefined {
    if (node.origin !== undefined) return node.origin
    // Recover source-bearing drafts created before origins were stored on nodes.
    const binding = this.ctx.sessions?.binding(node.sessionId)
    if (binding === undefined || node.parentId === null) return
    for (const item of this.ctx.conversation.input.for(binding.ctx).state.getSnapshot().occurrences) {
      if (item.source !== QUOTE_SOURCE) continue
      try {
        const quote = readQuoteReference(item.ref)
        if (quote.source?.sessionId === node.parentId) return { text: quote.text, source: quote.source }
      } catch { /* A malformed legacy reference must not break other nodes. */ }
    }
  }

  private paintQuotes(): void {
    const quotes: ColoredQuote[] = []
    for (const canvas of this.source.getSnapshot().canvases) {
      const appearances = branchAppearance(canvas.nodes)
      for (const node of canvas.nodes) {
        const origin = this.nodeOrigin(node)
        if (origin !== undefined) quotes.push({ ...origin, tone: appearances.get(node.sessionId)?.tone ?? 'root' })
      }
    }
    paintQuoteOrigins(quotes, new Map([...this.sourceRoots].map(([id, root]) => [id, root.element])))
  }

  private receiveSummary(value: SummaryDocument): void {
    if (this.deleted.has(value.sessionId)) return
    const state = this.source.getSnapshot()
    if ((state.summaries[value.sessionId]?.version ?? -1) > value.version) return
    this.patch({ summaries: { ...state.summaries, [value.sessionId]: value } })
    if (state.drafts[value.sessionId] === undefined) {
      for (const editor of this.editors.get(value.sessionId) ?? []) editor.update(value.markdown)
    }
  }

  /**
   * Attach rich editing to one rendered summary, with drafts owned by this controller.
   * @param id - owning Session.
   * @param element - labeled editor host.
   * @returns teardown that also starts saving the latest draft.
   */
  mountEditor(id: SessionId, element: HTMLElement): () => Promise<void> {
    const state = this.source.getSnapshot()
    const editor = createSummaryEditor(element, state.drafts[id]?.markdown ?? state.summaries[id]?.markdown ?? '',
      (value) => { this.face.editSummary(id, value) }, (error) => {
        this.ctx.logger.warn('Could not edit Markdown summary', error); this.face.editorFailed(id)
      })
    const editors = this.editors.get(id) ?? new Set<SummaryEditorHandle>()
    editors.add(editor); this.editors.set(id, editors)
    return async () => {
      editors.delete(editor)
      if (editors.size === 0) this.editors.delete(id)
      this.face.saveSummary(id)
      await editor.dispose()
    }
  }

  private landSource(): void {
    if (this.focusChild !== null) {
      const input = this.sourceRoots.get(this.focusChild)?.element.querySelector<HTMLElement>('[data-composer-input]')
      if (input !== undefined && input !== null && input.closest('[hidden]') === null) {
        const sessionId = this.focusChild
        this.focusChild = null
        input.focus({ preventScroll: true })
        this.patch({ viewportTarget: { sessionId, request: ++this.viewportRequest } })
      }
    }
    const target = this.source.getSnapshot().sourceTarget
    if (target === null) return
    const row = visibleSourceRow(this.sourceRoots.get(target.sessionId)?.element, 'kind' in target ? '[data-summary-document]' : target.quote === undefined
      ? `[data-chat-turn="${target.turn}"]` : `[data-chat-seq="${target.quote.seq}"]`, target.quote)
    if (row === undefined || row === null || row.closest('[hidden]') !== null) return
    let destination = row.getBoundingClientRect()
    this.sourceMarker?.removeAttribute('data-canvas-quote-source')
    this.sourceMarker?.style.removeProperty('--canvas-quote-color')
    if (typeof CSS !== 'undefined' && 'highlights' in CSS) CSS.highlights.delete('session-canvas-quote')
    if (target.quote !== undefined) {
      row.setAttribute('data-canvas-quote-source', '')
      row.style.setProperty('--canvas-quote-color', target.tone === undefined
        ? 'var(--dsw-alias-state-business-primary)' : `var(--dsw-alias-diagram-${target.tone})`)
      this.sourceMarker = row
      const message = row.querySelector<HTMLElement>('[data-text-interaction-source]') ?? row
      const range = quoteRange(message, target.quote.text, target.quote.offset)
      if (range !== undefined) {
        destination = range.getBoundingClientRect()
        if (typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined') CSS.highlights.set('session-canvas-quote', new Highlight(range))
      }
      if (!target.follow) { row.tabIndex = -1; row.focus({ preventScroll: true }) }
    }
    const scroll = row.closest<HTMLElement>('[data-chat-scroll], [data-canvas-summary]')
    if (scroll !== null) {
      const bounds = scroll.getBoundingClientRect(), scale = bounds.height / scroll.offsetHeight
      if (scale > 0) scroll.scrollTop += (destination.top - bounds.top - (bounds.height - destination.height) / 2) / scale
    }
    this.patch({ sourceTarget: null, ...target.follow ? {} : { viewportTarget: { sessionId: target.sessionId, request: ++this.viewportRequest } } })
  }

  /**
   * Insert a queued quote after the child has opened and while its card retains the Session.
   * @param binding - current retained child generation.
   */
  prepareChat(binding: SessionBinding): void {
    if (this.lifetime.signal.aborted) return
    const quote = this.pendingQuotes.get(binding.sessionId)
    if (quote === undefined) return
    if (!this.face.insertQuote(binding.sessionId, quote.text, quote.source)) throw new Error('Child conversation could not accept the quote')
    this.pendingQuotes.delete(binding.sessionId)
    this.focusChild = binding.sessionId
  }

  /**
   * Resolve a saved message or summary address, or an unambiguous message for an older quote.
   * @param sessionId - quote's owning node.
   * @param text - selected original text.
   * @param source - saved source, absent in older drafts.
   * @returns a canvas source address; ambiguous older excerpts remain non-navigating.
   */
  quoteSource(sessionId: SessionId, text: string, source?: QuoteSource): QuoteSource | undefined {
    const canvas = this.source.getSnapshot().canvases.find(value => value.nodes.some(node => node.sessionId === sessionId))
    if (canvas === undefined) return
    if (source !== undefined) return canvas.nodes.some(node => node.sessionId === source.sessionId) ? source : undefined
    const transcript = this.ctx.sessions.binding(sessionId)?.session.projections.faceOf('sessionCanvas').getSnapshot() as CanvasTranscript | undefined
    const matches = transcript?.messages.filter(message => message.text.includes(text)) ?? []
    if (matches.length !== 1 || transcript === undefined) return
    const message = matches[0]
    if (message === undefined) return
    const turn = transcript.turns.find(turn => turn.seq > message.seq)
    if (turn === undefined) return
    return { sessionId, seq: message.seq, turn: turn.turn, offset: 0 }
  }

  /** Open a reference with its owning node's color, including legacy input drafts. */
  openReference(sessionId: SessionId, text: string, source?: QuoteSource): boolean {
    const target = this.quoteSource(sessionId, text, source)
    if (target === undefined) return false
    const canvas = this.source.getSnapshot().canvases.find(value => value.nodes.some(node => node.sessionId === sessionId))
    this.face.openQuote(target, text, { tone: branchAppearance(canvas?.nodes ?? []).get(sessionId)?.tone })
    return true
  }

  /** Refresh data after startup or reconnect without removing editor drafts. */
  reload(): void {
    if (this.source.getSnapshot().loading) return
    this.patch({ loading: true, failed: false })
    this.run(async () => {
      try {
        const canvases = await this.value(this.ctx.remote.sessionCanvas.list())
        for (const canvas of canvases) this.receiveCanvas(canvas)
        for (const id of Object.keys(this.source.getSnapshot().summaries)) this.face.loadSummary(id as SessionId)
      } catch (error) { this.patch({ failed: true }); throw error }
      finally { this.patch({ loading: false }) }
    })
  }

  /** Narrow callback face passed into Slot registrations. */
  readonly face: CanvasFace = {
    hooks: { canvas: this.source },
    reload: () => { this.reload() },
    selectCanvas: (id) => { this.patch({ activeId: id }) },
    createCanvas: (title) => { this.run(async () => {
      const value = await this.value(this.ctx.remote.sessionCanvas.create(title))
      this.receiveCanvas(value); this.patch({ activeId: value.id })
    }, true) },
    renameCanvas: (id, title) => {
      this.run(async () => { this.receiveCanvas(await this.value(this.ctx.remote.sessionCanvas.rename(id, title))) }, true)
    },
    addRoot: (id, title) => {
      this.run(async () => { this.receiveCanvas(await this.value(this.ctx.remote.sessionCanvas.addRoot(id, title))) }, true)
    },
    fork: (id, sessionId, seq, title) => {
      this.run(async () => {
        const canvas = await this.value(this.ctx.remote.sessionCanvas.fork(id, sessionId, seq, title))
        if (this.lifetime.signal.aborted) return
        const child = canvas.nodes.at(-1)
        if (child === undefined) throw new Error('Fork returned no child conversation')
        this.focusChild = child.sessionId
        this.receiveCanvas(canvas)
        this.patch({ activeId: id, sourceTarget: null,
          summaryOnly: this.source.getSnapshot().summaryOnly.filter(value => value !== id) })
        this.openPanel()
      }, true)
    },
    quoteChild: (id, sessionId, seq, title, text, source) => { this.run(async () => {
      const canvas = await this.value(this.ctx.remote.sessionCanvas.fork(id, sessionId, seq, title,
        source === undefined ? undefined : { text, source }))
      if (this.lifetime.signal.aborted) return
      // The fork transaction appends its new child to the returned canvas.
      const child = canvas.nodes.at(-1)
      if (child === undefined) throw new Error('Fork returned no child conversation')
      this.pendingQuotes.set(child.sessionId, { text, ...source === undefined ? {} : { source } })
      this.receiveCanvas(canvas)
      this.patch({ activeId: id, summaryOnly: this.source.getSnapshot().summaryOnly.filter(value => value !== id) })
      this.openPanel()
    }, true) },
    mindmap: (id, sessionId, seq, text) => {
      if (this.mapping !== null) return
      const cancellation = this.mapping = new AbortController()
      this.patch({ mapping: id })
      this.run(async () => {
        try {
          const result = await this.value(this.ctx.remote.sessionCanvas.mindmap(id, sessionId, seq, text,
            AbortSignal.any([cancellation.signal, this.lifetime.signal])))
          const { canvas, createdSessionIds } = result
          this.receiveCanvas(canvas)
          if (createdSessionIds.length === 0) { this.notice('mapUnchanged'); return }
          this.patch({ activeId: id, viewportTarget: null, sourceTarget: null,
            summaryOnly: [...this.source.getSnapshot().summaryOnly.filter(value => value !== id), id],
            fitRequest: { canvasId: id, request: ++this.viewportRequest } })
          this.openPanel(); this.notice('mapped')
        } catch (error) {
          if (!this.lifetime.signal.aborted) {
            if (!cancellation.signal.aborted) {
              const unavailable = typeof error === 'object' && error !== null && 'code' in error && error.code === 'canvas/model-unavailable'
              this.notice(unavailable ? 'modelUnavailable' : 'mapFailed', sessionId)
            }
            // Reconcile a reply lost after the Host's atomic commit.
            this.reload()
          }
        } finally { this.mapping = null; this.patch({ mapping: null }) }
      }, true)
    },
    cancelMindmap: () => { this.mapping?.abort() },
    selectedSource,
    insertQuote: (id, text, source) => {
      const binding = this.ctx.sessions.binding(id)
      if (binding === undefined) return false
      const input = this.ctx.conversation.input.for(binding.ctx)
      return input.insertReference(quoteReference(text, source), endOfDraft(input))
    },
    removeNode: (id, sessionId) => { this.run(async () => {
      const canvas = this.source.getSnapshot().canvases.find(value => value.id === id)
      if (canvas === undefined) return
      const removed = new Set(subtreeIds(canvas.nodes, sessionId))
      for (const target of removed) {
        this.deleting.add(target)
        clearTimeout(this.saveTimers.get(target)); this.saveTimers.delete(target)
        this.generations.get(target)?.abort()
      }
      try {
        await Promise.allSettled([...removed].flatMap(target => this.noteWrites.has(target) ? [this.noteWrites.get(target)!] : []))
        const result = await this.value(this.ctx.remote.sessionCanvas.removeNode(id, sessionId))
        for (const node of canvas.nodes) if (!result.nodes.some(value => value.sessionId === node.sessionId)) removed.add(node.sessionId)
        this.receiveCanvas(result)
        const state = this.source.getSnapshot(), summaries = { ...state.summaries }, drafts = { ...state.drafts }, saveStates = { ...state.saveStates }
        for (const target of removed) {
          this.deleted.add(target)
          this.pendingQuotes.delete(target); this.recovered.delete(target)
          for (const editor of this.editors.get(target) ?? []) await editor.dispose()
          this.editors.delete(target)
          const binding = this.ctx.sessions.binding(target)
          if (binding !== undefined) this.ctx.conversation.input.for(binding.ctx).setDraft('')
          this.journal?.write(target, undefined)
          if (typeof localStorage !== 'undefined') {
            for (const key of [`dsh.conversation.${target}`, `session-canvas.legacy-draft.${target}`, `dsh-session-canvas-draft:${target}`]) localStorage.removeItem(key)
          }
          Reflect.deleteProperty(summaries, target); Reflect.deleteProperty(drafts, target); Reflect.deleteProperty(saveStates, target)
        }
        if (this.focusChild !== null && removed.has(this.focusChild)) this.focusChild = null
        this.patch({ summaries, drafts, saveStates, sourceTarget: null, viewportTarget: null })
        this.notice('removed')
      } catch (error) {
        const unavailable = typeof error === 'object' && error !== null && 'code' in error && error.code === 'canvas/delete-unavailable'
        const notStarted = typeof error === 'object' && error !== null && 'code' in error && error.code === 'canvas/delete-not-started'
        this.notice(unavailable ? 'deleteUnavailable' : notStarted ? 'deleteNotStarted' : 'deleteFailed')
        this.reload()
      } finally { for (const target of removed) this.deleting.delete(target) }
    }, true) },
    quoteSummary: (id, sessionId, text, offset) => { this.run(async () => {
      const canvas = await this.value(this.ctx.remote.sessionCanvas.updateNode({ canvasId: id, sessionId, mode: 'chat', collapsed: false }))
      if (this.lifetime.signal.aborted) return
      if (!this.face.insertQuote(sessionId, text, { kind: 'summary', sessionId, offset })) throw new Error('Conversation could not accept the quote')
      this.focusChild = sessionId
      this.receiveCanvas(canvas)
      this.patch({ activeId: id, sourceTarget: null,
        summaryOnly: this.source.getSnapshot().summaryOnly.filter(value => value !== id) })
      this.openPanel(); this.landSource()
    }, true) },
    followParent: (id) => {
      const canvas = this.source.getSnapshot().canvases.find(value => value.nodes.some(node => node.sessionId === id))
      const node = canvas?.nodes.find(value => value.sessionId === id)
      if (canvas === undefined || node?.parentId == null) return
      const tone = branchAppearance(canvas.nodes).get(id)?.tone
      const origin = this.nodeOrigin(node)
      if (origin !== undefined) { this.face.openQuote(origin.source, origin.text, { follow: true, tone }); return }
      const transcript = this.ctx.sessions.binding(node.parentId)?.session.projections.faceOf('sessionCanvas').getSnapshot() as CanvasTranscript | undefined
      const boundary = transcript?.turns.find(turn => turn.seq === node.forkSeq)
      if (boundary !== undefined) this.face.revealSource(node.parentId, boundary.turn, boundary.seq, undefined, { follow: true, tone })
    },
    openQuote: (source, text, navigation) => {
      if (!('kind' in source)) {
        this.face.revealSource(source.sessionId, source.turn, source.seq, { seq: source.seq, text, offset: source.offset }, navigation)
        return
      }
      const request = ++this.sourceRequest
      this.patch({ sourceTarget: null })
      this.run(async () => {
        const canvas = this.source.getSnapshot().canvases.find(value => value.nodes.some(node => node.sessionId === source.sessionId))
        if (canvas === undefined) return
        const updated = await this.value(this.ctx.remote.sessionCanvas.updateNode({ canvasId: canvas.id, sessionId: source.sessionId, mode: 'summary', collapsed: false }))
        if (request !== this.sourceRequest) return
        this.receiveCanvas(updated)
        this.patch({ activeId: canvas.id, sourceTarget: { ...navigation, kind: 'summary', sessionId: source.sessionId, quote: { text, offset: source.offset } } })
        this.openPanel(); this.landSource()
      })
    },
    updateNode: (request) => {
      this.run(async () => { this.receiveCanvas(await this.value(this.ctx.remote.sessionCanvas.updateNode(request))) }, true)
    },
    arrange: (id, nodes) => {
      this.run(async () => { this.receiveCanvas(await this.value(this.ctx.remote.sessionCanvas.arrange(id, nodes))) }, true)
    },
    setMode: (id, mode) => {
      this.run(async () => {
        this.receiveCanvas(await this.value(this.ctx.remote.sessionCanvas.setMode(id, mode)))
        const others = this.source.getSnapshot().summaryOnly.filter(value => value !== id)
        this.patch({ summaryOnly: mode === 'summary' ? [...others, id] : others })
      }, true)
    },
    loadSummary: (id) => {
      if (this.deleted.has(id) || this.deleting.has(id) || this.reads.has(id)) return
      this.reads.add(id)
      this.run(async () => {
        try {
          this.receiveSummary(await this.value(this.ctx.remote.sessionCanvas.summary(id)))
          const saved = this.source.getSnapshot().summaries[id]
          if (saved === undefined) return
          if (!this.recovered.has(id) && !this.lifetime.signal.aborted) {
            this.recovered.add(id)
            const draft = this.journal?.read(id)
            if (draft !== undefined) {
              if (draft.markdown === saved.markdown) this.keepDraft(id, undefined)
              else {
                this.keepDraft(id, draft)
                if (draft.revision === saved.revision) this.scheduleSave(id)
                else { this.saveState(id, 'conflict'); this.notice('conflict', id) }
              }
            }
          }
        }
        finally { this.reads.delete(id) }
      })
    },
    editSummary: (id, markdown) => {
      if (this.deleted.has(id) || this.deleting.has(id)) return
      const state = this.source.getSnapshot(), saved = state.summaries[id]
      if (saved === undefined) return
      this.keepDraft(id, { markdown, revision: state.drafts[id]?.revision ?? saved.revision })
      this.scheduleSave(id)
    },
    discardEdits: (id) => {
      clearTimeout(this.saveTimers.get(id)); this.saveTimers.delete(id)
      this.keepDraft(id, undefined); this.saveState(id); this.face.loadSummary(id)
    },
    saveSummary: (id) => { this.run(() => this.save(id)) },
    generate: (id) => {
      if (this.generations.has(id)) return
      const cancellation = new AbortController()
      this.generations.set(id, cancellation)
      this.patch({ generating: [...this.generations.keys()] })
      this.run(async () => {
        try {
          const result = await this.ctx.remote.sessionCanvas.generate(id, AbortSignal.any([cancellation.signal, this.lifetime.signal]))
          if (!cancellation.signal.aborted) this.receiveSummary(await this.value(Promise.resolve(result)))
        } catch (error) { if (!cancellation.signal.aborted) throw error }
        finally { this.generations.delete(id); this.patch({ generating: [...this.generations.keys()] }) }
      })
    },
    cancelGeneration: id => this.generations.get(id)?.abort(),
    resolveDraft: (id, adopt) => { this.run(async () => {
      const document = this.source.getSnapshot().summaries[id]
      if (document !== undefined) this.receiveSummary(await this.value(
        this.ctx.remote.sessionCanvas.resolveDraft(id, document.version, adopt),
      ))
    }, true) },
    restore: (id, revision) => { this.run(async () => {
      const document = this.source.getSnapshot().summaries[id]
      if (document !== undefined) this.receiveSummary(await this.value(
        this.ctx.remote.sessionCanvas.restore(id, document.revision, revision),
      ))
    }, true) },
    excerpt: (id, text, turn) => { this.run(() => this.queueNote(id, async () => {
      clearTimeout(this.saveTimers.get(id)); this.saveTimers.delete(id)
      const saved = await this.value(this.ctx.remote.sessionCanvas.excerpt(id, text, turn))
      this.lifetime.signal.throwIfAborted()
      this.receiveSummary(saved)
      const state = this.source.getSnapshot(), draft = state.drafts[id]
      if (draft !== undefined && draft.revision === saved.revision - 1) {
        this.keepDraft(id, { markdown: draft.markdown + (draft.markdown === '' ? '' : '\n\n') + text, revision: saved.revision })
        this.scheduleSave(id)
      }
      else if (draft !== undefined) { this.saveState(id, 'conflict'); this.notice('conflict', id); return }
      this.notice('added', id)
    }), true) },
    showSummary: (id) => {
      const canvas = this.source.getSnapshot().canvases.find(value => value.nodes.some(node => node.sessionId === id))
      if (canvas === undefined) return
      this.patch({ activeId: canvas.id }); this.openPanel()
      this.face.updateNode({ canvasId: canvas.id, sessionId: id, mode: 'summary', collapsed: false })
    },
    revealSource: (id, turn, seq, quote, navigation) => {
      const request = ++this.sourceRequest
      this.patch({ sourceTarget: null })
      this.run(async () => {
        const canvas = this.source.getSnapshot().canvases.find(value => value.nodes.some(node => node.sessionId === id))
        if (canvas === undefined) return
        let source = canvas.nodes.find(node => node.sessionId === id)
        while (source?.parentId != null && source.forkSeq !== null && seq <= source.forkSeq) {
          source = canvas.nodes.find(node => node.sessionId === source?.parentId)
        }
        if (source !== undefined) id = source.sessionId
        this.patch({ activeId: canvas.id, summaryOnly: this.source.getSnapshot().summaryOnly.filter(value => value !== canvas.id) })
        this.openPanel()
        const updated = await this.value(this.ctx.remote.sessionCanvas.updateNode({ canvasId: canvas.id, sessionId: id, mode: 'chat', collapsed: false }))
        if (request !== this.sourceRequest) return
        this.receiveCanvas(updated)
        if (turn === null) return
        await this.ctx.sessions.using(id, { source: 'sessionCanvas', signal: this.lifetime.signal }, async (reference) => {
          const binding = await reference.ready
          await binding.session.loadThrough(seq as SessionSeq)
        })
        if (request !== this.sourceRequest) return
        this.patch({ sourceTarget: { ...navigation, sessionId: id, turn, ...quote === undefined ? {} : { quote } } })
        this.landSource()
      })
    },
    registerSourceRoot: (id, element) => {
      const previous = this.sourceRoots.get(id)
      if (this.sourceMarker !== null && previous?.element.contains(this.sourceMarker)) {
        this.sourceMarker.removeAttribute('data-canvas-quote-source')
        this.sourceMarker.style.removeProperty('--canvas-quote-color')
        this.sourceMarker = null
        if (typeof CSS !== 'undefined' && 'highlights' in CSS) CSS.highlights.delete('session-canvas-quote')
      }
      this.sourceRoots.get(id)?.dispose()
      this.sourceRoots.delete(id)
      if (element === null) { this.paintQuotes(); return }
      const binding = this.ctx.sessions.binding(id)
      if (binding === undefined) return
      const input = this.ctx.conversation.input.for(binding.ctx)
      const t = this.ctx.locale.bind(NS)
      const dispose = decorateChat(element, {
        chat: () => this.ctx.uiConversation.binding(binding).target('chat').getSnapshot(),
        onMutation: () => { this.paintQuotes(); this.landSource() },
        forkTurn: turn => {
          const state = this.source.getSnapshot()
          if (state.busy) return
          const canvas = state.canvases.find(value => value.id === state.activeId)
          const node = canvas?.nodes.find(value => value.sessionId === id)
          const transcript = binding.session.projections.faceOf('sessionCanvas').getSnapshot() as CanvasTranscript | undefined
          const boundary = transcript?.turns.find(value => value.turn === turn)
          if (canvas === undefined || node === undefined || boundary === undefined) {
            this.notice('failed', id)
            return
          }
          this.face.fork(canvas.id, id, boundary.seq, `${node.title} · ${t('fork')}`)
        },
        sourceLabel: t('quoteSource'), removeLabel: t('removeQuote'), popupClass: css.quotePopup!,
        removeQuote: index => { removeQuote(binding.ctx, input, index) },
        openQuote: index => {
          const occurrence = input.state.getSnapshot().occurrences.filter(item => item.source === QUOTE_SOURCE)[index]
          if (occurrence === undefined) return
          const quote = readQuoteReference(occurrence.ref)
          this.openReference(id, quote.text, quote.source)
        },
      })
      const unsubscribe = input.state.subscribe(() => { this.paintQuotes() })
      this.sourceRoots.set(id, { element, dispose: () => { unsubscribe(); dispose() } })
      this.paintQuotes(); this.landSource()
    },
    dismissNotice: () => { this.patch({ notice: null }) },
    editorFailed: (id) => { this.notice('failed', id) },
  }

  /**
   * Stop pending inference and await owned asynchronous work.
   * @returns quiescent disposal.
   */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    this.mapping?.abort()
    for (const timer of this.saveTimers.values()) clearTimeout(timer)
    this.saveTimers.clear()
    for (const { dispose } of this.sourceRoots.values()) dispose()
    this.sourceRoots.clear()
    paintQuoteOrigins([], new Map())
    this.sourceMarker?.removeAttribute('data-canvas-quote-source')
    this.sourceMarker?.style.removeProperty('--canvas-quote-color')
    this.sourceMarker = null
    if (typeof CSS !== 'undefined' && 'highlights' in CSS) CSS.highlights.delete('session-canvas-quote')
    this.pendingQuotes.clear()
    this.focusChild = null
    for (const cancellation of this.generations.values()) cancellation.abort()
    await Promise.allSettled([...this.editors.values()].flatMap(editors => [...editors].map(editor => editor.dispose())))
    this.editors.clear()
    await Promise.allSettled([...this.tasks, ...this.saves.values()])
  }
}
