/** Deployment defaults for direct canvas wheel and pinch gestures. */
import z from '@deepseek-ai/schemastery'

/** Zoom response applied when the browser loads. */
export interface ZoomOptions {
  /** Logarithmic scale change per modified wheel pixel. */
  readonly wheelSensitivity: number
  /** Logarithmic scale change per browser pinch delta. */
  readonly pinchSensitivity: number
}

/** Reject nonpositive or excessive gesture gains before registering input handlers. */
export const ZoomOptions: z<Partial<ZoomOptions>, ZoomOptions> = z.object({
  wheelSensitivity: z.transform(z.number().min(0.0001).max(0.01), finiteGain).default(0.004),
  pinchSensitivity: z.transform(z.number().min(0.001).max(0.05), finiteGain).default(0.01),
})

function finiteGain(value: number): number {
  if (!Number.isFinite(value)) throw new TypeError('agent-tree-canvas: zoom gain must be finite')
  return value
}
