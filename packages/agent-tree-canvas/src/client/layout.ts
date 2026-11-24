/** Deterministic tree placement shared by the canvas and its tests. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { NodePlacement } from '../types.ts'

/** Rendered card dimensions in unscaled canvas pixels. */
export interface NodeSize { readonly width: number; readonly height: number }

/** A measured node retains its parent and sibling creation order. */
export interface MeasuredNode extends NodeSize {
  readonly sessionId: SessionId
  readonly parentId: SessionId | null
}

/**
 * Lay out each subtree in its own vertical band, placing parents between their children.
 * @param nodes - tree in creation order with rendered, unscaled card dimensions.
 * @returns placements with 48px between sibling subtrees and 80px between columns.
 */
export function treeLayout(nodes: readonly MeasuredNode[]): NodePlacement[] {
  const children = new Map<SessionId | null, MeasuredNode[]>()
  for (const node of nodes) {
    const list = children.get(node.parentId) ?? []
    list.push(node); children.set(node.parentId, list)
  }
  const heights = new Map<SessionId, number>()
  const widths: number[] = []
  const measure = (node: MeasuredNode, depth: number): number => {
    widths[depth] = Math.max(widths[depth] ?? 0, node.width)
    const descendants = children.get(node.sessionId) ?? []
    const childHeight = descendants.reduce((sum, child) => sum + measure(child, depth + 1), 0)
      + Math.max(0, descendants.length - 1) * 48
    const height = Math.max(node.height, childHeight)
    heights.set(node.sessionId, height)
    return height
  }
  const roots = children.get(null) ?? []
  for (const root of roots) measure(root, 0)
  const columns: number[] = []
  let left = 64
  for (const width of widths) { columns.push(left); left += width + 80 }
  const positions: NodePlacement[] = []
  const visit = (node: MeasuredNode, depth: number, top: number): void => {
    const height = heights.get(node.sessionId) as number
    positions.push({ sessionId: node.sessionId, x: columns[depth] as number, y: top + (height - node.height) / 2 })
    const descendants = children.get(node.sessionId) ?? []
    const childHeight = descendants.reduce((sum, child) => sum + (heights.get(child.sessionId) as number), 0)
      + Math.max(0, descendants.length - 1) * 48
    let next = top + (height - childHeight) / 2
    for (const child of descendants) {
      visit(child, depth + 1, next)
      next += (heights.get(child.sessionId) as number) + 48
    }
  }
  let top = 64
  for (const root of roots) { visit(root, 0, top); top += (heights.get(root.sessionId) as number) + 48 }
  return positions
}
