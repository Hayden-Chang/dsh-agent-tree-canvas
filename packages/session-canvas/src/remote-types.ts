/** Published Remote signatures of the canvas service. */
import type {
  RemoteResult, TypertRemoteNamespaceMap,
} from '@deepseek-ai/dsh-typert-protocol'
import type { CanvasDocument, MindmapResult, CanvasId, CanvasMode, NodePlacement, SaveSummaryRequest, SummaryDocument, UpdateNodeRequest } from '@deepseek-ai/dsh-session-canvas/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$73657373696f6e43616e766173 {
    addRoot: (canvasId: CanvasId, title: string) => Promise<RemoteResult<CanvasDocument>>
    arrange: (canvasId: CanvasId, placements: readonly NodePlacement[]) => Promise<RemoteResult<CanvasDocument>>
    create: (title: string) => Promise<RemoteResult<CanvasDocument>>
    excerpt: (sessionId: SessionId, text: string, turn: number | null) => Promise<RemoteResult<SummaryDocument>>
    fork: (canvasId: CanvasId, sessionId: SessionId, atSeq: number | null, title: string) => Promise<RemoteResult<CanvasDocument>>
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
    'sessionCanvas/addRoot': (canvasId: CanvasId, title: string) => Promise<RemoteResult<CanvasDocument>>
    'sessionCanvas/arrange': (canvasId: CanvasId, placements: readonly NodePlacement[]) => Promise<RemoteResult<CanvasDocument>>
    'sessionCanvas/create': (title: string) => Promise<RemoteResult<CanvasDocument>>
    'sessionCanvas/excerpt': (sessionId: SessionId, text: string, turn: number | null) => Promise<RemoteResult<SummaryDocument>>
    'sessionCanvas/fork': (canvasId: CanvasId, sessionId: SessionId, atSeq: number | null, title: string) => Promise<RemoteResult<CanvasDocument>>
    'sessionCanvas/generate': (sessionId: SessionId, signal?: AbortSignal) => Promise<RemoteResult<SummaryDocument>>
    'sessionCanvas/mindmap': (canvasId: CanvasId, sessionId: SessionId, atSeq: number | null, text: string, signal?: AbortSignal) => Promise<RemoteResult<MindmapResult>>
    'sessionCanvas/list': () => Promise<RemoteResult<CanvasDocument[]>>
    'sessionCanvas/removeNode': (canvasId: CanvasId, sessionId: SessionId) => Promise<RemoteResult<CanvasDocument>>
    'sessionCanvas/rename': (canvasId: CanvasId, title: string) => Promise<RemoteResult<CanvasDocument>>
    'sessionCanvas/resolveDraft': (sessionId: SessionId, version: number, adopt: boolean) => Promise<RemoteResult<SummaryDocument>>
    'sessionCanvas/restore': (sessionId: SessionId, revision: number, restoreRevision: number) => Promise<RemoteResult<SummaryDocument>>
    'sessionCanvas/saveSummary': (request: SaveSummaryRequest) => Promise<RemoteResult<SummaryDocument>>
    'sessionCanvas/setMode': (canvasId: CanvasId, mode: CanvasMode) => Promise<RemoteResult<CanvasDocument>>
    'sessionCanvas/summary': (sessionId: SessionId) => Promise<RemoteResult<SummaryDocument>>
    'sessionCanvas/updateNode': (request: UpdateNodeRequest) => Promise<RemoteResult<CanvasDocument>>
  }
  interface TypertRemoteNamespaceMap {
    'sessionCanvas': TypertRemoteNamespace$73657373696f6e43616e766173
  }
}

/** Client methods available after mounting this plugin. */
export type SessionCanvasRemote = TypertRemoteNamespaceMap['sessionCanvas']
