/** Browser entry for the optional Agent tree canvas plugin. */
import type { Context } from '@deepseek-ai/cordis'
import remote from '@deepseek-ai/dsh-agent-tree-canvas/remote'
import { mountCanvas } from './mount.ts'
import { ZoomOptions } from '../zoom-options.ts'
import { AutosaveDelayMs } from '../summary-options.ts'
export { inject } from './mount.ts'

/**
 * Activate canvas UI after its Remote contribution is available.
 * @param ctx - browser plugin lifetime.
 * @returns disposer for UI and Remote methods.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const zoom = ZoomOptions((globalThis as { __DSH_AGENT_TREE_CANVAS_ZOOM__?: unknown }).__DSH_AGENT_TREE_CANVAS_ZOOM__ ?? {})
  const delay = (globalThis as { __DSH_AGENT_TREE_CANVAS_AUTOSAVE_MS__?: unknown }).__DSH_AGENT_TREE_CANVAS_AUTOSAVE_MS__
  if (delay !== undefined && typeof delay !== 'number') throw new TypeError('agent-tree-canvas: autosave delay must be a number')
  const autosaveMs = AutosaveDelayMs(delay)
  return mountCanvas(ctx, remote, zoom, autosaveMs)
}
