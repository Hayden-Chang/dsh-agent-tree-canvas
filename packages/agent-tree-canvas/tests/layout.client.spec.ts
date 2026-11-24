/** Tree layout keeps sibling subtrees apart in stable creation order. */
import { expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CanvasNode } from '../src/types.ts'
import { treeLayout } from '../src/client/layout.ts'
import type { NodeSize } from '../src/client/layout.ts'
import { branchAppearance } from '../src/client/appearance.ts'

function node(id: string, parent: string | null, height = 300): CanvasNode & NodeSize {
  return { sessionId: id as SessionId, parentId: parent as SessionId | null, forkSeq: parent === null ? null : 5, title: id, x: 0, y: 0, mode: 'chat', collapsed: false, width: 560, height }
}

it('places a parent between child subtrees and separates independent roots', () => {
  const positions = treeLayout([node('A', null), node('B', 'A'), node('C', 'A'), node('D', 'B'), node('E', null)])
  const byId = Object.fromEntries(positions.map(value => [value.sessionId, value]))
  expect(positions).toHaveLength(5)
  expect(byId.B!.x).toBeGreaterThan(byId.A!.x)
  expect(byId.D!.x).toBeGreaterThan(byId.B!.x)
  expect(byId.C!.y - byId.B!.y).toBe(348)
  expect(byId.A!.y).toBe((byId.B!.y + byId.C!.y) / 2)
  expect(byId.E!.y).toBeGreaterThan(byId.C!.y)
})

it('packs unequal summaries without overlapping a tall parent or neighboring subtree', () => {
  const nodes = [node('A', null, 100), node('B', 'A', 500), node('C', 'A', 80),
    node('D', 'B', 40), node('E', 'B', 60), node('F', null, 200)]
  const byId = Object.fromEntries(treeLayout(nodes).map(value => [value.sessionId, value]))
  expect(byId.C!.y - (byId.B!.y + 500)).toBe(48)
  expect(byId.E!.y - (byId.D!.y + 40)).toBe(48)
  expect(byId.B!.y + 250).toBe((byId.D!.y + byId.E!.y + 60) / 2)
  expect(byId.F!.y - (byId.C!.y + 80)).toBe(48)
  expect(treeLayout([])).toEqual([])
})

it('uses measured column widths and grows the occupied band when a summary grows', () => {
  const nodes = [node('A', null, 90), { ...node('B', 'A', 60), width: 720 }, node('C', 'A', 60), node('D', 'B', 40)]
  const before = Object.fromEntries(treeLayout(nodes).map(value => [value.sessionId, value]))
  const after = Object.fromEntries(treeLayout(nodes.map(value => value.sessionId === 'B' ? { ...value, height: 400 } : value)).map(value => [value.sessionId, value]))
  expect(before.D!.x - before.B!.x).toBe(800)
  expect(after.C!.y - before.C!.y).toBe(340)
  expect(nodes.every(value => value.x === 0 && value.y === 0)).toBe(true)
})

it('keeps descendants in their main branch color independently of position or collapse', () => {
  const nodes = [node('A', null), node('B', 'A'), node('C', 'A'), node('D', 'B'), node('E', 'D'), node('F', null)]
  const colors = branchAppearance(nodes)
  expect(colors.get('A' as SessionId)).toEqual({ tone: 'root', level: 'root' })
  expect(colors.get('F' as SessionId)).toEqual(colors.get('A' as SessionId))
  expect(colors.get('B' as SessionId)?.tone).not.toBe(colors.get('C' as SessionId)?.tone)
  expect(colors.get('D' as SessionId)).toEqual({ tone: colors.get('B' as SessionId)?.tone, level: 'leaf' })
  expect(colors.get('E' as SessionId)).toEqual(colors.get('D' as SessionId))
  expect(branchAppearance(nodes.map(value => ({ ...value, x: 500, y: 800, collapsed: true })))).toEqual(colors)
})

it('cycles the six branch colors while retaining sibling creation order', () => {
  const nodes = [node('A', null), ...Array.from({ length: 7 }, (_, index) => node(String(index), 'A'))]
  const colors = branchAppearance(nodes)
  expect(new Set(nodes.slice(1, 7).map(value => colors.get(value.sessionId)?.tone)).size).toBe(6)
  expect(colors.get('0' as SessionId)).toEqual(colors.get('6' as SessionId))
})
