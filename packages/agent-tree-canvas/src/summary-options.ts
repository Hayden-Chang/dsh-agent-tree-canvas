/** Shared validation for human-note persistence timing. */
import z from '@deepseek-ai/schemastery'

/** Debounce human edits while retaining each input immediately in browser recovery storage. */
export const AutosaveDelayMs = z.natural().min(100).max(5000).default(400)
