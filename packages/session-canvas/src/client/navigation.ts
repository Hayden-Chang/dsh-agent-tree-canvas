/** Desktop canvas gestures with native ownership for nested text and scrolling. */
import type { ZoomOptions } from '../zoom-options.ts'
import type { ZoomChange } from './zoom.ts'

/** View operations owned by the mounted canvas. */
export interface CanvasNavigation {
  readonly zoom: ZoomChange
  readonly pan: (x: number, y: number) => void
  readonly step: (direction: 1 | -1) => void
  readonly actualSize: () => void
}

function editable(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]') !== null
}

function nativeScroll(target: EventTarget | null, viewport: HTMLElement): boolean {
  if (!(target instanceof Element)) return false
  if (editable(target) || target.closest('[data-canvas-navigation]')) return true
  for (let node: Element | null = target; node !== null && node !== viewport; node = node.parentElement) {
    const style = getComputedStyle(node)
    if ((/(auto|scroll)/u.test(style.overflowY) && node.scrollHeight > node.clientHeight)
      || (/(auto|scroll)/u.test(style.overflowX) && node.scrollWidth > node.clientWidth)) return true
  }
  return false
}

/**
 * Bind direct wheel/pinch zoom, wheel pan, background/right/middle/Space drag, and scale shortcuts.
 * @param element - mounted canvas viewport; descendants retain text selection and scroll ownership.
 * @param options - validated wheel and pinch gains.
 * @param actions - current viewport operations; callbacks receive incremental movement.
 * @returns disposer releasing listeners and pointer capture.
 */
export function bindCanvasNavigation(element: HTMLElement, options: ZoomOptions, actions: CanvasNavigation): () => void {
  const document = element.ownerDocument
  const view = document.defaultView
  if (view === null) throw new Error('session-canvas: navigation requires a mounted browser document')
  let control = false, space = false, suppressContext = false
  let drag: { id: number; button: number; x: number; y: number; moved: boolean } | null = null
  const stop = (): void => {
    const current = drag
    drag = null
    if (current !== null && element.hasPointerCapture(current.id)) element.releasePointerCapture(current.id)
    delete element.dataset.canvasDragging
  }
  const reset = (): void => {
    stop(); control = false; space = false; suppressContext = false
    delete element.dataset.canvasHand
  }
  const wheel = (event: WheelEvent): void => {
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? Number.parseFloat(getComputedStyle(element).lineHeight) || 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? element.clientHeight : 1
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault(); event.stopPropagation()
      const pinch = event.ctrlKey && !event.metaKey && !control && event.deltaMode === WheelEvent.DOM_DELTA_PIXEL
      const gain = pinch ? options.pinchSensitivity : options.wheelSensitivity
      const bounds = element.getBoundingClientRect()
      actions.zoom(Math.exp(-event.deltaY * unit * gain), { x: event.clientX - bounds.left, y: event.clientY - bounds.top })
    } else if (!nativeScroll(event.target, element)) {
      event.preventDefault(); event.stopPropagation()
      actions.pan(-(event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX) * unit,
        -(event.shiftKey && event.deltaX === 0 ? 0 : event.deltaY) * unit)
    }
  }
  const pointerDown = (event: PointerEvent): void => {
    if (!(event.target instanceof Element) || event.target.closest('[data-canvas-navigation]') || editable(event.target)) return
    const background = event.target.closest('[data-canvas-session], button, a, [role="button"]') === null
    if (!(event.button === 2 || event.button === 1 || (event.button === 0 && (space || background)))) return
    suppressContext = false
    drag = { id: event.pointerId, button: event.button, x: event.clientX, y: event.clientY, moved: false }
    if (event.button !== 2) {
      event.preventDefault(); event.stopPropagation()
      element.focus({ preventScroll: true })
    }
  }
  const pointerMove = (event: PointerEvent): void => {
    if (drag === null || drag.id !== event.pointerId) return
    const x = event.clientX - drag.x, y = event.clientY - drag.y
    if (!drag.moved && Math.hypot(x, y) < 3) return
    if (!drag.moved) {
      element.setPointerCapture(event.pointerId)
      drag.moved = true
      element.dataset.canvasDragging = ''
    }
    if (drag.button === 2) suppressContext = true
    event.preventDefault(); event.stopPropagation()
    actions.pan(x, y)
    drag.x = event.clientX; drag.y = event.clientY
  }
  const pointerUp = (event: PointerEvent): void => {
    if (drag?.id !== event.pointerId) return
    if (drag.moved) { event.preventDefault(); event.stopPropagation() }
    stop()
  }
  const contextMenu = (event: MouseEvent): void => {
    if (!suppressContext) return
    event.preventDefault(); event.stopPropagation(); suppressContext = false
  }
  const keyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Control') control = true
    if (event.isComposing || editable(event.target) || !(event.target instanceof Node) || !element.contains(event.target)) return
    if (event.code === 'Space' && !(event.target instanceof Element && event.target.closest('button, [role="button"]'))) {
      event.preventDefault(); space = true; element.dataset.canvasHand = ''
    }
    if (!event.metaKey && !event.ctrlKey) return
    if (event.key === '+' || event.key === '=') actions.step(1)
    else if (event.key === '-') actions.step(-1)
    else if (event.key === '0') actions.actualSize()
    else return
    event.preventDefault(); event.stopPropagation()
  }
  const keyUp = (event: KeyboardEvent): void => {
    if (event.key === 'Control') control = false
    if (event.code === 'Space') { space = false; delete element.dataset.canvasHand }
  }
  element.addEventListener('wheel', wheel, { passive: false })
  element.addEventListener('pointerdown', pointerDown, true)
  element.addEventListener('contextmenu', contextMenu, true)
  element.addEventListener('lostpointercapture', stop)
  document.addEventListener('pointermove', pointerMove, true)
  document.addEventListener('pointerup', pointerUp, true)
  document.addEventListener('pointercancel', stop)
  document.addEventListener('keydown', keyDown, true)
  document.addEventListener('keyup', keyUp, true)
  view.addEventListener('blur', reset)
  return () => {
    element.removeEventListener('wheel', wheel)
    element.removeEventListener('pointerdown', pointerDown, true)
    element.removeEventListener('contextmenu', contextMenu, true)
    element.removeEventListener('lostpointercapture', stop)
    document.removeEventListener('pointermove', pointerMove, true)
    document.removeEventListener('pointerup', pointerUp, true)
    document.removeEventListener('pointercancel', stop)
    document.removeEventListener('keydown', keyDown, true)
    document.removeEventListener('keyup', keyUp, true)
    view.removeEventListener('blur', reset)
    reset()
  }
}
