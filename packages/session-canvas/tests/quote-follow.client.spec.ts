/** Child origins retain their color and scroll only their source card. */
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, expect, it, vi } from 'vitest'
import { CanvasController } from '../src/client/controller.ts'
import { paintQuoteOrigins } from '../src/client/quote-links.ts'
import type { CanvasDocument, CanvasId, QuoteOrigin } from '../src/types.ts'

const parent = 'parent' as SessionId, child = 'child' as SessionId, sibling = 'sibling' as SessionId
const canvasId = 'canvas' as CanvasId
const origin: QuoteOrigin = { text: 'same quote', source: { kind: 'summary', sessionId: parent, offset: 11 } }
const disposers: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function highlights() {
  const registry = new Map<string, Set<Range>>()
  vi.stubGlobal('CSS', { highlights: registry })
  vi.stubGlobal('Highlight', class extends Set<Range> { constructor(...ranges: Range[]) { super(ranges) } })
  return registry
}

function sourceRoot() {
  const root = document.createElement('div')
  root.innerHTML = '<div data-canvas-summary><div data-summary-document><p>same quote <b>same quote</b></p></div></div>'
  document.body.append(root)
  return root
}

it('paints exact repeated selections with each child tone and clears removed or hidden origins', () => {
  const registry = highlights(), root = sourceRoot(), roots = new Map([[parent, root]])
  const quotes = [{ ...origin, tone: 'red' as const, childId: child },
    { text: 'same quote', source: { ...origin.source, offset: 0 }, tone: 'orange' as const }]
  const links = paintQuoteOrigins(quotes, roots)
  const red = [...registry.get('session-canvas-quote-red')!][0]!
  expect(red.toString()).toBe('same quote')
  expect(red.startContainer.parentElement?.tagName).toBe('B')
  expect([...links.values()].flat().map(link => ({ id: link.childId, text: link.range.toString() }))).toEqual([{ id: child, text: 'same quote' }])
  expect(registry.get('session-canvas-quote-orange')?.size).toBe(1)
  expect(root.querySelector('mark')).toBeNull()
  paintQuoteOrigins(quotes.slice(1), roots)
  expect(registry.has('session-canvas-quote-red')).toBe(false)
  root.hidden = true; paintQuoteOrigins(quotes, roots)
  expect(registry.size).toBe(0)
  root.hidden = false; root.querySelector('b')!.textContent = 'edited text'
  paintQuoteOrigins([{ ...origin, text: 'missing', tone: 'red' }], roots)
  expect(registry.size).toBe(0)
})

it('paints the visible chat response when a hidden process row has the same sequence', () => {
  const registry = highlights(), root = sourceRoot()
  root.innerHTML = '<div hidden><div data-chat-seq="6"></div></div><div data-chat-seq="6"><p data-text-interaction-source>same quote</p></div>'
  paintQuoteOrigins([{ text: 'same quote', source: { sessionId: parent, seq: 6, turn: 1, offset: 0 }, tone: 'red' }], new Map([[parent, root]]))
  expect(registry.get('session-canvas-quote-red')?.size).toBe(1)
  expect([...registry.get('session-canvas-quote-red')!][0]!.toString()).toBe('same quote')
  root.innerHTML = '<div data-chat-seq="6" data-chat-group-part="reasoning"><p data-text-interaction-source>same quote</p></div><div data-chat-seq="6" data-chat-group-part="response"><p data-text-interaction-source>same quote</p></div>'
  paintQuoteOrigins([{ text: 'same quote', source: { sessionId: parent, seq: 6, turn: 1, offset: 0 }, tone: 'red' }], new Map([[parent, root]]))
  expect([...registry.get('session-canvas-quote-red')!][0]!.startContainer.parentElement?.closest('[data-chat-group-part]')?.getAttribute('data-chat-group-part')).toBe('response')
})

