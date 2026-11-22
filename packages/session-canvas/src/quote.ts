/** Browser and Host validation of durable quote addresses. */
import { z } from 'zod'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

const sessionId = z.string().min(1) as unknown as z.ZodType<SessionId>
const position = z.number().int().nonnegative()
export const quoteSourceSchema = z.union([
  z.object({ sessionId, seq: position, turn: position, offset: position }),
  z.object({ kind: z.literal('summary'), sessionId, offset: position }),
])
export const quoteOriginSchema = z.object({ text: z.string().min(1), source: quoteSourceSchema })
