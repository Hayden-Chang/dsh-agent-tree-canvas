/**
 * One-time adoption of state saved while this plugin was published as
 * `@deepseek-ai/dsh-session-canvas`: its durable domains, its agent preset id,
 * and the record/source/reference names that old Sessions still contain.
 *
 * The legacy units are only read, except for deletion intents, which are moved
 * so the same destructive request cannot be replayed on a later start.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, DomainSpec } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CanvasDocument, CanvasId, SummaryDocument } from './types.ts'
import { canvasDomain, canvasSchema, deletionDomain, deletionJobSchema, summarySchema } from './schema.ts'

/** Agent preset registered by this plugin; recorded in every Session the canvas creates. */
export const PRESET_ID = 'agent-tree-canvas'
/** Preset id already recorded in Sessions created before the rename. */
export const LEGACY_PRESET_ID = 'session-canvas'

const logger = 'agent-tree-canvas'

/** Canvas and note domains declared under the previous plugin name. */
export const legacyCanvasDomain = defineDomain({
  name: 'session_canvas', version: 1,
  tables: {
    canvases: domainTable<CanvasId, CanvasDocument>(canvasSchema),
    summaries: domainTable<SessionId, SummaryDocument>(summarySchema),
  },
})

/** Deletion-intent domain declared under the previous plugin name. */
export const legacyDeletionDomain = defineDomain({
  name: 'session_canvas_deletions', version: 1,
  tables: { jobs: domainTable<CanvasId, { readonly sessionIds: readonly SessionId[] }>(deletionJobSchema) },
})

/** How many legacy records one startup adopted. */
export interface LegacyImport { readonly canvases: number; readonly summaries: number; readonly deletions: number }

async function openLegacy<S extends DomainSpec>(ctx: Context, spec: S): Promise<Domain<S> | undefined> {
  try {
    // A missing unit opens empty and creates no file until the first write.
    return await ctx.storageDomain.open(spec)
  } catch (error) {
    // Unreadable legacy data is reported, never fatal: the plugin must still start.
    ctx.logger(logger).warn(`skipped importing '${spec.name}': ${String(error)}`)
    return undefined
  }
}

/**
 * Copy canvases, notes, and unfinished deletions into the renamed domains.
 * Canvas and note units are left in place as a recovery copy; deletion intents
 * are removed once durable under the new name.
 * @param ctx - Host context providing the storage-domain facility and logger.
 * @param canvases - Open renamed canvas domain.
 * @param deletions - Open renamed deletion domain.
 * @returns imported record counts, all zero when there was nothing to adopt.
 */
export async function importLegacyDomains(ctx: Context, canvases: Domain<typeof canvasDomain>,
  deletions: Domain<typeof deletionDomain>): Promise<LegacyImport> {
  const imported = { canvases: 0, summaries: 0, deletions: 0 }
  if (canvases.table('canvases').size === 0) {
    const legacy = await openLegacy(ctx, legacyCanvasDomain)
    if (legacy !== undefined) {
      try {
        for (const [id, value] of legacy.table('canvases').entries()) {
          await canvases.table('canvases').put(id, value)
          imported.canvases += 1
        }
        for (const [id, value] of legacy.table('summaries').entries()) {
          await canvases.table('summaries').put(id, value)
          imported.summaries += 1
        }
      } finally { await legacy.close() }
    }
  }
  if (deletions.table('jobs').size === 0) {
    const legacy = await openLegacy(ctx, legacyDeletionDomain)
    if (legacy !== undefined) {
      try {
        for (const [id, value] of legacy.table('jobs').entries()) {
          await deletions.table('jobs').put(id, value)
          await legacy.table('jobs').delete(id)
          imported.deletions += 1
        }
      } finally { await legacy.close() }
    }
  }
  return imported
}