it('paints and removes source overlays when the browser has no Custom Highlight API', () => {
  vi.stubGlobal('CSS', {}); vi.stubGlobal('Highlight', undefined)
  const root = sourceRoot(), source = root.querySelector<HTMLElement>('[data-summary-document]')!
  Object.defineProperty(source, 'offsetWidth', { value: 200 })
  vi.spyOn(source, 'getBoundingClientRect').mockReturnValue({ left: 20, top: 30, width: 100, height: 80 } as DOMRect)
  if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([{ left: 30, top: 40, width: 40, height: 10 }] as unknown as DOMRectList)
  const quote = { ...origin, tone: 'red' as const }, roots = new Map([[parent, root]])
  const text = source.textContent
  paintQuoteOrigins([quote], roots)
  const overlay = source.querySelector<HTMLElement>('[data-canvas-quote-overlay]')!
  expect(overlay).not.toBeNull()
  expect(overlay.getAttribute('aria-hidden')).toBe('true')
  expect(overlay.querySelector<HTMLElement>('[data-quote-tone="red"]')?.style.left).toBe('20px')
  expect(overlay.querySelector<HTMLElement>('[data-quote-tone="red"]')?.style.width).toBe('80px')
  expect(source.textContent).toBe(text)
  paintQuoteOrigins([quote], roots)
  expect(source.querySelector('[data-canvas-quote-overlay]')).toBe(overlay)
  paintQuoteOrigins([], roots)
  expect(source.querySelector('[data-canvas-quote-overlay]')).toBeNull()
})

function fixture(savedOrigin: QuoteOrigin = origin) {
  highlights()
  const ctx = new Context(), inputState = createSnapshotStore({ draft: '', occurrences: [], draftRev: 0 })
  let canvas: CanvasDocument = { id: canvasId, title: 'Colors', revision: 1, nodes: [
    { sessionId: parent, parentId: null, forkSeq: null, title: 'Parent', x: 0, y: 0, mode: 'summary', collapsed: true },
    { sessionId: child, parentId: parent, forkSeq: 8, title: 'Child', x: 640, y: 0, mode: 'chat', collapsed: false, origin: savedOrigin },
    { sessionId: sibling, parentId: parent, forkSeq: null, title: 'Sibling', x: 640, y: 700, mode: 'chat', collapsed: false },
  ] }
  const updateNode = vi.fn(async (request: { sessionId: SessionId; mode: 'chat' | 'summary'; collapsed: boolean }) => {
    canvas = { ...canvas, revision: canvas.revision + 1, nodes: canvas.nodes.map(node => node.sessionId === request.sessionId ? { ...node, ...request } : node) }
    return { ok: true, value: canvas }
  })
  ctx.provide('remote', { sessionCanvas: { updateNode } } as never)
  ctx.provide('conversation', { input: { for: () => ({ state: inputState }) } } as never)
  const loadThrough = vi.fn(async () => {})
  const binding = { ctx, session: { loadThrough, projections: { faceOf: () => ({ getSnapshot: () => ({ messages: [], turns: [] }) }) } } }
  ctx.provide('sessions', { binding: () => binding,
    using: async (_id: SessionId, _options: unknown, action: (reference: unknown) => Promise<void>) => action({ ready: Promise.resolve(binding) }),
  } as never)
  ctx.provide('uiConversation', { binding: () => ({ target: () => ({ getSnapshot: () => ({ nodes: new Map() }) }) }) } as never)
  ctx.provide('locale', { bind: () => (key: string) => key } as never)
  const controller = new CanvasController(ctx, () => {}, 400)
  controller.source.set({ ...controller.source.getSnapshot(), canvases: [canvas], activeId: canvasId })
  const root = sourceRoot(), scroll = root.firstElementChild as HTMLElement
  Object.defineProperty(scroll, 'offsetHeight', { value: 200 })
  vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue({ top: 0, height: 200 } as DOMRect)
  vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue({ top: 1000, height: 20 } as DOMRect)
  controller.face.registerSourceRoot(parent, root)
  const composer = document.createElement('textarea'); document.body.append(composer); composer.focus()
  disposers.push(async () => { await controller.dispose(); await ctx.fiber.dispose() })
  return { ctx, controller, updateNode, root, scroll, composer, loadThrough }
}

it('follows a summary child after its draft is cleared without moving the canvas or stealing focus', async () => {
  // jsdom has no range geometry; the fixture supplies the browser's measured result.
  if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => ({} as DOMRect)
  const f = fixture()
  f.controller.face.followParent(child)
  await vi.waitFor(() => { expect(f.scroll.scrollTop).toBe(910) })
  expect(f.updateNode).toHaveBeenCalledWith({ canvasId, sessionId: parent, mode: 'summary', collapsed: false })
  expect(document.activeElement).toBe(f.composer)
  expect(f.controller.source.getSnapshot().viewportTarget).toBeNull()
  expect(f.root.querySelector('[data-canvas-quote-source]')?.getAttribute('style')).toContain('--dsw-alias-diagram-red')
  f.controller.face.followParent(parent); f.controller.face.followParent(sibling)
  expect(f.updateNode).toHaveBeenCalledTimes(1)
  f.controller.face.registerSourceRoot(parent, null)
  expect(CSS.highlights.size).toBe(0)
})

