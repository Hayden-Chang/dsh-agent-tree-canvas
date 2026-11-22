/** Canvas scale presets, pointer anchoring, and content fitting. */

/** Canvas translation in screen pixels and content scale. */
export interface CanvasViewport { readonly x: number; readonly y: number; readonly scale: number }
/** Screen-pixel position relative to the viewport's top-left corner. */
export interface ZoomPoint { readonly x: number; readonly y: number }
/** Apply a relative scale change at a viewport-local position. */
export type ZoomChange = (factor: number, anchor: ZoomPoint) => void

/**
 * Keep the same canvas point under the anchor while respecting the canvas scale limits.
 * @param viewport - current translation and scale.
 * @param requestedScale - requested absolute scale.
 * @param anchor - pointer or viewport center in screen pixels.
 * @returns the bounded viewport; unchanged when already at the requested scale.
 */
export function zoomAt(viewport: CanvasViewport, requestedScale: number, anchor: ZoomPoint): CanvasViewport {
  const scale = Math.min(5, Math.max(0.1, requestedScale))
  if (scale === viewport.scale) return viewport
  const ratio = scale / viewport.scale
  return { scale, x: anchor.x - (anchor.x - viewport.x) * ratio, y: anchor.y - (anchor.y - viewport.y) * ratio }
}

/** Desktop mind-map scale presets, from overview to detail. */
export const ZOOM_LEVELS = [0.1, 0.2, 0.5, 0.8, 1, 1.2, 1.5, 2, 3, 4, 5] as const

/**
 * Move to the next preset from an arbitrary wheel or fitted scale.
 * @param scale - current scale.
 * @param direction - positive to enlarge, negative to reduce.
 * @returns next preset, clamped at the first or last preset.
 */
export function stepZoom(scale: number, direction: 1 | -1): number {
  return direction === 1
    ? ZOOM_LEVELS.find(level => level > scale + 1e-6) ?? 5
    : ZOOM_LEVELS.findLast(level => level < scale - 1e-6) ?? 0.1
}

/**
 * Fit rendered cards with bottom clearance for navigation, without enlarging beyond actual size.
 * @param element - viewport containing positioned canvas cards.
 * @returns fitted viewport, or actual size for an empty canvas.
 */
export function fitCanvas(element: HTMLElement): CanvasViewport {
  const cards = [...element.querySelectorAll<HTMLElement>('[data-canvas-session]')]
  if (cards.length === 0) return { x: 0, y: 0, scale: 1 }
  const left = Math.min(...cards.map(card => card.offsetLeft))
  const top = Math.min(...cards.map(card => card.offsetTop))
  const right = Math.max(...cards.map(card => card.offsetLeft + card.offsetWidth))
  const bottom = Math.max(...cards.map(card => card.offsetTop + card.offsetHeight))
  const scale = Math.max(0.1, Math.min(1, (element.clientWidth - 64) / (right - left), (element.clientHeight - 112) / (bottom - top)))
  return { scale, x: (element.clientWidth - (right + left) * scale) / 2,
    y: (element.clientHeight - 48 - (bottom + top) * scale) / 2 }
}
