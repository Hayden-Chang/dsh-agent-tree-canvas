/** Selection capture preserves text and rejects cross-node selections. */
import { expect, it } from 'vitest'
import { readSummarySelection } from '../src/client/summary-selection.ts'

it('captures partial formatted text exactly and refuses blank or cross-node selections', () => {
  const root = document.createElement('div'), outside = document.createElement('p')
  root.innerHTML = '<p>Before <strong>selected</strong> words after.</p>'
  outside.textContent = 'Outside'
  document.body.append(root, outside)
  try {
    const selection = window.getSelection()!, range = document.createRange()
    range.setStart(root.querySelector('strong')!.firstChild!, 2)
    range.setEnd(root.querySelector('p')!.lastChild!, 6)
    selection.removeAllRanges(); selection.addRange(range)
    expect(readSummarySelection(root)).toMatchObject({ text: 'lected words', offset: 9 })
    range.setEnd(outside.firstChild!, 3)
    expect(readSummarySelection(root)).toBeNull()
    range.selectNodeContents(root); range.collapse(true)
    expect(readSummarySelection(root)).toBeNull()
    selection.removeAllRanges()
  } finally { root.remove(); outside.remove() }
})
