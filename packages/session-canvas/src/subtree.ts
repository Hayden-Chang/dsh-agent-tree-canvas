/** Canvas membership operations leave the underlying Sessions and notes intact. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CanvasNode } from './types.ts'

/**
 * Collect a node and all descendants, regardless of placement or array order.
 * @param nodes - current canvas membership.
 * @param sessionId - subtree root.
 * @returns ids to remove from this canvas only.
 */
export function subtreeIds(nodes: readonly CanvasNode[], sessionId: SessionId): ReadonlySet<SessionId> {
  const children = new Map<SessionId, SessionId[]>()
  for (const node of nodes) {
    if (node.parentId === null) continue
    const siblings = children.get(node.parentId) ?? []
    siblings.push(node.sessionId); children.set(node.parentId, siblings)
  }
  const result = new Set<SessionId>(), pending = [sessionId]
  for (const id of pending) {
    if (result.has(id)) continue
    result.add(id); pending.push(...children.get(id) ?? [])
  }
  return result
}
