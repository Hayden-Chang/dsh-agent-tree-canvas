/** Complete-history text and fork points folded once by the Session projection registry. */
import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { CanvasTranscript } from './types.ts'

const schema: z.ZodType<CanvasTranscript> = z.object({
  inheritedEventCount: z.number().int().nonnegative(),
  messages: z.array(z.object({ seq: z.number().int().nonnegative(), role: z.enum(['user', 'assistant']), text: z.string(), inherited: z.boolean() })),
  turns: z.array(z.object({ turn: z.number().int().nonnegative(), seq: z.number().int().nonnegative() })),
})

/** Raw conversation text survives compaction; inherited messages remain contextual background. */
export const transcriptProjection = {
  key: 'sessionCanvas', stateVersion: 1, stateSchema: schema,
  init: (_header, inheritedEventCount) => ({ inheritedEventCount, messages: [], turns: [] }),
  apply(state, event) {
    if (event.type === 'turn/end') {
      return { ...state, turns: [...state.turns, { turn: event.data.turn, seq: event.seq }] }
    }
    if (event.type === 'user/message' && event.surfaceOp === 'append' && event.data.source.kind === 'user') {
      const text = event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      return { ...state, messages: [...state.messages, { seq: event.seq, role: 'user', text, inherited: event.seq < state.inheritedEventCount }] }
    }
    if (event.type === 'assistant/message') {
      const text = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      return { ...state, messages: [...state.messages, { seq: event.seq, role: 'assistant', text, inherited: event.seq < state.inheritedEventCount }] }
    }
    // Plugin records and model-surface maintenance do not change human conversation text.
    return state
  },
  wire: { viewSchema: schema, view: state => state, summary: false },
} satisfies ProjectionDefinition<'sessionCanvas', CanvasTranscript>
