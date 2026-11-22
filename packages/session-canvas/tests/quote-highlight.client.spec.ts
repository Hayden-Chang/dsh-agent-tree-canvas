// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { quoteRange } from '../src/client/quote-highlight.ts'

it('locates quoted text across Markdown elements and uses the captured occurrence', () => {
  const root = document.createElement('div')
  root.innerHTML = '<p>same words</p><p>same <strong>words</strong> here</p>'
  const range = quoteRange(root, 'same words', 10)
  expect(range?.toString()).toBe('same words')
  expect(range?.startContainer.parentElement).toBe(root.lastElementChild)
  expect(range?.endContainer.parentElement?.tagName).toBe('STRONG')
  expect(root.querySelectorAll('mark').length).toBe(0)
})

it('finds text after a rendering offset change and leaves missing text unselected', () => {
  const root = document.createElement('div')
  root.textContent = 'prefix original suffix'
  expect(quoteRange(root, 'original', 0)?.toString()).toBe('original')
  expect(quoteRange(root, 'missing', 0)).toBeUndefined()
  expect(quoteRange(root, '', 0)).toBeUndefined()
})
