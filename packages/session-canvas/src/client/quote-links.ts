/** Paint child origins without rewriting Markdown or its editable DOM. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { QuoteOrigin } from '../types.ts'
import type { NodeAppearance } from './appearance.ts'
import { quoteRange } from './quote-highlight.ts'

export interface ColoredQuote extends QuoteOrigin {
  readonly tone: NodeAppearance['tone']
}
const tones = ['root', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const

/** Rebuild ranges after text rendering, mode changes, branch removal, or draft recovery. */
export function paintQuoteOrigins(quotes: readonly ColoredQuote[], roots: ReadonlyMap<SessionId, HTMLElement>): void {
  if (typeof CSS === 'undefined' || !('highlights' in CSS) || typeof Highlight === 'undefined') return
  const groups = new Map<string, Range[]>()
  for (const { text, source, tone } of quotes) {
    const root = roots.get(source.sessionId)
    const row = root?.querySelector<HTMLElement>('kind' in source ? '[data-summary-document]'
      : `[data-chat-seq="${source.seq}"]`)
    if (row == null || row.closest('[hidden]') !== null) continue
    const range = quoteRange(row.querySelector<HTMLElement>('[data-text-interaction-source]') ?? row, text, source.offset)
    if (range === undefined) continue
    const ranges = groups.get(tone) ?? []
    ranges.push(range); groups.set(tone, ranges)
  }
  for (const tone of tones) {
    const name = `session-canvas-quote-${tone}`, ranges = groups.get(tone)
    if (ranges?.length) CSS.highlights.set(name, new Highlight(...ranges))
    else CSS.highlights.delete(name)
  }
}
