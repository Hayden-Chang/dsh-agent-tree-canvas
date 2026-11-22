/** Host owner of durable Session trees and separate human-facing summaries. */
import { subtreeIds } from './subtree.ts'
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { ZoomOptions } from './zoom-options.ts'
import { AutosaveDelayMs } from './summary-options.ts'
import { CanvasSessions } from './session-lifecycle.ts'
import { canvasDomain, deletionDomain, emptySummary } from './schema.ts'
import { transcriptProjection } from './projection.ts'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { generateMindmap, mindmapProjection, mindmapMessage } from './mindmap.ts'
import type { MindmapResult } from './types.ts'
import type { MindmapState, MindmapLimits } from './mindmap.ts'
import { generateSummary } from './summary.ts'
import type {
  CanvasDocument, CanvasId, CanvasMode, CanvasNode, CanvasTranscript, NodePlacement,
  SaveSummaryRequest, SummaryDocument, SummaryVersion, UpdateNodeRequest,
} from './types.ts'

/** Validated plugin resource bounds and the default conversation persona. */
export interface Config extends MindmapLimits {
  /** Idle delay before saving human summary edits, in milliseconds. */
  readonly autosaveDelayMs: number
  /** Browser wheel and pinch zoom gains. */
  readonly zoom: ZoomOptions
  /** Maximum UTF-8 bytes of selected or conversation text accepted for one inference request. */
  readonly maxInputBytes: number
  /** Maximum output tokens requested for summary generation. */
  readonly maxOutputTokens: number
  /** Maximum duration in milliseconds of one inference request. */
  readonly timeoutMs: number
  /** Maximum JavaScript string length of saved notes and summary candidates. */
  readonly maxSummaryChars: number
  /** System instruction for new conversations created from the canvas. */
  readonly persona: string
}

declare module '@deepseek-ai/cordis' {
  interface Context { sessionCanvas: SessionCanvas }
}

/** Keep a previous version for each accepted human or generated edit. */
function revise(document: SummaryDocument, markdown: string, kind: SummaryVersion['kind']): SummaryDocument {
  return {
    ...document, markdown, revision: document.revision + 1, version: document.version + 1,
    versions: [...document.versions, { revision: document.revision, markdown: document.markdown, kind, time: Date.now() }],
  }
}

/** Optional plugin; unloading withdraws its UI/API without deleting stored Sessions or notes. */
export default class SessionCanvas extends TypertRemoteService {
  static inject = ['sessions', 'storageDomain', 'sessionController', 'sessionQuery', 'sessionProjections', 'agentDefaultModel', 'agentPresets', 'llm', 'agents', 'sessionPersistence', 'workspaceRegistry']
  static Config = z.object({
    autosaveDelayMs: AutosaveDelayMs,
    zoom: ZoomOptions,
    maxInputBytes: z.natural().min(1).default(384000),
    maxOutputTokens: z.natural().min(1).default(8192),
    maxMindmapOutputTokens: z.natural().min(1).default(16384),
    mindmapAttempts: z.natural().min(1).max(3).default(2),
    timeoutMs: z.natural().min(1).max(2147483647).default(120000),
    maxMindmapNodes: z.natural().min(1).max(200).default(60),
    maxMindmapDepth: z.natural().min(1).max(20).default(8),
    maxMindmapNodeChars: z.natural().min(1).default(2000),
    maxSummaryChars: z.natural().min(1).default(1000000),
    persona: z.string().default('You are a helpful thinking and learning assistant. Explore the user\'s questions clearly and carefully.'),
  })
  private domain!: Domain<typeof canvasDomain>
  private deletionJobs!: Domain<typeof deletionDomain>
  private readonly deleting = new Set<SessionId>()
  private readonly deletingCanvases = new Set<CanvasId>()
  private readonly branches = new Map<CanvasId, Set<Promise<CanvasDocument>>>()
  private readonly summaryAborts = new Map<SessionId, AbortController>()
  private readonly removals = new Set<Promise<CanvasDocument>>()
  private runtime!: CanvasSessions
  private transcript!: ProjectionHandle<CanvasTranscript>
  private readonly lifetime = new AbortController()
  private mindmapContext!: ProjectionHandle<MindmapState>
  private readonly mindmaps = new Map<CanvasId, Promise<MindmapResult>>()
  private readonly pending = new Map<SessionId, Promise<SummaryDocument>>()

