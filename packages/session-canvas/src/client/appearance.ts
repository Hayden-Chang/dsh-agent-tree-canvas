/** Branch colors and node silhouettes derived from the canvas tree. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CanvasNode } from '../types.ts'

const BRANCH_TONES = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const

/** Presentation shared by a node and its incoming branch. */
export interface NodeAppearance {
  readonly tone: 'root' | typeof BRANCH_TONES[number]
  readonly level: 'root' | 'branch' | 'leaf'
}

/**
 * Assign each main branch a color that its descendants retain; moving nodes does not change it.
 * @param nodes - canvas tree in persisted creation order.
 * @returns node appearances keyed by Session identity.
 */
export function branchAppearance(nodes: readonly CanvasNode[]): ReadonlyMap<SessionId, NodeAppearance> {
  const children = new Map<SessionId | null, CanvasNode[]>()
  const result = new Map<SessionId, NodeAppearance>()
  for (const node of nodes) {
    const siblings = children.get(node.parentId) ?? []
    siblings.push(node)
    children.set(node.parentId, siblings)
  }
  const visit = (node: CanvasNode, appearance: NodeAppearance): void => {
    result.set(node.sessionId, appearance)
    for (const [index, child] of (children.get(node.sessionId) ?? []).entries()) {
      const branchTone = BRANCH_TONES[index % BRANCH_TONES.length] as typeof BRANCH_TONES[number]
      visit(child, { tone: appearance.level === 'root' ? branchTone : appearance.tone,
        level: appearance.level === 'root' ? 'branch' : 'leaf' })
    }
  }
  for (const root of children.get(null) ?? []) visit(root, { tone: 'root', level: 'root' })
  return result
}
