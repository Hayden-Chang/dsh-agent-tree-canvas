/** Browser selection in rendered or editable human notes. */
import { useEffect, useRef, useState } from 'react'

/** A captured selection remains available while a menu button takes focus. */
export interface SummarySelection {
  readonly text: string
  readonly offset: number
  readonly range: Range
}

/**
 * Capture only selections contained entirely in this summary.
 * @param root - summary document, including its optional Markdown editor.
 * @returns verbatim DOM text and its original text offset, or no selection.
 */
export function readSummarySelection(root: HTMLElement): SummarySelection | null {
  const selection = root.ownerDocument.getSelection()
  if (selection === null || selection.isCollapsed || selection.rangeCount !== 1) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  const text = selection.toString()
  if (text.trim() === '') return null
  const prefix = range.cloneRange()
  prefix.selectNodeContents(root); prefix.setEnd(range.startContainer, range.startOffset)
  return { text, offset: prefix.toString().length, range: range.cloneRange() }
}

/**
 * Own a summary's selection menu without changing the editor's focus or selection.
 * @param enabled - whether this summary is visible.
 * @returns document ref, captured selection, and pointer/keyboard action callbacks.
 */
export function useSummarySelection(enabled: boolean) {
  const root = useRef<HTMLDivElement>(null)
  const [selection, setSelection] = useState<SummarySelection | null>(null)
  useEffect(() => { if (!enabled) setSelection(null) }, [enabled])
  useEffect(() => {
    if (selection === null) return
    const dismiss = (): void => { setSelection(null) }
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('wheel', dismiss, { capture: true, passive: true })
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('wheel', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [selection])
  return { root, selection,
    capture: () => { if (enabled && root.current !== null) setSelection(readSummarySelection(root.current)) },
    dismiss: () => { setSelection(null) },
    clear: () => { root.current?.ownerDocument.getSelection()?.removeAllRanges(); setSelection(null) },
  }
}
