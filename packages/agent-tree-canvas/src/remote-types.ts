/** Published Remote signatures of the canvas service. */
import type {
  RemoteResult, TypertRemoteNamespaceMap,
} from '@deepseek-ai/dsh-typert-protocol'
import type { CanvasDocument, QuoteOrigin, MindmapResult, CanvasId, CanvasMode, NodePlacement, SaveSummaryRequest, SummaryDocument, UpdateNodeRequest } from '@deepseek-ai/dsh-agent-tree-canvas/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$6167656e745472656543616e766173 {
    addRoot: (canvasId: CanvasId, title: string) => Promise<RemoteResult<CanvasDocument>>
    arrange: (canvasId: CanvasId, placements: readonly NodePlacement[]) => Promise<RemoteResult<CanvasDocument>>
    create: (title: string) => Promise<RemoteResult<CanvasDocument>>
    excerpt: (sessionId: SessionId, text: string, turn: number | null) => Promise<RemoteResult<SummaryDocument>>
    fork: (canvasId: CanvasId, sessionId: SessionId, atSeq: number | null, title: string, origin?: QuoteOrigin) => Promise<RemoteResult<CanvasDocument>>
    generate: (sessionId: SessionId, signal?: AbortSignal) => Promise<RemoteResult<SummaryDocument>>
    mindmap: (canvasId: CanvasId, sessionId: SessionId, atSeq: number | null, text: string, signal?: AbortSignal) => Promise<RemoteResult<MindmapResult>>
    list: () => Promise<RemoteResult<CanvasDocument[]>>
    removeNode: (canvasId: CanvasId, sessionId: SessionId) => Promise<RemoteResult<CanvasDocument>>
    rename: (canvasId: CanvasId, title: string) => Promise<RemoteResult<CanvasDocument>>
    resolveDraft: (sessionId: SessionId, version: number, adopt: boolean) => Promise<RemoteResult<SummaryDocument>>
    restore: (sessionId: SessionId, revision: number, restoreRevision: number) => Promise<RemoteResult<SummaryDocument>>
    saveSummary: (request: SaveSummaryRequest) => Promise<RemoteResult<SummaryDocument>>
    setMode: (canvasId: CanvasId, mode: CanvasMode) => Promise<RemoteResult<CanvasDocument>>
    summary: (sessionId: SessionId) => Promise<RemoteResult<SummaryDocument>>
    updateNode: (request: UpdateNodeRequest) => Promise<RemoteResult<CanvasDocument>>
  }
  interface TypertRemoteMap {
    'agentTreeCanvas/addRoot': (canvasId: CanvasId, title: string) => Promise<RemoteResult<CanvasDocument>>
    'agentTreeCanvas/arrange': (canvasId: CanvasId, placements: readonly NodePlacement[]) => Promise<RemoteResult<CanvasDocument>>
    'agentTreeCanvas/create': (title: string) => Promise<RemoteResult<CanvasDocument>>
    'agentTreeCanvas/excerpt': (sessionId: SessionId, text: string, turn: number | null) => Promise<RemoteResult<SummaryDocument>>
    'agentTreeCanvas/fork': (canvasId: CanvasId, sessionId: SessionId, atSeq: number | null, title: string, origin?: QuoteOrigin) => Promise<RemoteResult<CanvasDocument>>
    'agentTreeCanvas/generate': (sessionId: SessionId, signal?: AbortSignal) => Promise<RemoteResult<SummaryDocument>>
    'agentTreeCanvas/mindmap': (canvasId: CanvasId, sessionId: SessionId, atSeq: number | null, text: string, signal?: AbortSignal) => Promise<RemoteResult<MindmapResult>>
    'agentTreeCanvas/list': () => Promise<RemoteResult<CanvasDocument[]>>
    'agentTreeCanvas/removeNode': (canvasId: CanvasId, sessionId: SessionId) => Promise<RemoteResult<CanvasDocument>>
    'agentTreeCanvas/rename': (canvasId: CanvasId, title: string) => Promise<RemoteResult<CanvasDocument>>
    'agentTreeCanvas/resolveDraft': (sessionId: SessionId, version: number, adopt: boolean) => Promise<RemoteResult<SummaryDocument>>
    'agentTreeCanvas/restore': (sessionId: SessionId, revision: number, restoreRevision: number) => Promise<RemoteResult<SummaryDocument>>
    'agentTreeCanvas/saveSummary': (request: SaveSummaryRequest) => Promise<RemoteResult<SummaryDocument>>
    'agentTreeCanvas/setMode': (canvasId: CanvasId, mode: CanvasMode) => Promise<RemoteResult<CanvasDocument>>
    'agentTreeCanvas/summary': (sessionId: SessionId) => Promise<RemoteResult<SummaryDocument>>
    'agentTreeCanvas/updateNode': (request: UpdateNodeRequest) => Promise<RemoteResult<CanvasDocument>>
  }
  interface TypertRemoteNamespaceMap {
    'agentTreeCanvas': TypertRemoteNamespace$6167656e745472656543616e766173
  }
}

/** Client methods available after mounting this plugin. */
export type AgentTreeCanvasRemote = TypertRemoteNamespaceMap['agentTreeCanvas']
