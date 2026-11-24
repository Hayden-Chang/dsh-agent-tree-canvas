/** Persisted quote addresses and stock reference serialization. */
import { Context } from '@deepseek-ai/cordis'
import type { SessionInput, InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { expect, it, vi } from 'vitest'
import { endOfDraft, migrateQuoteDraft, quoteReference, quoteTrigger, readQuoteReference, removeQuote } from '../src/client/quote-reference.ts'

const id = 'parent' as SessionId
const source = { sessionId: id, seq: 6, turn: 1, offset: 12 }

it('persists the exact selection and source but serializes only the Markdown quote', async () => {
  const text = '  exact sentence\r\nsecond line  '
  const reference = quoteReference(text, source)
  expect(readQuoteReference(reference.ref)).toEqual({ version: 1, text, source })
  const trigger = quoteTrigger(() => true)
  expect(await trigger.codec!.serialize(reference.ref, new AbortController().signal)).toBe('>   exact sentence\n> second line  ')
  expect(() => readQuoteReference('{')).toThrow()
  expect(() => readQuoteReference(JSON.stringify({ version: 2, text }))).toThrow()
  const abort = new AbortController(); abort.abort()
  await expect(trigger.codec!.serialize(reference.ref, abort.signal)).rejects.toThrow()
})

it('migrates legacy quote drafts without changing text, neighboring references, or the saved source', () => {
  const key = `dsh.conversation.${id}`, text = '> original\nmore'
  const old = JSON.stringify({ view: 'chat', draft: { text, references: [], quotes: [
    { text: 'original', source, offset: 0, length: 10 },
  ] } })
  localStorage.setItem(key, old)
  migrateQuoteDraft(localStorage, id)
  const saved = JSON.parse(localStorage.getItem(key)!)
  expect(saved.view).toBe('chat')
  expect(saved.draft.text).toBe(text)
  expect(saved.draft.quotes).toEqual([])
  expect(readQuoteReference(saved.draft.references[0].ref).source).toEqual(source)
  expect(localStorage.getItem(`agent-tree-canvas.legacy-draft.${id}`)).toBe(old)
  const migrated = localStorage.getItem(key)
  migrateQuoteDraft(localStorage, id)
  expect(localStorage.getItem(key)).toBe(migrated)
  localStorage.setItem(key, '{')
  expect(() => migrateQuoteDraft(localStorage, id)).toThrow()
  expect(localStorage.getItem(key)).toBe('{')
})

it('maps clipboard spans to atomic reference spans without replacing adjacent draft text', () => {
  const a = quoteReference('one', source), b = quoteReference('two', { ...source, seq: 9 })
  const state: InputState = { draft: '/help > one x > two', draftRev: 4, phase: 'claimed',
    claim: { name: 'help', token: '/help' }, attachmentIds: [], queue: [], occurrences: [
      { ...a, occurrenceId: 1, offset: 6, length: 5 }, { ...b, occurrenceId: 2, offset: 14, length: 5 },
    ] }
  const input = { state: { getSnapshot: () => state } } as SessionInput
  expect(endOfDraft(input)).toEqual({ start: 7, end: 7, draftRev: 4 })
  const ctx = new Context(), insert = vi.fn(() => true as const)
  ctx.on('slash/input-insert-text', insert)
  removeQuote(ctx, input, 1)
  expect(insert).toHaveBeenCalledWith({ text: '', span: { start: 6, end: 7, draftRev: 4 } })
  removeQuote(ctx, input, 9)
  expect(insert).toHaveBeenCalledTimes(1)
  ctx.fiber.dispose()
})


it('retains summary addresses separately from chat addresses without exposing them to the model', async () => {
  const text = 'Selected notes', source = { kind: 'summary' as const, sessionId: id, offset: 9 }
  const reference = quoteReference(text, source)
  expect(readQuoteReference(reference.ref)).toEqual({ version: 1, text, source })
  expect(await quoteTrigger(() => true).codec!.serialize(reference.ref, new AbortController().signal)).toBe('> Selected notes')
  expect(() => readQuoteReference(JSON.stringify({ version: 1, text, source: { ...source, offset: -1 } }))).toThrow()
})

it('renames pre-rename quote reference sources without changing their text or address', () => {
  const key = `dsh.conversation.${id}`
  const reference = { ...quoteReference('selected text', source), source: 'session-canvas-quote' }
  localStorage.setItem(key, JSON.stringify({ view: 'chat', draft: { text: '> selected text', references: [reference] } }))
  migrateQuoteDraft(localStorage, id)
  const saved = JSON.parse(localStorage.getItem(key)!)
  expect(saved.draft.references).toHaveLength(1)
  expect(saved.draft.references[0].source).toBe('agent-tree-canvas-quote')
  expect(saved.draft.references[0].ref).toBe(reference.ref)
  expect(saved.draft.text).toBe('> selected text')
  localStorage.removeItem(key)
})
