/** Preserve model-selection failures before auxiliary inference changes any data. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/**
 * Resolve the requested route without silently switching providers.
 * @param ctx - Host model service.
 * @param config - the Session's selected model and inference controls.
 * @param signal - caller and timeout cancellation.
 * @returns a prepared call, or an actionable failure before any request is logged.
 */
export async function prepareCanvasCall(ctx: Context, config: LlmCallConfig, signal: AbortSignal) {
  try { return await ctx.llm.prepareCall(config, signal) }
  catch (error) {
    signal.throwIfAborted()
    if (error instanceof LlmError && ['NO_ADAPTER', 'UNKNOWN_MODEL', 'MODEL_UNSUPPORTED'].includes(error.code)) {
      throw new RemoteError('canvas/model-unavailable', 'The selected model route is unavailable; select a model or restore its provider',
        { provider: config.provider, model: config.model }, { cause: error })
    }
    throw error
  }
}
