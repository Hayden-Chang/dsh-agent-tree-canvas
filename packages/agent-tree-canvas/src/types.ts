/** Browser-safe Agent tree canvas documents and command payloads. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionProjectionSummaryExcluded } from '@deepseek-ai/dsh-session-projection/types'

/** Durable canvas identity. */
export type CanvasId = Branded<'CanvasId'>
/** Independent presentation choice for a Session node. */
export type CanvasMode = 'chat' | 'summary'
/** A literal selection's address in a rendered message or human summary. */
export interface DraftQuoteSource {
  readonly sessionId: SessionId
  readonly seq: number
  readonly turn: number
  readonly offset: number
}
export interface SummaryQuoteSource {
  readonly kind: 'summary'
  readonly sessionId: SessionId
  readonly offset: number
}
export type QuoteSource = DraftQuoteSource | SummaryQuoteSource
/** The selection that created a child, retained independently of its input draft. */
export interface QuoteOrigin {
  readonly text: string
  readonly source: QuoteSource
}
/** A Session's placement and immutable fork origin. */
export interface CanvasNode {
  readonly sessionId: SessionId
  readonly parentId: SessionId | null
  readonly forkSeq: number | null
  readonly title: string
  readonly x: number
  readonly y: number
  readonly collapsed: boolean
  readonly mode: CanvasMode
  /** User-confirmed learning completion; older nodes without this field are unfinished. */
  readonly learned?: boolean
  readonly origin?: QuoteOrigin
}
/** One durable tree, including its presentation preferences. */
export interface CanvasDocument {
  readonly id: CanvasId
  readonly title: string
  readonly nodes: readonly CanvasNode[]
  readonly revision: number
}
/** A successful generation either attaches nodes or leaves the canvas unchanged. */
export interface MindmapResult {
  readonly canvas: CanvasDocument
  readonly createdSessionIds: readonly SessionId[]
}
/** A saved summary revision; restoration creates another revision. */
export interface SummaryVersion {
  readonly revision: number
  readonly markdown: string
  readonly kind: 'edit' | 'excerpt' | 'generated' | 'restore'
  readonly time: number
}
/** A verbatim excerpt's source within the Session. */
export interface SummaryExcerpt {
  readonly revision: number
  readonly text: string
  readonly turn: number | null
  readonly time: number
}
/** Human notes never participate in the Session model surface. */
export interface SummaryDocument {
  readonly version: number
  readonly sessionId: SessionId
  readonly markdown: string
  readonly revision: number
  readonly versions: readonly SummaryVersion[]
  readonly excerpts: readonly SummaryExcerpt[]
  readonly draft: { readonly markdown: string; readonly baseRevision: number; readonly throughSeq: number } | null
}
/** Durable text messages used by auxiliary summarization. */
export interface CanvasMessage {
  readonly seq: number
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly inherited: boolean
}
/** Whole-history facts, independent of browser history pagination. */
export interface CanvasTranscript {
  readonly inheritedEventCount: number
  /** Latest title owned by this Session, excluding titles copied from its parent. */
  readonly title?: string
  readonly messages: readonly CanvasMessage[]
  readonly turns: readonly { readonly turn: number; readonly seq: number }[]
}
/** One node's persisted layout update. */
export interface NodePlacement {
  readonly sessionId: SessionId
  readonly x: number
  readonly y: number
}
/** Presentation-only mutation; omitted fields retain their previous values. */
export interface UpdateNodeRequest {
  readonly canvasId: CanvasId
  readonly sessionId: SessionId
  readonly title?: string
  readonly collapsed?: boolean
  readonly mode?: CanvasMode
  readonly learned?: boolean
}
/** Optimistic summary write; a stale revision preserves the current saved text. */
export interface SaveSummaryRequest {
  readonly sessionId: SessionId
  readonly revision: number
  readonly markdown: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Complete conversation text and completed fork points, omitted from list summaries. */
    agentTreeCanvas: SessionProjectionSummaryExcluded<CanvasTranscript>
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The current carrier cannot safely release or purge the selected Sessions. */
    'canvas/delete-unavailable': Record<never, never>
    /** Preflight failed before deletion intent was recorded; no node data was deleted. */
    'canvas/delete-not-started': Record<never, never>
    /** Durable deletion is incomplete; retry resumes cleanup instead of restoring removed data. */
    'canvas/delete-failed': Record<never, never>
    /** A Session with durable deletion intent cannot accept new writes or inference. */
    'canvas/deleting': Record<never, never>
    /** The canvas command could not be applied; current data remains available. */
    'canvas/invalid': { readonly reason: string }
    /** A parent cannot be marked learned while any descendant remains unfinished. */
    'canvas/unfinished-children': { readonly sessionId: SessionId }
    /** A newer edit exists; retain the caller's unsaved draft. */
    'canvas/conflict': { readonly revision: number }
    /** The Session exists independently and can be recovered from the Session list. */
    'canvas/attach-failed': { readonly sessionId: SessionId }
    /** Another summary request for this Session is still running. */
    'canvas/busy': { readonly sessionId: SessionId }
    /** The selected provider or model is unavailable; no inference was dispatched. */
    'canvas/model-unavailable': { readonly provider: string; readonly model: string }
    /** No partial subtree is published; unattached Sessions remain available. */
    'canvas/mindmap-failed': { readonly sessionIds: readonly SessionId[] }
    /** Auxiliary inference failed without changing the saved summary. */
    'canvas/summary-failed': { readonly reason: string }
  }
}
