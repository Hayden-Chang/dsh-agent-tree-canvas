/** Browser recovery for notes that have not yet been acknowledged by the Host. */
import { z } from 'zod'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** The revision is the saved text on which the local edit was based. */
export interface EditorDraft { readonly markdown: string; readonly revision: number }

/** Synchronous recovery storage; failures leave the in-memory draft intact. */
export interface DraftJournal {
  /** @param id - owning Session. @returns a validated recovery draft, if present. */
  read(id: SessionId): EditorDraft | undefined
  /** @param id - owning Session. @param draft - pending text, or undefined after acknowledgement. */
  write(id: SessionId, draft: EditorDraft | undefined): void
}

const draftSchema = z.object({ markdown: z.string(), revision: z.number().int().nonnegative() })

/**
 * Keep pending edits across a reload without replacing a conflicting remote revision.
 * @param storage - browser storage owned by the current origin.
 * @returns validated per-Session recovery operations.
 */
export function createDraftJournal(storage: Storage): DraftJournal {
  const key = (id: SessionId): string => `dsh-session-canvas-draft:${id}`
  return {
    read(id) {
      const value = storage.getItem(key(id))
      return value === null ? undefined : draftSchema.parse(JSON.parse(value))
    },
    write(id, draft) {
      if (draft === undefined) storage.removeItem(key(id))
      else storage.setItem(key(id), JSON.stringify(draft))
    },
  }
}
