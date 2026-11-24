/** Locate literal quoted text in rendered Markdown without changing its DOM. */

/** Stock chat renders hidden process and visible response rows with the same address. */
export function visibleSourceRow(root: HTMLElement | undefined, selector: string,
  quote?: { readonly text: string; readonly offset: number }): HTMLElement | undefined {
  const rows = [...root?.querySelectorAll<HTMLElement>(selector) ?? []].filter(row => row.closest('[hidden]') === null)
  if (quote === undefined) return rows[0]
  // Expanded reasoning can share the address too; prefer the matching response text.
  const ordered = [...rows.filter(row => row.dataset.chatGroupPart === 'response'), ...rows.filter(row => row.dataset.chatGroupPart !== 'response')]
  return ordered.find(row => quoteRange(row.querySelector<HTMLElement>('[data-text-interaction-source]') ?? row, quote.text, quote.offset) !== undefined) ?? ordered[0]
}

/**
 * Find a text range, preferring the selection's original offset within the message.
 * @param root - rendered original message.
 * @param text - verbatim selected text.
 * @param offset - original UTF-16 text offset.
 * @returns the matching range, or absence when rendering no longer contains the same text.
 */
export function quoteRange(root: HTMLElement, text: string, offset: number): Range | undefined {
  if (text === '') return
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  let content = ''
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (!(node instanceof Text)) continue
    nodes.push(node); content += node.data
  }
  const start = content.slice(offset, offset + text.length) === text ? offset : content.indexOf(text)
  if (start < 0) return
  const end = start + text.length, range = root.ownerDocument.createRange()
  let at = 0, started = false
  for (const node of nodes) {
    const next = at + node.length
    if (!started && start < next) { range.setStart(node, start - at); started = true }
    if (started && end <= next) { range.setEnd(node, end - at); return range }
    at = next
  }
}
