/** Name forked conversations from their own first prompt using DSH's title executor. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { fallbackSessionTitle, normalizeSessionTitle, SessionTitleProviderId } from '@deepseek-ai/dsh-session-title'
import { executeSessionTitleLlm, resolveSessionTitleLlmConfig } from '@deepseek-ai/dsh-session-title-llm'
import type { CanvasMessage, CanvasTranscript } from './types.ts'

export interface TitleOptions {
  readonly targetWords: number
  readonly targetCjkCharacters: number
  readonly fallbackMaxBytes: number
  readonly maxTitleBytes: number
  readonly maxInputBytes: number
  readonly maxOutputTokens: number
  readonly timeoutMs: number
}

/** Same default length and execution bounds as the shipped DSH first-prompt provider. */
export const TitleOptions: z<Partial<TitleOptions>, TitleOptions> = z.object({
  targetWords: z.natural().min(1).default(5),
  targetCjkCharacters: z.natural().min(1).default(10),
  fallbackMaxBytes: z.natural().min(1).default(40),
  maxTitleBytes: z.natural().min(1).default(80),
  maxInputBytes: z.natural().min(1).default(4096),
  maxOutputTokens: z.natural().min(1).default(4096),
  timeoutMs: z.natural().min(1).max(2147483647).default(60000),
})

const provider = SessionTitleProviderId('agent-tree-canvas-first-prompt')

export class CanvasTitles {
  private readonly active = new Map<SessionId, { abort: AbortController; task: Promise<void> }>()
  private readonly lifetime = new AbortController()

  constructor(private readonly ctx: Context, private readonly transcript: ProjectionHandle<CanvasTranscript>,
    private readonly child: (id: SessionId) => boolean, private readonly options: TitleOptions) {
    if (options.fallbackMaxBytes > options.maxTitleBytes) throw new Error('Canvas fallback title limit exceeds the accepted title limit')
    ctx.on('session/event', async (session, event) => {
      if (event.type === 'session/title') {
        if (event.data.source.kind === 'user' && event.seq >= session.inheritedEventCount) this.active.get(session.id)?.abort.abort()
        return
      }
      if (event.type !== 'user/message' && event.type !== 'turn/end') return
      if (!this.child(session.id)) return
      // Publish titles after the triggering event reaches every observer in log order.
      await Promise.resolve()
      if (this.lifetime.signal.aborted || this.ctx.sessions.get(session.id) !== session) return
      if (event.type === 'user/message') this.fallback(session)
      if (event.type === 'turn/end') this.resume(session)
    })
    ctx.on('session/disposed', session => { this.active.get(session.id)?.abort.abort() })
  }

  private prompt(session: Session): CanvasMessage | undefined {
    const current = this.ctx.sessionTitle.get(session)
    if (current !== undefined && current.eventSeq >= session.inheritedEventCount && current.source.kind !== 'fallback') return
    return this.transcript.stateOf(session).messages.find(message => message.role === 'user' && !message.inherited && message.text.trim())
  }

  private fallback(session: Session): void {
    const message = this.prompt(session)
    if (message === undefined) return
    const current = this.ctx.sessionTitle.get(session)
    if (current !== undefined && current.eventSeq >= session.inheritedEventCount) return
    const title = fallbackSessionTitle(message.text, this.options.targetWords, this.options.fallbackMaxBytes)
    if (title) session.append('session/title', { title, messageSeqs: [SessionSeq(message.seq)], source: { kind: 'fallback' } })
  }

  /** Resume unfinished naming after a completed turn or reopening an existing canvas. */
  resume(session: Session): void {
    if (this.lifetime.signal.aborted || !this.child(session.id) || this.active.has(session.id)) return
    this.fallback(session)
    const message = this.prompt(session), route = session.requestHeader()?.config
    if (message === undefined || route === undefined) return
    const abort = new AbortController()
    const signal = AbortSignal.any([abort.signal, this.lifetime.signal])
    const task = this.generate(session, message, { provider: route.provider, model: route.model }, signal)
      .catch(error => { if (!signal.aborted) this.ctx.logger.warn('Could not generate a canvas conversation name', error) })
      .finally(() => { this.active.delete(session.id) })
    this.active.set(session.id, { abort, task })
  }

  private async generate(session: Session, message: CanvasMessage, route: { provider: string; model: string }, signal: AbortSignal): Promise<void> {
    const messages = [{ seq: SessionSeq(message.seq), text: message.text }]
    const { maxInputBytes, maxOutputTokens, timeoutMs } = this.options
    const response = await executeSessionTitleLlm(this.ctx, resolveSessionTitleLlmConfig({ maxInputBytes, maxOutputTokens, timeoutMs }),
      { session, messages, route, signal }, provider, {
        system: [
          'Create a concise title for a conversation from the supplied first human message.',
          'Return only the title on one line in the language of the message, without quotes, explanations, Markdown or code.',
          `Aim for ${this.options.targetWords} words, or ${this.options.targetCjkCharacters} Chinese, Japanese or Korean characters.`,
        ].join('\n'),
        input: `Generate the session title from this JSON array of human messages:\n${JSON.stringify(messages)}`,
        messageSeqs: [SessionSeq(message.seq)],
        selectReasoningEffort: model => model.reasoning?.efforts[0]?.id,
      })
    signal.throwIfAborted()
    if (response.finish.kind !== 'stop' || response.blocks.some(block => block.type === 'tool-call')) throw new Error('Title generation did not finish with text')
    const text = response.blocks.filter(block => block.type === 'text').map(block => block.text).join(' ')
    const line = text.split(/\r?\n/u).map(line => line.trim()).find(Boolean) ?? ''
    const title = normalizeSessionTitle(line.replace(/^\*{1,3}([^*]+)\*{1,3}$/u, '$1'), this.options.maxTitleBytes)
    if (!title) throw new Error('Title generation returned an empty name')
    // Manual edits, session disposal, and plugin teardown win over a late model response.
    if (this.ctx.sessions.get(session.id) !== session || this.prompt(session) === undefined) return
    session.append('session/title', { title, messageSeqs: [SessionSeq(message.seq)],
      source: { kind: 'provider', provider, model: response.model } })
  }

  async dispose(): Promise<void> {
    this.lifetime.abort()
    await Promise.allSettled([...this.active.values()].map(value => value.task))
  }
}
