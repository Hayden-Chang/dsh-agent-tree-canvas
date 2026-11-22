// @vitest-environment jsdom
/** Recovery preserves exact text and rejects invalid persisted drafts. */
import { expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createDraftJournal } from '../src/client/draft-journal.ts'

it('round-trips exact multiline notes and removes acknowledged drafts', () => {
  const journal = createDraftJournal(localStorage), id = 'journal-roundtrip' as SessionId
  expect(journal.read(id)).toBeUndefined()
  const draft = { markdown: '  中文\n\n# Notes\n', revision: 12 }
  journal.write(id, draft)
  expect(journal.read(id)).toEqual(draft)
  journal.write(id, undefined)
  expect(journal.read(id)).toBeUndefined()
})

it('reports malformed or invalid persisted recovery data without deleting it', () => {
  const id = 'journal-invalid' as SessionId, key = `dsh-session-canvas-draft:${id}`
  const journal = createDraftJournal(localStorage)
  for (const value of ['{', '{"markdown":12,"revision":0}', '{"markdown":"notes","revision":-1}']) {
    localStorage.setItem(key, value)
    expect(() => journal.read(id)).toThrow()
    expect(localStorage.getItem(key)).toBe(value)
  }
  localStorage.removeItem(key)
})
