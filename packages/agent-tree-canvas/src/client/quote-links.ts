/** Paint child origins without rewriting Markdown or its editable DOM. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { QuoteOrigin } from '../types.ts'
import type { NodeAppearance } from './appearance.ts'
import { quoteRange, visibleSourceRow } from './quote-highlight.ts'
import type { QuoteLink, QuoteLinks } from './quote-navigation.ts'

export interface ColoredQuote extends QuoteOrigin {
  readonly tone: NodeAppearance['tone']
  readonly childId?: SessionId
}
const tones = ['root', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const

interface ColoredRange { readonly range: Range; readonly tone: NodeAppearance['tone'] }
interface Overlay {
  readonly element: HTMLElement
  ranges: readonly ColoredRange[]
  signature: string
  readonly dispose: () => void
}
const overlays = new Map<HTMLElement, Overlay>()

/** Non-interactive rectangles preserve React's text nodes, selection offsets, and editable content. */
function drawOverlay(root: HTMLElement, overlay: Overlay): void {
  const bounds = root.getBoundingClientRect(), scale = bounds.width / root.offsetWidth
  if (!(scale > 0)) return
  const rectangles = overlay.ranges.flatMap(({ range, tone }) => [...range.getClientRects()].flatMap(rect => {
    let left = rect.left, top = rect.top, right = rect.left + rect.width, bottom = rect.top + rect.height
    // Clip nested code/other scrollports as native text highlights would be clipped.
    let ancestor = range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement
    for (; ancestor !== null && ancestor !== root; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor), clip = ancestor.getBoundingClientRect()
      if (/(auto|scroll|hidden|clip)/u.test(style.overflowX)) { left = Math.max(left, clip.left); right = Math.min(right, clip.right) }
      if (/(auto|scroll|hidden|clip)/u.test(style.overflowY)) { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom) }
    }
    return right > left && bottom > top ? [{ tone, left: (left - bounds.left) / scale - root.clientLeft + root.scrollLeft,
      top: (top - bounds.top) / scale - root.clientTop + root.scrollTop, width: (right - left) / scale, height: (bottom - top) / scale }] : []
  }))
  const signature = JSON.stringify(rectangles)
  if (overlay.signature === signature && overlay.element.parentElement === root) return
  overlay.signature = signature
  overlay.element.replaceChildren(...rectangles.map(rect => {
    const mark = root.ownerDocument.createElement('span')
    mark.dataset.quoteTone = rect.tone
    Object.assign(mark.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
      backgroundColor: `color-mix(in srgb, var(--dsw-alias-diagram-${rect.tone}) 35%, transparent)` })
    return mark
  }))
  root.setAttribute('data-canvas-quote-host', '')
  if (overlay.element.parentElement !== root) root.append(overlay.element)
}

function paintOverlays(groups: ReadonlyMap<HTMLElement, readonly ColoredRange[]>): void {
  for (const [root, overlay] of overlays) {
    if (groups.has(root)) continue
    overlay.dispose(); overlay.element.remove(); root.removeAttribute('data-canvas-quote-host'); overlays.delete(root)
  }
  for (const [root, ranges] of groups) {
    let overlay = overlays.get(root)
    if (overlay === undefined) {
      const element = root.ownerDocument.createElement('div')
      element.setAttribute('data-canvas-quote-overlay', ''); element.setAttribute('aria-hidden', 'true')
      const redraw = (): void => { const current = overlays.get(root); if (current !== undefined) drawOverlay(root, current) }
      const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(redraw)
      observer?.observe(root)
      root.addEventListener('scroll', redraw, true); window.addEventListener('resize', redraw)
      overlay = { element, ranges, signature: '', dispose: () => {
        observer?.disconnect(); root.removeEventListener('scroll', redraw, true); window.removeEventListener('resize', redraw)
      } }
      overlays.set(root, overlay)
    }
    overlay.ranges = ranges
    drawOverlay(root, overlay)
  }
}

/** Rebuild ranges after text rendering, mode changes, branch removal, or draft recovery. */
export function paintQuoteOrigins(quotes: readonly ColoredQuote[], roots: ReadonlyMap<SessionId, HTMLElement>): QuoteLinks {
  const native = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined'
  const groups = new Map<string, Range[]>()
  const fallback = new Map<HTMLElement, ColoredRange[]>()
  const links = new Map<HTMLElement, QuoteLink[]>()
  for (const { text, source, tone, childId } of quotes) {
    const root = roots.get(source.sessionId)
    const row = visibleSourceRow(root, 'kind' in source ? '[data-summary-document]'
      : `[data-chat-seq="${source.seq}"]`, { text, offset: source.offset })
    if (row == null || row.closest('[hidden]') !== null) continue
    const message = row.querySelector<HTMLElement>('[data-text-interaction-source]') ?? row
    const range = quoteRange(message, text, source.offset)
    if (range === undefined) continue
    if (childId !== undefined) {
      const entries = links.get(message) ?? []
      entries.push({ range, childId }); links.set(message, entries)
    }
    const ranges = groups.get(tone) ?? []
    ranges.push(range); groups.set(tone, ranges)
    if (!native) {
      const items = fallback.get(message) ?? []
      items.push({ range, tone }); fallback.set(message, items)
    }
  }
  paintOverlays(fallback)
  if (!native) return links
  for (const tone of tones) {
    const name = `agent-tree-canvas-quote-${tone}`, ranges = groups.get(tone)
    if (ranges?.length) CSS.highlights.set(name, new Highlight(...ranges))
    else CSS.highlights.delete(name)
  }
  return links
}
