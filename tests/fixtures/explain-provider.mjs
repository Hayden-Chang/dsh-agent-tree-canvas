/** Keyless browser fixture: real submission/agent pipeline, deterministic model responses. */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { LlmAdapter } from '../../packages/agent-tree-canvas/node_modules/@deepseek-ai/dsh-llm/lib/index.js'

export const inject = ['llm']
class ExplanationAdapter extends LlmAdapter {
  providerInfo(id) { return { id, name: 'Canvas test provider' } }
  async listModels(provider) { return [{ provider, id: 'deepseek-v4-flash', name: 'Canvas explanation fixture' }] }
  async resolveModel(provider, id) { return { provider, id, name: 'Canvas explanation fixture', contextWindow: 128000 } }
  async *stream(options) {
    options.signal?.throwIfAborted()
    appendFileSync(join(process.env.DSH_HOME, 'explain-requests.jsonl'), JSON.stringify({ sessionId: options.sessionId,
      purpose: options.purpose, messages: options.messages }) + '\n')
    yield { type: 'text-delta', index: 0, text: options.purpose === 'session-title'
      ? 'Explanation of the selected passage' : 'This is the explanation of the selected passage, with its inherited context.' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
export function apply(ctx) { ctx.effect(() => {
  const handle = ctx.llm.registerAdapter(['deepseek-official'], new ExplanationAdapter())
  return () => handle.dispose()
}) }