it('loads the exact chat source before following a child and preserves explicit quote navigation', async () => {
  if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => ({} as DOMRect)
  const f = fixture({ text: 'same quote', source: { sessionId: parent, seq: 6, turn: 1, offset: 0 } })
  f.root.innerHTML = '<div data-chat-scroll><div data-chat-seq="6"><p data-text-interaction-source>same quote</p></div></div>'
  f.controller.face.followParent(child)
  await vi.waitFor(() => { expect(f.root.querySelector('[data-canvas-quote-source]')).not.toBeNull() })
  expect(f.loadThrough).toHaveBeenCalledWith(6)
  expect(document.activeElement).toBe(f.composer)
  expect(f.controller.source.getSnapshot().viewportTarget).toBeNull()
  expect(f.controller.openReference(child, 'same quote', { sessionId: parent, seq: 6, turn: 1, offset: 0 })).toBe(true)
  await vi.waitFor(() => { expect(f.controller.source.getSnapshot().viewportTarget?.sessionId).toBe(parent) })
  expect(document.activeElement).toBe(f.root.querySelector('[data-chat-seq]'))
  expect(f.root.querySelector('[data-chat-seq]')?.getAttribute('style')).toContain('--dsw-alias-diagram-red')
  expect(f.controller.openReference(child, 'missing', { ...origin.source, sessionId: 'absent' as SessionId })).toBe(false)
})

it('opens the exact child, expands it when collapsed, and invalidates pending parent navigation', async () => {
  if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => ({} as DOMRect)
  const f = fixture()
  const state = f.controller.source.getSnapshot()
  f.controller.source.set({ ...state, canvases: state.canvases.map(canvas => ({ ...canvas,
    nodes: canvas.nodes.map(node => node.sessionId === child ? { ...node, collapsed: true } : node) })) })
  f.controller.face.openChild(child)
  await vi.waitFor(() => { expect(f.controller.source.getSnapshot().viewportTarget).toMatchObject({ sessionId: child, focus: true }) })
  expect(f.updateNode).toHaveBeenCalledExactlyOnceWith({ canvasId, sessionId: child, collapsed: false })
  const updated = f.controller.source.getSnapshot().canvases[0]!
  const pending = Promise.withResolvers<{ ok: boolean; value: CanvasDocument }>()
  f.updateNode.mockReturnValueOnce(pending.promise as never)
  f.controller.face.followParent(child)
  f.controller.face.openChild(sibling)
  await vi.waitFor(() => { expect(f.controller.source.getSnapshot().viewportTarget?.sessionId).toBe(sibling) })
  pending.resolve({ ok: true, value: updated })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(f.controller.source.getSnapshot().sourceTarget).toBeNull()
  expect(f.controller.source.getSnapshot().viewportTarget?.sessionId).toBe(sibling)
  expect(f.scroll.scrollTop).toBe(0)
})

it('follows the visible chat response instead of the hidden duplicate emitted by the stock renderer', async () => {
  if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => ({} as DOMRect)
  const f = fixture({ text: 'same quote', source: { sessionId: parent, seq: 6, turn: 1, offset: 0 } })
  f.root.innerHTML = '<div data-chat-scroll><div hidden><div data-chat-seq="6"></div></div><div data-chat-seq="6"><p data-text-interaction-source>same quote</p></div></div>'
  const scroll = f.root.firstElementChild as HTMLElement
  Object.defineProperty(scroll, 'offsetHeight', { value: 200 })
  vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue({ top: 0, height: 200 } as DOMRect)
  f.controller.face.followParent(child)
  await vi.waitFor(() => { expect(scroll.scrollTop).toBe(910) })
  expect(f.root.querySelector('[data-canvas-quote-source]')?.closest('[hidden]')).toBeNull()
  expect(document.activeElement).toBe(f.composer)
  expect(f.controller.source.getSnapshot().viewportTarget).toBeNull()
})
