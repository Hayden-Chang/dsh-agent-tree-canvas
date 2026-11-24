/** Rich Markdown editing with CommonMark, GFM, history, and native composition support. */
import { Editor, defaultValueCtx, editorViewCtx, editorViewOptionsCtx, rootCtx, serializerCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { history } from '@milkdown/kit/plugin/history'
import { clipboard } from '@milkdown/kit/plugin/clipboard'
import { Plugin } from '@milkdown/kit/prose/state'
import { $prose, replaceAll } from '@milkdown/kit/utils'

/** An editor mount accepts remote updates without resetting its own acknowledged edits. */
export interface SummaryEditorHandle {
  /** @param markdown - latest human draft or newly adopted saved text. */
  update(markdown: string): void
  /** @returns completion of editor creation followed by its teardown. */
  dispose(): Promise<void>
}

/**
 * Mount one Markdown editor; asynchronous creation remains owned until disposal settles.
 * @param element - content host with a localized accessible label.
 * @param markdown - initial summary, preserved verbatim until a document edit.
 * @param onChange - receives Markdown only for document changes.
 * @param onError - reports mount or update failures without deleting the draft.
 * @returns controlled editor lifetime.
 */
export function createSummaryEditor(
  element: HTMLElement, markdown: string, onChange: (value: string) => void, onError: (error: unknown) => void,
): SummaryEditorHandle {
  let current = markdown, disposed = false, mounted = false, replacing = false
  const changes = $prose(ctx => new Plugin({
    view: () => ({ update(view, previous) {
      if (!mounted || disposed || replacing || view.state.doc.eq(previous.doc)) return
      try {
        const value = ctx.get(serializerCtx)(view.state.doc)
        if (value !== current) { current = value; onChange(value) }
      } catch (error) { onError(error) }
    } }),
  }))
  const editor = Editor.make().config((ctx) => {
    ctx.set(rootCtx, element)
    ctx.set(defaultValueCtx, markdown)
    ctx.set(editorViewOptionsCtx, { attributes: { role: 'textbox', 'aria-multiline': 'true', 'aria-label': element.ariaLabel ?? '' } })
  }).use(commonmark).use(gfm).use(history).use(clipboard).use(changes)
  const ready = editor.create().then(async () => {
    if (disposed) { await editor.destroy(); return }
    if (current !== markdown) editor.action(replaceAll(current))
    mounted = true
    editor.action((ctx) => { ctx.get(editorViewCtx).focus() })
  }).catch((error: unknown) => { if (!disposed) onError(error) })
  return {
    update(value) {
      if (disposed || value === current) return
      current = value
      if (mounted) {
        try { replacing = true; editor.action(replaceAll(value)) }
        catch (error) { onError(error) }
        finally { replacing = false }
      }
    },
    async dispose() {
      disposed = true
      await ready
      if (mounted) { mounted = false; await editor.destroy() }
    },
  }
}
