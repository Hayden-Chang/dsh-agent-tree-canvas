/** Durable canvas and summary schemas, isolated from Session history. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CanvasDocument, CanvasId, SummaryDocument } from './types.ts'
import { quoteOriginSchema } from './quote.ts'

const sessionId = z.string().min(1).transform(brandString<SessionId>)
const canvasId = z.string().min(1).transform(brandString<CanvasId>)
const revision = z.number().int().nonnegative()
/** Authoritative canvas record validation. */
export const canvasSchema: z.ZodType<CanvasDocument> = z.object({
  id: canvasId, title: z.string().min(1), revision,
  nodes: z.array(z.object({
    sessionId, parentId: sessionId.nullable(), forkSeq: revision.nullable(),
    title: z.string(), x: z.number(), y: z.number(),
    collapsed: z.boolean(), mode: z.enum(['chat', 'summary']), origin: quoteOriginSchema.optional(),
  })),
})
/** Complete summary record validation, including retained versions and pending generation. */
export const summarySchema: z.ZodType<SummaryDocument> = z.object({
  sessionId, markdown: z.string(), revision, version: revision,
  versions: z.array(z.object({ revision, markdown: z.string(), kind: z.enum(['edit', 'excerpt', 'generated', 'restore']), time: z.number() })),
  excerpts: z.array(z.object({ revision, text: z.string(), turn: revision.nullable(), time: z.number() })),
  draft: z.object({ markdown: z.string(), baseRevision: revision, throughSeq: z.number().int() }).nullable(),
})
/** One versioned application-data domain; writes acknowledge backend durability. */
export const canvasDomain = defineDomain({
  name: 'session_canvas', version: 1,
  tables: {
    canvases: domainTable<CanvasId, CanvasDocument>(canvasSchema),
    summaries: domainTable<SessionId, SummaryDocument>(summarySchema),
  },
})

/**
 * Initial human-facing notes for a new node.
 * @param id - owning Session.
 * @returns an empty document with no model-visible effect.
 */
export function emptySummary(id: SessionId): SummaryDocument {
  return { sessionId: id, markdown: '', revision: 0, version: 0, versions: [], excerpts: [], draft: null }
}

/** Durable deletion intent carries identities only and resumes unfinished cleanup after restart. */
export const deletionDomain = defineDomain({
  name: 'session_canvas_deletions', version: 1,
  tables: { jobs: domainTable<CanvasId, { readonly sessionIds: readonly SessionId[] }>(
    z.object({ sessionIds: z.array(sessionId).min(1) }),
  ) },
})
