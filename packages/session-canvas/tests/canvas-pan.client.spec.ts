/** Moving the viewport must not rebuild the retained conversations. */
import { createElement, useState } from 'react'
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { CanvasId, CanvasNode } from '../src/types.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CanvasState } from '../src/client/controller.ts'
import type { CanvasNavigation } from '../src/client/navigation.ts'
import { CanvasPage } from '../src/client/view.tsx'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const { createElement } = await import('react')
  const icon = () => createElement('svg')
  return {
    Button: ({ size: _size, variant: _variant, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { size?: string; variant?: string }) => createElement('button', props),
    Input: (props: object) => createElement('input', props),
    Menu: ({ anchor }: { anchor: ReactNode }) => anchor,
    Tooltip: ({ children }: { children: ReactNode }) => children,
    Modal: () => null, Toast: () => null, MarkdownText: () => null,
    IconTrashOutlineRegular: icon, IconBranchOutlineRegular: icon, IconSearchOutlineRegular: icon,
    IconChevronDownOutlineRegular: icon, IconEditOutlineRegular: icon,
  }
})

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
type PageProps = ComponentProps<typeof CanvasPage>
type Owner = Parameters<PageProps['renderSlot']>[1]

function Card({ node, onFocus }: Owner) {
  const [messages, setMessages] = useState(0)
  return createElement('article', { 'data-canvas-session': node.sessionId,
    style: { position: 'absolute', left: node.x, top: node.y }, ref: (element: HTMLElement | null) => {
      if (element === null) return
      Object.defineProperties(element, {
        offsetLeft: { configurable: true, get: () => Number.parseFloat(element.style.left) },
        offsetTop: { configurable: true, get: () => Number.parseFloat(element.style.top) },
        offsetWidth: { configurable: true, value: 560 }, offsetHeight: { configurable: true, value: 320 },
      })
    } },
  createElement('button', { onClick: onFocus }, `Focus ${node.sessionId}`),
  createElement('button', { onClick: () => setMessages(value => value + 1) }, `Update ${node.sessionId}`),
  createElement('span', { 'data-testid': node.sessionId }, messages))
}

function fixture() {
  const id = 'pan-canvas' as CanvasId
  const nodes: CanvasNode[] = Array.from({ length: 16 }, (_, index) => ({ sessionId: `node-${index}` as SessionId,
    parentId: index === 0 ? null : 'node-0' as SessionId, forkSeq: index === 0 ? null : 10,
    title: `Node ${index}`, x: index === 0 ? 80 : 720, y: index * 360, mode: 'chat', collapsed: false }))
  const state: CanvasState = { canvases: [{ id, title: 'Many conversations', nodes, revision: 1 }], activeId: id,
    loading: false, failed: false, busy: false, viewportTarget: null, fitRequest: null, mapping: null,
    summaryOnly: [], summaries: {}, drafts: {}, saveStates: {}, generating: [], sourceTarget: null, notice: null }
  let navigation!: CanvasNavigation
  const owners = new Map<SessionId, Owner>()
  const renderSlot = vi.fn((_key: string, owner: Owner) => { owners.set(owner.node.sessionId, owner); return createElement(Card, owner) })
  const props = { useCanvas: (selector: (value: CanvasState) => unknown) => selector(state), renderSlot,
    bindNavigation: (_element: HTMLElement, actions: CanvasNavigation) => { navigation = actions; return () => {} },
    t: (key: string) => key } as unknown as PageProps
  const ui = render(createElement(CanvasPage, props))
  const viewport = ui.getByLabelText('canvas'), world = ui.container.querySelector<HTMLElement>('[data-canvas-world]')!
  Object.defineProperties(viewport, { clientWidth: { value: 1200 }, clientHeight: { value: 800 } })
  return { ...ui, nodes, world, renderSlot, owners, navigation }
}

it('pans sixteen conversations without rendering their slots again, while live content keeps updating', () => {
  const f = fixture()
  expect(f.renderSlot).toHaveBeenCalledTimes(16)
  for (let step = 0; step < 20; step++) act(() => f.navigation.pan(12, -6))
  expect(f.world.style.transform).toBe('translate(240px, -120px) scale(1)')
  expect(f.renderSlot).toHaveBeenCalledTimes(16)
  fireEvent.click(screen.getByRole('button', { name: 'Update node-3' }))
  expect(screen.getByTestId('node-3').textContent).toBe('1')
  expect(f.renderSlot).toHaveBeenCalledTimes(16)
})

it('uses the current panned view when focusing and restoring a conversation', () => {
  // JSDOM omits CSS.escape; this fixture uses simple identifier-safe session IDs.
  vi.stubGlobal('CSS', { escape: (value: string) => value })
  const f = fixture()
  act(() => f.navigation.pan(140, -80))
  act(() => f.navigation.zoom(0.8, { x: 600, y: 400 }))
  const before = f.world.style.transform
  fireEvent.click(screen.getByRole('button', { name: 'Focus node-1' }))
  expect(f.world.style.transform).not.toBe(before)
  fireEvent.click(screen.getByRole('button', { name: 'Focus node-1' }))
  expect(f.world.style.transform).toBe(before)
})

it('only renders the moved conversation and updates its connector preview', () => {
  const f = fixture(), id = 'node-1' as SessionId
  const edge = f.container.querySelector('[data-canvas-edge="node-1"]')!
  const sibling = f.container.querySelector('[data-canvas-edge="node-2"]')!
  const original = edge.getAttribute('d'), untouched = sibling.getAttribute('d')
  act(() => f.owners.get(id)!.onMove(id, { x: 920, y: 480 }))
  expect(f.renderSlot).toHaveBeenCalledTimes(17)
  expect(edge.getAttribute('d')).not.toBe(original)
  expect(sibling.getAttribute('d')).toBe(untouched)
  act(() => f.owners.get(id)!.onMove(id, null))
  expect(f.renderSlot).toHaveBeenCalledTimes(18)
  expect(edge.getAttribute('d')).toBe(original)
})
