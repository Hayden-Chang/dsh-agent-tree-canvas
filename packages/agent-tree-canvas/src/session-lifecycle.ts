/** Plugin-owned Agent handles and permanent cleanup for stock JSONL Sessions. */
import { randomUUID } from 'node:crypto'
import { lstat, realpath, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { AgentHandle, AgentOptions, AgentSetup } from '@deepseek-ai/dsh-agent'
import { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import { projectionCacheDomainSpec } from '@deepseek-ai/dsh-session-projection-cache'
import { LEGACY_PRESET_ID, PRESET_ID } from './legacy.ts'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/**
 * Canvas-owned preset IDs use the Web profile's standard composition.
 * @param id - preset id recorded in a Session header or projection.
 * @returns standard for Canvas-owned IDs, or the explicitly selected preset.
 */
export function currentPreset(id: string): string {
  return id === LEGACY_PRESET_ID || id === PRESET_ID ? 'standard' : id
}

/** The plugin retains disposal capabilities for its own canvas Sessions. */
export class CanvasSessions {
  private readonly handles = new Map<SessionId, AgentHandle>()
  constructor(private readonly ctx: Context, private readonly deleting: ReadonlySet<SessionId>) {}

  private modelOptions(): AgentOptions {
    const defaults = this.ctx.agentDefaultModel
    return { get provider() { return defaults.currentSelection().provider },
      get model() { return defaults.currentSelection().model },
      get reasoningEffort() { return defaults.currentSelection().reasoningEffort } }
  }

  private async setup(presetId = 'standard'): Promise<AgentSetup> {
    const preset = await this.ctx.agentPresets.resolve(currentPreset(presetId))
    return async agentCtx => {
      installModelSelection(agentCtx)
      await this.ctx.agentPresets.mount(agentCtx, preset.id)
    }
  }

  /**
   * Take ownership at plugin startup, before browser consumers can resume the Sessions.
   * @param ids - existing canvas Session identities.
   * @returns once every existing Session is owned; missing logs remain absent.
   */
  async restore(ids: readonly SessionId[]): Promise<void> {
    for (const id of new Set(ids)) {
      if (this.deleting.has(id) || this.handles.has(id)) continue
      if (this.ctx.agents.get(id) !== undefined) throw new RemoteError('canvas/delete-unavailable', 'Restart DSH to transfer canvas Session ownership', {})
      const stored = await this.ctx.sessionPersistence.stat(id)
      if (stored === undefined) continue
      using observed = await this.ctx.sessionQuery.observeSession(id)
      const preset = observed.projections?.values.agentPreset ?? stored.header.agentPreset ?? 'standard'
      const handle = await this.ctx.agents.resume({ resumeSessionId: id,
        agentOptions: this.modelOptions(), setup: await this.setup(preset) })
      this.handles.set(id, handle)
    }
  }

  /**
   * Create a new conversation owned by this plugin.
   * @returns its Session identity, without starting a model turn.
   */
  async create(): Promise<{ sessionId: SessionId }> {
    const sessionId = SessionId(`session-${randomUUID()}`)
    const handle = await this.ctx.agents.create({ sessionId, meta: { cwd: process.cwd(), agentPreset: 'standard' },
      agentOptions: this.modelOptions(), setup: await this.setup() })
    this.handles.set(sessionId, handle)
    return { sessionId }
  }

  /**
   * Create an independently owned child from an inclusive completed-turn prefix.
   * @param sessionId - source Session.
   * @param atSeq - inclusive fork boundary.
   * @returns the child's identity after publication.
   */
  async fork(sessionId: SessionId, atSeq: number): Promise<{ sessionId: SessionId }> {
    using source = await this.ctx.sessionQuery.observeSession(sessionId)
    const boundary = SessionSeq(atSeq)
    if (source.events[boundary]?.seq !== boundary) throw new Error('Fork boundary is unavailable')
    const childId = SessionId(`session-${randomUUID()}`)
    const preset = source.projections?.values.agentPreset ?? source.header.agentPreset ?? 'standard'
    const handle = await this.ctx.agents.create({ sessionId: childId,
      seed: buildForkSeed(source.events, boundary), inheritedEventCount: SessionLogOffset(boundary + 1),
      meta: { cwd: source.header.cwd, isSeeded: true, agentPreset: currentPreset(preset) },
      agentOptions: this.modelOptions(), setup: await this.setup(preset) })
    this.handles.set(childId, handle)
    for (const workspace of this.ctx.workspaceRegistry.list()) {
      if (workspace.sessionIds.includes(sessionId)) await workspace.attachSession(childId)
    }
    return { sessionId: childId }
  }

  /**
   * Check deletion support before recording destructive intent.
   * @param ids - complete selected subtree.
   * @returns after ownership and JSONL artifact validation.
   */
  async checkDeletion(ids: readonly SessionId[]): Promise<void> {
    await this.reconcileSearch()
    for (const id of ids) {
      const agent = this.ctx.agents.get(id)
      if (agent !== undefined && this.handles.get(id)?.agent !== agent) {
        throw new RemoteError('canvas/delete-unavailable', 'Restart DSH to transfer canvas Session ownership', {})
      }
      if (agent !== undefined) await this.ctx.sessions.flush(agent.session)
      await this.directory(id)
    }
  }

  private async directory(id: SessionId): Promise<string | undefined> {
    const stored = await this.ctx.sessionPersistence.stat(id)
    if (stored === undefined) return
    const location = stored.location
    // Canvas-generated ids are one literal segment in the shipped JSONL provider.
    if (location?.kind !== 'jsonl' || !isAbsolute(location.path) || !/^[A-Za-z0-9_-]+$/.test(id)
      || basename(dirname(location.path)) !== id || !/^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?$/.test(basename(location.path))) {
      throw new RemoteError('canvas/delete-unavailable', 'Permanent deletion requires a stock JSONL Session artifact', {})
    }
    const directory = dirname(location.path)
    const canonical = await realpath(directory)
    if ((await lstat(directory)).isSymbolicLink() || canonical !== join(await realpath(dirname(directory)), id)) {
      throw new RemoteError('canvas/delete-unavailable', 'Refusing a linked Session directory', {})
    }
    return canonical
  }

  /**
   * Stop owned agents, delete their complete directories and shared derived cache records.
   * @param ids - identities already protected by a durable deletion job.
   * @returns only after active logs, projection caches, and workspace references are removed.
   */
  async purge(ids: readonly SessionId[]): Promise<void> {
    for (const id of ids) {
      const owned = this.handles.get(id)
      if (owned !== undefined) { await owned.dispose(); this.handles.delete(id) }
      if (this.ctx.agents.get(id) !== undefined || this.ctx.sessions.get(id) !== undefined) {
        throw new RemoteError('canvas/delete-unavailable', 'Session is still active', {})
      }
      const directory = await this.directory(id)
      if (directory !== undefined) {
        // The provider's write lease rejects another process holding this Session.
        const lease = await this.ctx.sessionPersistence.open(id, 'write')
        try { await rm(directory, { recursive: true, force: false }) }
        finally { await lease.close() }
      }
      for (const workspace of this.ctx.workspaceRegistry.list()) await workspace.detachSession(id)
      await this.ctx.workspaceRegistry.unpinSession(id)
      await this.ctx.workspaceRegistry.unarchiveSession(id)
    }
    const shared = this.ctx.storageDomain.get(projectionCacheDomainSpec.name)
    if (shared !== undefined) await shared.table('sessions').deleteMany(ids)
    else {
      const cache = await this.ctx.storageDomain.open(projectionCacheDomainSpec)
      try { await cache.table('sessions').deleteMany(ids) } finally { await cache.close() }
    }
    // A supported search reconciles deletions into the stock derived search index.
    await this.reconcileSearch()
  }

  private async reconcileSearch(): Promise<void> {
    try { await this.ctx.sessionQuery.searchSessions({ query: 'agent-tree-canvas-deletion', limit: 1 }) }
    catch (error) {
      // Stock profiles disable optional full-text search; exact Session reads remain available.
      if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_SEARCH_DISABLED') return
      throw error
    }
  }

  /** @returns after all owned Agent lifecycles and persistence writers are stopped. */
  async dispose(): Promise<void> {
    const results = await Promise.allSettled([...this.handles.values()].map(handle => handle.dispose()))
    this.handles.clear()
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length > 0) throw new AggregateError(errors, 'Canvas Session teardown failed')
  }
}
