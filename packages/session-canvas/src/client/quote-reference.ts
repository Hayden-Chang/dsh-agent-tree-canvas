/** Source-addressed quotes use the stock composer's reference extension. */
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionInput, TokenSpan } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'

function formatQuoteText(text: string): string {
  return text.replace(/\r\n?/gu, '\n').split('\n').map(line => `> ${line}`).join('\n')
}

/** Durable source kept in the reference id; never included in model text. */
export interface DraftQuoteSource {
  readonly sessionId: SessionId
  readonly seq: number
  readonly turn: number
  readonly offset: number
}

/** Human notes have their own address and never resolve against the conversation transcript. */
export interface SummaryQuoteSource {
  readonly kind: 'summary'
  readonly sessionId: SessionId
  readonly offset: number
}
/** Saved source of a quote from either a message or human notes. */
export type QuoteSource = DraftQuoteSource | SummaryQuoteSource

/** Input-trigger source id, also persisted by the unmodified composer. */
export const QUOTE_SOURCE = 'session-canvas-quote'

const sourceSchema = z.object({
  sessionId: z.string().min(1).transform(value => value as SessionId),
  seq: z.number().int().nonnegative(), turn: z.number().int().nonnegative(), offset: z.number().int().nonnegative(),
})
const quoteSourceSchema = z.union([sourceSchema, z.object({ kind: z.literal('summary'),
  sessionId: z.string().min(1).transform(value => value as SessionId), offset: z.number().int().nonnegative() })])
const quoteSchema = z.object({ version: z.literal(1), text: z.string().min(1), source: quoteSourceSchema.optional() })

/** @param ref - persisted reference id. @returns validated quote text and source. */
export function readQuoteReference(ref: string): z.infer<typeof quoteSchema> {
  return quoteSchema.parse(JSON.parse(ref))
}

/** @param text - literal selection. @param source - original message or summary. @returns stock reference fields. */
export function quoteReference(text: string, source?: QuoteSource) {
  return { source: QUOTE_SOURCE, ref: JSON.stringify({ version: 1, text, ...source === undefined ? {} : { source } }),
    label: text, clipboardText: formatQuoteText(text) }
}

/** @param input - retained composer. @returns insertion at the end in detect coordinates. */
export function endOfDraft(input: SessionInput): TokenSpan {
  const state = input.state.getSnapshot()
  const chips = state.occurrences.reduce((sum, item) => sum + item.length - 1, 0)
  const command = state.claim?.token.trimEnd().length ?? 0
  const end = state.draft.length - chips - Math.max(0, command - 1)
  return { start: end, end, draftRev: state.draftRev }
}

/** @param open - reveal the owning message or summary. @returns a stock input-trigger provider. */
export function quoteTrigger(open: (sessionId: SessionId, text: string, source?: QuoteSource) => boolean): InputTriggerSource {
  return {
    trigger: '@', name: QUOTE_SOURCE, showGroupTitle: false,
    candidates: async () => [], onPick: () => undefined,
    codec: {
      clipboardText: ref => formatQuoteText(readQuoteReference(ref).text),
      serialize: async (ref, signal) => { signal.throwIfAborted(); return formatQuoteText(readQuoteReference(ref).text) },
    },
    openReference: (session, reference) => {
      const quote = readQuoteReference(reference.ref)
      return open(session.sessionId, quote.text, quote.source)
    },
  }
}

/** Remove one reference through the stock revision-guarded text insertion event. */
export function removeQuote(ctx: Context, input: SessionInput, index: number): void {
  const state = input.state.getSnapshot()
  const occurrence = state.occurrences.filter(item => item.source === QUOTE_SOURCE)[index]
  if (occurrence === undefined) return
  const preceding = state.occurrences.filter(item => item.offset < occurrence.offset)
    .reduce((sum, item) => sum + item.length - 1, 0)
  const command = state.claim?.token.trimEnd().length ?? 0
  const start = occurrence.offset - preceding - Math.max(0, command - 1)
  ctx.bail(ctx, 'slash/input-insert-text', { text: '', span: { start, end: start + 1, draftRev: state.draftRev } })
}

/** Convert saved source-bearing legacy quotes before the stock composer reads its draft. */
export function migrateQuoteDraft(storage: Pick<Storage, 'getItem' | 'setItem'>, id: SessionId): void {
  const key = `dsh.conversation.${id}`, raw = storage.getItem(key)
  if (raw === null) return
  const stored: unknown = JSON.parse(raw)
  const parsed = z.object({ draft: z.object({ text: z.string(), references: z.array(z.record(z.string(), z.unknown())),
    quotes: z.array(z.object({ offset: z.number().int().nonnegative(), length: z.number().int().positive(),
      text: z.string().min(1), source: quoteSourceSchema.optional() })).optional(),
  }).passthrough() }).passthrough().safeParse(stored)
  if (!parsed.success || !parsed.data.draft.quotes?.length) return
  const draft = parsed.data.draft
  const references = [...draft.references, ...draft.quotes!.map(quote => ({
    ...quoteReference(quote.text, quote.source), offset: quote.offset, length: quote.length,
  }))].sort((a, b) => Number(a.offset) - Number(b.offset))
  storage.setItem(`session-canvas.legacy-draft.${id}`, raw)
  storage.setItem(key, JSON.stringify({ ...parsed.data, draft: { ...draft, quotes: [], references } }))
}
