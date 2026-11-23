/** Learning progress belongs to the canvas, independently of conversation history. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CanvasNode } from './types.ts'
import { subtreeIds } from './subtree.ts'

/** Check the whole subtree, including descendants of collapsed or hidden nodes. */
export function hasUnlearnedDescendants(nodes: readonly CanvasNode[], sessionId: SessionId): boolean {
  const subtree = subtreeIds(nodes, sessionId)
  return nodes.some(node => node.sessionId !== sessionId && subtree.has(node.sessionId) && !node.learned)
}

/** Clear this node and its ancestors when a branch gains unfinished work. */
export function clearLearnedPath(nodes: readonly CanvasNode[], sessionId: SessionId): readonly CanvasNode[] {
  const byId = new Map(nodes.map(node => [node.sessionId, node]))
  const path = new Set<SessionId>()
  for (let id: SessionId | null = sessionId; id !== null && !path.has(id); id = byId.get(id)?.parentId ?? null) path.add(id)
  return nodes.map(node => path.has(node.sessionId) && node.learned ? { ...node, learned: false } : node)
}