  constructor(ctx: Context, private readonly config: Config) { super(ctx, 'sessionCanvas') }

  protected async [Service.init](): Promise<void> {
    this.ctx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'global', name: '__DSH_SESSION_CANVAS_ZOOM__', value: this.config.zoom })
      table.push({ kind: 'global', name: '__DSH_SESSION_CANVAS_AUTOSAVE_MS__', value: this.config.autosaveDelayMs })
    })
    this.domain = await this.ctx.storageDomain.open(canvasDomain)
    this.deletionJobs = await this.ctx.storageDomain.open(deletionDomain)
    this.runtime = new CanvasSessions(this.ctx, this.deleting)
    this.ctx.effect(() => async () => {
      this.lifetime.abort()
      try {
        await Promise.allSettled([...this.pending.values(), ...this.mindmaps.values(), ...this.removals,
          ...[...this.branches.values()].flatMap(tasks => [...tasks])])
        await this.runtime.dispose()
      } finally { await this.deletionJobs.close(); await this.domain.close() }
    })
    this.transcript = await this.ctx.sessionProjections.register(transcriptProjection)
    this.mindmapContext = await this.ctx.sessionProjections.register(mindmapProjection)
    this.ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted) return decision
      const state = this.mindmapContext.stateOf(agent.session)
      if (state.context === null || state.delivered) return decision
      return { ...decision, messages: [mindmapMessage(state.context), ...decision.messages] }
    }, { prepend: true })
    const unregisterPreset = await this.ctx.agentPresets.register({
      id: 'session-canvas', name: 'Session canvas', description: 'Conversation without code execution or filesystem tools.',
      plugins: [
        { name: '@deepseek-ai/dsh-persona', config: { prefix: this.config.persona, complete: true, includeRuntimeContext: false } },
        { name: 'cordis:group', group: true, isolate: { compaction: true }, config: [
          { name: '@deepseek-ai/dsh-compaction-basic' },
        ] },
      ],
    })
    this.ctx.effect(() => unregisterPreset)
    this.ctx.on('agent/created', ({ agent }) => {
      this.assertSessionAvailable(agent.id)
      if (this.ctx.agentPresets.presetForSession(agent.session) === 'session-canvas') {
        // The Agent scope retains this restriction even if the canvas UI is disabled.
        agent.ctx.tools.restrict({ allow: [] })
      }
    })
    for (const [canvasId, job] of this.deletionJobs.table('jobs').entries()) {
      for (const id of job.sessionIds) this.deleting.add(id)
      this.deletingCanvases.add(canvasId)
      await this.finishDeletion(canvasId, job.sessionIds)
    }
    await this.runtime.restore(this.list().flatMap(canvas => canvas.nodes.map(node => node.sessionId)))
  }

  private assertSessionAvailable(id: SessionId): void {
    if (this.deleting.has(id)) throw new RemoteError('canvas/deleting', 'Session is being permanently deleted', {})
  }

  private assertCanvasAvailable(id: CanvasId): void {
    if (this.deletingCanvases.has(id)) throw new RemoteError('canvas/deleting', 'Canvas deletion is in progress', {})
  }

  private canvas(id: CanvasId): CanvasDocument {
    const value = this.domain.table('canvases').get(id)
    if (value === undefined) throw new RemoteError('canvas/invalid', 'Canvas not found', { reason: 'canvas-not-found' })
    return value
  }

  private node(canvasId: CanvasId, sessionId: SessionId): CanvasNode {
    this.assertSessionAvailable(sessionId)
    const node = this.canvas(canvasId).nodes.find(candidate => candidate.sessionId === sessionId)
    if (node === undefined) throw new RemoteError('canvas/invalid', 'Node not found', { reason: 'node-not-found' })
    return node
  }

  private validateText(markdown: string): void {
    if (markdown.length > this.config.maxSummaryChars) throw new RemoteError('canvas/invalid', 'Summary is too large', { reason: 'summary-too-large' })
  }

  /**
   * List all locally stored canvases.
   * @returns durable canvas documents.
   */
  @Remote
  list(): CanvasDocument[] { return [...this.domain.table('canvases').entries()].map(([, value]) => value) }

  /**
   * Create an empty canvas.
   * @param title - display name.
   * @returns the durable document.
   */
  @Remote
  async create(title: string): Promise<CanvasDocument> {
    if (title.trim() === '') throw new RemoteError('canvas/invalid', 'A title is required', { reason: 'empty-title' })
    const value: CanvasDocument = { id: brandString<CanvasId>(randomUUID()), title: title.trim(), nodes: [], revision: 0 }
    await this.domain.table('canvases').put(value.id, value)
    return value
  }

  /**
   * Rename a canvas.
   * @param canvasId - target.
   * @param title - new display name.
   * @returns saved document.
   */
  @Remote
  async rename(canvasId: CanvasId, title: string): Promise<CanvasDocument> {
    this.canvas(canvasId)
    if (title.trim() === '') throw new RemoteError('canvas/invalid', 'A title is required', { reason: 'empty-title' })
    return this.domain.table('canvases').update(canvasId, value => ({ ...value, title: title.trim(), revision: value.revision + 1 }))
  }

  /**
   * Create a root using the conversation-only preset.
   * @param canvasId - owning canvas.
   * @param title - node label.
   * @returns the canvas containing the new Session.
   */
  @Remote
  async addRoot(canvasId: CanvasId, title: string): Promise<CanvasDocument> {
    const canvas = this.canvas(canvasId)
    const y = Math.max(-636, ...canvas.nodes.map(node => node.y)) + 700
    const { sessionId } = await this.runtime.create()
    return this.attach(canvasId, { sessionId, parentId: null, forkSeq: null, title, x: 64, y, mode: 'chat', collapsed: false })
  }

  /**
   * Copy a completed-turn prefix into an independently evolving child Session.
   * @param canvasId - owning canvas.
   * @param sessionId - parent node.
   * @param atSeq - inclusive completed-turn boundary, or null for the latest completed turn; no completed turns starts an empty child.
   * @param title - child label.
   * @returns the saved canvas; the child's summary starts empty.
   */
  @Remote
  async fork(canvasId: CanvasId, sessionId: SessionId, atSeq: number | null, title: string): Promise<CanvasDocument> {
    this.assertCanvasAvailable(canvasId)
    const work = this.forkNode(canvasId, sessionId, atSeq, title)
    const tasks = this.branches.get(canvasId) ?? new Set<Promise<CanvasDocument>>()
    tasks.add(work); this.branches.set(canvasId, tasks)
    try { return await work } finally { tasks.delete(work); if (tasks.size === 0) this.branches.delete(canvasId) }
  }

  private async forkNode(canvasId: CanvasId, sessionId: SessionId, atSeq: number | null, title: string): Promise<CanvasDocument> {
    const parent = this.node(canvasId, sessionId)
    using observation = await this.ctx.sessionQuery.observeSession(sessionId)
    const transcript = observation.projections?.values.sessionCanvas
    if (transcript === undefined) throw new RemoteError('canvas/invalid', 'Conversation is not loaded', { reason: 'transcript-unavailable' })
    const boundary = atSeq ?? transcript.turns.at(-1)?.seq
    if (atSeq !== null && !transcript?.turns.some(turn => turn.seq === atSeq)) {
      throw new RemoteError('canvas/invalid', 'Choose a completed turn', { reason: 'incomplete-turn' })
    }
    const child = boundary === undefined
      ? await this.runtime.create()
      : await this.runtime.fork(sessionId, boundary)
    const source = await this.ctx.sessionController.resolveAgent(sessionId)
    if ('error' in source) throw source.error
    const focus = this.mindmapContext.stateOf(source.agent.session)
    if (focus.context !== null && focus.seq > (boundary ?? -1)) {
      const target = await this.ctx.sessionController.resolveAgent(child.sessionId)
      if ('error' in target) throw target.error
      appendPluginRecord(target.agent.session, 'plugin:session-canvas/mindmap-context', focus.context)
      await this.ctx.sessions.flush(target.agent.session)
    }
    const siblings = this.canvas(canvasId).nodes.filter(node => node.parentId === sessionId).length
    return await this.attach(canvasId, { sessionId: child.sessionId, parentId: sessionId, forkSeq: boundary ?? null,
      title, x: parent.x + 640, y: parent.y + siblings * 700, mode: 'chat', collapsed: false })
  }

  /**
   * Generate and attach a complete subtree from a selection without overwriting existing nodes.
   * @param canvasId - owning canvas.
   * @param sessionId - selected parent node.
   * @param atSeq - selected completed turn, or null for the latest completed turn.
   * @param text - verbatim selection, the only material for outline generation.
   * @param signal - caller cancellation.
   * @returns canvas and created identities; an empty list means no useful subdivision.
   */
  @Remote
  async mindmap(canvasId: CanvasId, sessionId: SessionId, atSeq: number | null, text: string, signal: AbortSignal): Promise<MindmapResult> {
    this.assertCanvasAvailable(canvasId)
    this.node(canvasId, sessionId)
    if (this.mindmaps.has(canvasId)) throw new RemoteError('canvas/busy', 'Mind-map generation is running', { sessionId })
    const work = this.createMindmap(canvasId, sessionId, atSeq, text, AbortSignal.any([signal, this.lifetime.signal]))
    this.mindmaps.set(canvasId, work)
    try { return await work } finally { this.mindmaps.delete(canvasId) }
  }

  private async createMindmap(canvasId: CanvasId, sessionId: SessionId, atSeq: number | null, text: string, signal: AbortSignal): Promise<MindmapResult> {
    const parent = this.node(canvasId, sessionId)
    const source = await this.ctx.sessionController.resolveAgent(sessionId)
    if ('error' in source) throw source.error
    const transcript = this.transcript.stateOf(source.agent.session)
    const boundary = atSeq ?? transcript.turns.at(-1)?.seq ?? null
    if (atSeq !== null && !transcript.turns.some(turn => turn.seq === atSeq)) {
      throw new RemoteError('canvas/invalid', 'Choose a completed turn', { reason: 'incomplete-turn' })
    }
    const originalPath: string[] = []
    const originalNodes = this.canvas(canvasId).nodes
    for (let cursor: CanvasNode | undefined = parent; cursor !== undefined; cursor = originalNodes.find(node => node.sessionId === cursor?.parentId)) {
      originalPath.unshift(cursor.title)
    }
    const created: CanvasNode[] = []
    try {
      const entries = await generateMindmap(this.ctx, source.agent.session, text, originalPath, boundary,
        source.agent.model.current() ?? this.ctx.agentDefaultModel.currentSelection(), this.config, signal)
      signal.throwIfAborted()
      this.node(canvasId, sessionId)
      if (entries.length === 0) return { canvas: this.canvas(canvasId), createdSessionIds: [] }
      for (const entry of entries) this.validateText(entry.text)
      const ancestors: CanvasNode[] = [parent]
      const path: string[] = [...originalPath]
      for (const entry of entries) {
        signal.throwIfAborted()
        this.node(canvasId, sessionId)
        const origin = ancestors[entry.depth]!
        const child = boundary === null
          ? await this.runtime.create()
          : await this.runtime.fork(origin.sessionId, boundary)
        const node: CanvasNode = { sessionId: child.sessionId, parentId: origin.sessionId, forkSeq: boundary,
          title: entry.text, mode: 'summary', collapsed: false, x: parent.x + (entry.depth + 1) * 640, y: parent.y + created.length * 700 }
        created.push(node)
        ancestors.length = entry.depth + 1; ancestors.push(node)
        path.length = originalPath.length + entry.depth; path.push(entry.text)
        const target = await this.ctx.sessionController.resolveAgent(child.sessionId)
        if ('error' in target) throw target.error
        appendPluginRecord(target.agent.session, 'plugin:session-canvas/mindmap-context', { selection: text, path: [...path], content: entry.text })
        await this.ctx.sessions.flush(target.agent.session)
        await this.domain.table('summaries').put(child.sessionId, revise(emptySummary(child.sessionId), entry.text, 'generated'))
      }
      signal.throwIfAborted()
      const canvas = await this.domain.table('canvases').update(canvasId, value => {
        signal.throwIfAborted()
        if (!value.nodes.some(node => node.sessionId === sessionId)) throw new Error('parent-removed')
        return { ...value, revision: value.revision + 1, nodes: [...value.nodes, ...created] }
      })
      return { canvas, createdSessionIds: created.map(node => node.sessionId) }
    } catch (error) {
      if (created.length === 0) signal.throwIfAborted()
      if (error instanceof RemoteError && error.code === 'canvas/model-unavailable') throw error
      throw new RemoteError('canvas/mindmap-failed', 'No subtree attached. Created Sessions, if any, remain in the Session list.',
        { sessionIds: created.map(node => node.sessionId) }, { cause: error })
    }
  }

  private async attach(canvasId: CanvasId, node: CanvasNode): Promise<CanvasDocument> {
    try {
      await this.domain.table('summaries').put(node.sessionId, emptySummary(node.sessionId))
      return await this.domain.table('canvases').update(canvasId, value => {
        if (node.parentId !== null && !value.nodes.some(parent => parent.sessionId === node.parentId)) {
          throw new RemoteError('canvas/invalid', 'Parent was removed from the canvas', { reason: 'node-not-found' })
        }
        return { ...value, nodes: [...value.nodes, node], revision: value.revision + 1 }
      })
    } catch (error) {
      throw new RemoteError('canvas/attach-failed', 'Session created; canvas save failed. The Session remains in the Session list.', { sessionId: node.sessionId }, { cause: error })
    }
  }

  /**
   * Permanently delete a subtree's Sessions, context, summaries and versions.
   * @param canvasId - owning canvas.
   * @param sessionId - selected subtree root.
   * @returns the updated canvas only after all active data is deleted; failures retain a resumable deletion job.
   */
  @Remote
  async removeNode(canvasId: CanvasId, sessionId: SessionId): Promise<CanvasDocument> {
    this.assertCanvasAvailable(canvasId)
    const pending = this.deletionJobs.table('jobs').get(canvasId)
    if (pending === undefined) this.node(canvasId, sessionId)
    this.deletingCanvases.add(canvasId)
    const task = this.deleteSubtree(canvasId, sessionId, pending?.sessionIds)
    this.removals.add(task)
    try { return await task } finally { this.removals.delete(task); this.deletingCanvases.delete(canvasId) }
  }

  private async deleteSubtree(canvasId: CanvasId, sessionId: SessionId, pending?: readonly SessionId[]): Promise<CanvasDocument> {
    let deletionStarted = pending !== undefined
    try {
      // A branch already being created must join the frozen descendant set.
      await Promise.allSettled([...(this.branches.get(canvasId) ?? []), ...this.mindmaps.has(canvasId) ? [this.mindmaps.get(canvasId)!] : []])
      const removed = pending ?? [...subtreeIds(this.canvas(canvasId).nodes, sessionId)]
      await this.runtime.checkDeletion(removed)
      deletionStarted = true
      await this.deletionJobs.table('jobs').put(canvasId, { sessionIds: removed })
      for (const id of removed) { this.deleting.add(id); this.summaryAborts.get(id)?.abort() }
      await Promise.allSettled(removed.flatMap(id => this.pending.has(id) ? [this.pending.get(id)!] : []))
      return await this.finishDeletion(canvasId, removed)
    } catch (error) {
      if (error instanceof RemoteError && error.code === 'canvas/delete-unavailable') throw error
      if (!deletionStarted) throw new RemoteError('canvas/delete-not-started', 'Deletion could not start; no node data was deleted', {}, { cause: error })
      throw new RemoteError('canvas/delete-failed', 'Deletion is incomplete; retry to finish cleanup', {}, { cause: error })
    }
  }

  private async finishDeletion(canvasId: CanvasId, removed: readonly SessionId[]): Promise<CanvasDocument> {
    await this.runtime.purge(removed)
    await this.domain.table('summaries').deleteMany(removed)
    const ids = new Set(removed)
    const canvas = await this.domain.table('canvases').update(canvasId, value => ({
      ...value, nodes: value.nodes.filter(node => !ids.has(node.sessionId)), revision: value.revision + 1,
    }))
    await this.deletionJobs.table('jobs').delete(canvasId)
    this.deletingCanvases.delete(canvasId)
    return canvas
  }

  /**
   * Save node presentation.
   * @param request - node and changed fields.
   * @returns saved canvas.
   */
  @Remote
  async updateNode(request: UpdateNodeRequest): Promise<CanvasDocument> {
    this.node(request.canvasId, request.sessionId)
    return this.domain.table('canvases').update(request.canvasId, value => ({ ...value, revision: value.revision + 1,
      nodes: value.nodes.map(node => node.sessionId !== request.sessionId ? node : { ...node,
        ...request.title === undefined ? {} : { title: request.title },
        ...request.mode === undefined ? {} : { mode: request.mode },
        ...request.collapsed === undefined ? {} : { collapsed: request.collapsed },
      }),
    }))
  }

  /**
   * Save dragged or auto-arranged positions.
   * @param canvasId - canvas.
   * @param placements - changed nodes.
   * @returns saved canvas.
   */
  @Remote
  async arrange(canvasId: CanvasId, placements: readonly NodePlacement[]): Promise<CanvasDocument> {
    for (const placement of placements) {
      this.node(canvasId, placement.sessionId)
      if (!Number.isFinite(placement.x) || !Number.isFinite(placement.y)) throw new RemoteError('canvas/invalid', 'Invalid position', { reason: 'invalid-position' })
    }
    const positions = new Map(placements.map(value => [value.sessionId, value]))
    return this.domain.table('canvases').update(canvasId, value => ({ ...value, revision: value.revision + 1,
      nodes: value.nodes.map(node => ({ ...node, ...positions.get(node.sessionId) })),
    }))
  }

  /**
   * Switch current nodes without invoking inference.
   * @param canvasId - canvas.
   * @param mode - display mode.
   * @returns saved canvas.
   */
  @Remote
  async setMode(canvasId: CanvasId, mode: CanvasMode): Promise<CanvasDocument> {
    this.canvas(canvasId)
    return this.domain.table('canvases').update(canvasId, value => ({ ...value, revision: value.revision + 1, nodes: value.nodes.map(node => ({ ...node, mode })) }))
  }

  /**
   * Read human-facing notes.
   * @param sessionId - canvas Session.
   * @returns saved summary and pending candidate.
   */
  @Remote
  summary(sessionId: SessionId): SummaryDocument {
    this.assertSessionAvailable(sessionId)
    const document = this.domain.table('summaries').get(sessionId)
    if (document === undefined) throw new RemoteError('canvas/invalid', 'Summary not found', { reason: 'summary-not-found' })
    return document
  }

  /**
   * Save a manual edit without losing concurrent changes.
   * @param request - text and expected revision.
   * @returns saved summary.
   */
  @Remote
  async saveSummary(request: SaveSummaryRequest): Promise<SummaryDocument> {
    this.assertSessionAvailable(request.sessionId)
    this.validateText(request.markdown)
    return this.domain.table('summaries').update(request.sessionId, (value) => {
      if (value.revision !== request.revision) throw new RemoteError('canvas/conflict', 'A newer summary exists', { revision: value.revision })
      return revise(value, request.markdown, 'edit')
    })
  }

  /**
   * Append selected text verbatim, with separately retained source attribution.
   * @param sessionId - selected node.
   * @param text - exact selected text, without trimming or rewriting.
   * @param turn - source turn when available.
   * @returns saved summary; earlier notes and candidates are preserved.
   */
  @Remote
  async excerpt(sessionId: SessionId, text: string, turn: number | null): Promise<SummaryDocument> {
    this.assertSessionAvailable(sessionId)
    if (text === '') throw new RemoteError('canvas/invalid', 'Select text first', { reason: 'empty-selection' })
    return this.domain.table('summaries').update(sessionId, (value) => {
      const markdown = value.markdown + (value.markdown === '' ? '' : '\n\n') + text
      this.validateText(markdown)
      return { ...revise(value, markdown, 'excerpt'), excerpts: [...value.excerpts, { revision: value.revision + 1, text, turn, time: Date.now() }] }
    })
  }

  /**
   * Generate a separate candidate; neither current notes nor chat history is overwritten.
   * @param sessionId - source node.
   * @param signal - caller cancellation.
   * @returns document with a pending candidate.
   */
  @Remote
  async generate(sessionId: SessionId, signal: AbortSignal): Promise<SummaryDocument> {
    this.summary(sessionId)
    if (this.pending.has(sessionId)) throw new RemoteError('canvas/busy', 'Summary generation is running', { sessionId })
    const cancellation = new AbortController()
    this.summaryAborts.set(sessionId, cancellation)
    const work = this.generateCandidate(sessionId, AbortSignal.any([signal, this.lifetime.signal, cancellation.signal]))
    this.pending.set(sessionId, work)
    try { return await work } finally { this.pending.delete(sessionId); this.summaryAborts.delete(sessionId) }
  }

  private async generateCandidate(sessionId: SessionId, signal: AbortSignal): Promise<SummaryDocument> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId)
    if ('error' in result) throw result.error
    signal.throwIfAborted()
    const { agent } = result
    const transcript = this.transcript.stateOf(agent.session)
    const baseRevision = this.summary(sessionId).revision
    const throughSeq = agent.session.seq - 1
    let markdown: string
    try {
      markdown = await generateSummary(
        this.ctx, agent.session, transcript, throughSeq,
        agent.model.current() ?? this.ctx.agentDefaultModel.currentSelection(), this.config, signal,
      )
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof RemoteError && error.code === 'canvas/model-unavailable') throw error
      throw new RemoteError('canvas/summary-failed', 'Summary generation failed; saved notes are unchanged', { reason: 'provider-error' }, { cause: error })
    }
    this.validateText(markdown)
    this.assertSessionAvailable(sessionId)
    signal.throwIfAborted()
    return this.domain.table('summaries').update(sessionId, value => ({ ...value, version: value.version + 1, draft: { markdown, baseRevision, throughSeq } }))
  }

  /**
   * Adopt or discard the shown candidate.
   * @param sessionId - node.
   * @param version - expected document version.
   * @param adopt - whether to adopt.
   * @returns saved summary.
   */
  @Remote
  async resolveDraft(sessionId: SessionId, version: number, adopt: boolean): Promise<SummaryDocument> {
    this.assertSessionAvailable(sessionId)
    return this.domain.table('summaries').update(sessionId, (value) => {
      if (value.version !== version) throw new RemoteError('canvas/conflict', 'A newer summary exists', { revision: value.revision })
      if (value.draft === null) return value
      return { ...(adopt ? revise(value, value.draft.markdown, 'generated') : { ...value, version: value.version + 1 }), draft: null }
    })
  }

  /**
   * Restore a saved version while retaining the present one.
   * @param sessionId - node.
   * @param revision - current revision.
   * @param restoreRevision - historical version.
   * @returns saved summary.
   */
  @Remote
  async restore(sessionId: SessionId, revision: number, restoreRevision: number): Promise<SummaryDocument> {
    this.assertSessionAvailable(sessionId)
    return this.domain.table('summaries').update(sessionId, (value) => {
      if (value.revision !== revision) throw new RemoteError('canvas/conflict', 'A newer summary exists', { revision: value.revision })
      const previous = value.versions.find(version => version.revision === restoreRevision)
      if (previous === undefined) throw new RemoteError('canvas/invalid', 'Version not found', { reason: 'version-not-found' })
      return revise(value, previous.markdown, 'restore')
    })
  }
}
