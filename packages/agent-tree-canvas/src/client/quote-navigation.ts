/** Follow painted text ranges without replacing React-owned text or intercepting selection. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export interface QuoteLink { readonly range: Range; readonly childId: SessionId }
export type QuoteLinks = ReadonlyMap<HTMLElement, readonly QuoteLink[]>
export interface QuotePoint { readonly x: number; readonly y: number }

/** Only inspect the message under the pointer, including each line of a wrapped selection. */
export function quoteLinksAt(root: HTMLElement, links: QuoteLinks, target: EventTarget | null, point: QuotePoint): SessionId[] {
  if (!(target instanceof Element) || !root.contains(target)
    || target.closest('a,button,input,textarea,select,[contenteditable="true"],[role="button"],[hidden]')) return []
  for (let element: HTMLElement | null = target as HTMLElement; element !== null && root.contains(element); element = element.parentElement) {
    const candidates = links.get(element)
    if (candidates === undefined) continue
    return [...new Set(candidates.filter(({ range }) => range.startContainer.isConnected
      && [...range.getClientRects()].some(rect => rect.width > 0 && rect.height > 0
        && point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom))
      .map(link => link.childId))]
  }
  return []
}

/** Hover is local DOM decoration; only an intentional click publishes a navigation request. */
export function bindQuoteNavigation(root: HTMLElement, options: {
  readonly links: () => QuoteLinks
  readonly title: (ids: readonly SessionId[]) => string
  readonly open: (ids: readonly SessionId[], point: QuotePoint) => void
}): () => void {
  let hovered: HTMLElement | null = null, previousTitle: string | null = null
  let press: { id: number; x: number; y: number; moved: boolean } | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const clearHover = (): void => {
    if (hovered === null) return
    hovered.removeAttribute('data-canvas-quote-link')
    if (previousTitle === null) hovered.removeAttribute('title')
    else hovered.setAttribute('title', previousTitle)
    hovered = null
  }
  const cancel = (): void => { clearTimeout(timer); timer = undefined; press = null; clearHover() }
  const hand = (): boolean => root.closest('[data-canvas-hand],[data-canvas-dragging]') !== null
  const hit = (event: MouseEvent): SessionId[] => quoteLinksAt(root, options.links(), event.target, { x: event.clientX, y: event.clientY })
  const move = (event: PointerEvent): void => {
    if (press !== null && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 3) press.moved = true
    if (event.buttons !== 0 || hand()) { clearHover(); return }
    const ids = hit(event), element = event.target instanceof HTMLElement ? event.target : null
    if (ids.length === 0 || element === null) { clearHover(); return }
    if (hovered !== element) {
      clearHover(); hovered = element; previousTitle = element.getAttribute('title')
      element.setAttribute('data-canvas-quote-link', '')
    }
    const title = options.title(ids)
    if (element.getAttribute('title') !== title) element.setAttribute('title', title)
  }
  const down = (event: PointerEvent): void => {
    cancel()
    if (event.button === 0 && !hand() && hit(event).length > 0) {
      press = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false }
    }
  }
  const click = (event: MouseEvent): void => {
    const start = press
    press = null
    if (start === null || start.moved || event.button !== 0 || event.detail > 1 || hand()
      || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 3
      || root.ownerDocument.getSelection()?.isCollapsed === false) return
    const ids = hit(event)
    if (ids.length === 0) return
    event.preventDefault(); event.stopPropagation()
    // Let a second click select a word rather than navigating on its first click.
    timer = setTimeout(() => {
      timer = undefined
      if (!root.isConnected || root.ownerDocument.getSelection()?.isCollapsed === false || hand()) return
      clearHover(); options.open(ids, { x: event.clientX, y: event.clientY })
    }, 240)
  }
  const leave = (): void => { clearHover(); if (press !== null) press.moved = true }
  root.addEventListener('pointermove', move)
  root.addEventListener('pointerdown', down, true)
  root.addEventListener('pointerleave', leave)
  root.addEventListener('pointercancel', cancel)
  root.addEventListener('click', click, true)
  root.ownerDocument.addEventListener('scroll', cancel, true)
  root.ownerDocument.defaultView?.addEventListener('blur', cancel)
  return () => {
    cancel()
    root.removeEventListener('pointermove', move)
    root.removeEventListener('pointerdown', down, true)
    root.removeEventListener('pointerleave', leave)
    root.removeEventListener('pointercancel', cancel)
    root.removeEventListener('click', click, true)
    root.ownerDocument.removeEventListener('scroll', cancel, true)
    root.ownerDocument.defaultView?.removeEventListener('blur', cancel)
  }
}
