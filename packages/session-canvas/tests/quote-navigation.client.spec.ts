/** Painted source links keep text selection and canvas gestures in their original owners. */
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { bindQuoteNavigation, quoteLinksAt } from '../src/client/quote-navigation.ts'
import type { QuoteLinks } from '../src/client/quote-navigation.ts'

const disposers: (() => void)[] = []
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); document.body.replaceChildren(); vi.useRealTimers() })

function fixture() {
  const root = document.createElement('div')
  root.innerHTML = '<p>Repeated <b title="original">selected</b> text</p><p>Another message</p>'
  document.body.append(root)
  const message = root.firstElementChild as HTMLElement, text = message.querySelector('b')!
  const range = (left: number, right: number) => {
    const result = document.createRange(); result.selectNodeContents(text)
    result.getClientRects = () => [{ left, right, top: 20, bottom: 40, width: right - left, height: 20 }] as unknown as DOMRectList
    return result
  }
  const links: QuoteLinks = new Map([[message, [
    { range: range(10, 50), childId: 'first' as SessionId },
    { range: range(30, 70), childId: 'second' as SessionId },
  ]]])
  const open = vi.fn(), title = vi.fn((ids: readonly SessionId[]) => ids.join(', '))
  disposers.push(bindQuoteNavigation(root, { links: () => links, open, title }))
  const pointer = (type: string, x = 15, options: MouseEventInit = {}) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 30, detail: 1, ...options })
    Object.defineProperty(event, 'pointerId', { value: 1 })
    text.dispatchEvent(event)
  }
  return { root, message, text, links, open, title, pointer }
}

it('hits only painted text in the current message and preserves all overlapping destinations', () => {
  const f = fixture()
  expect(quoteLinksAt(f.root, f.links, f.text, { x: 15, y: 30 })).toEqual(['first'])
  expect(quoteLinksAt(f.root, f.links, f.text, { x: 35, y: 30 })).toEqual(['first', 'second'])
  expect(quoteLinksAt(f.root, f.links, f.text, { x: 80, y: 30 })).toEqual([])
  expect(quoteLinksAt(f.root, f.links, f.root.lastElementChild, { x: 15, y: 30 })).toEqual([])
  f.text.setAttribute('contenteditable', 'true')
  expect(quoteLinksAt(f.root, f.links, f.text, { x: 15, y: 30 })).toEqual([])
})

it('shows a destination on hover and consumes a click before the ancestor follows its own parent', () => {
  vi.useFakeTimers()
  const f = fixture(), bubble = vi.fn()
  f.root.parentElement!.addEventListener('click', bubble, { once: true })
  f.pointer('pointermove')
  expect(f.text.getAttribute('title')).toBe('first')
  expect(f.text.hasAttribute('data-canvas-quote-link')).toBe(true)
  f.pointer('pointerdown'); f.pointer('click')
  vi.runAllTimers()
  expect(f.open).toHaveBeenCalledExactlyOnceWith(['first'], { x: 15, y: 30 })
  expect(bubble).not.toHaveBeenCalled()
  f.root.parentElement!.removeEventListener('click', bubble)
  expect(f.text.getAttribute('title')).toBe('original')
})

it('passes overlapping child identities to the chooser without choosing by branch color', () => {
  vi.useFakeTimers()
  const f = fixture()
  f.pointer('pointerdown', 35); f.pointer('click', 35)
  vi.runAllTimers()
  expect(f.open).toHaveBeenCalledExactlyOnceWith(['first', 'second'], { x: 35, y: 30 })
})

it('does not navigate while selecting text, dragging, using the hand tool or right clicking', () => {
  vi.useFakeTimers()
  const f = fixture()
  f.pointer('pointerdown'); f.pointer('pointermove', 35, { buttons: 1 }); f.pointer('click', 35)
  const selection = document.getSelection()!, selected = document.createRange()
  selected.selectNodeContents(f.text); selection.addRange(selected)
  f.pointer('pointerdown'); f.pointer('click'); selection.removeAllRanges()
  f.root.setAttribute('data-canvas-hand', '')
  f.pointer('pointerdown'); f.pointer('click'); f.root.removeAttribute('data-canvas-hand')
  f.pointer('pointerdown', 15, { button: 2 }); f.pointer('click', 15, { button: 2 })
  vi.runAllTimers()
  expect(f.open).not.toHaveBeenCalled()
})

it('cancels pending navigation on double click, scrolling, cancellation and disposal', () => {
  vi.useFakeTimers()
  const f = fixture()
  f.pointer('pointerdown'); f.pointer('click')
  f.pointer('pointerdown'); f.pointer('click', 15, { detail: 2 })
  vi.runAllTimers(); expect(f.open).not.toHaveBeenCalled()
  f.pointer('pointerdown'); f.pointer('click'); document.dispatchEvent(new Event('scroll'))
  vi.runAllTimers(); expect(f.open).not.toHaveBeenCalled()
  f.pointer('pointerdown'); f.pointer('pointercancel'); f.pointer('click')
  vi.runAllTimers(); expect(f.open).not.toHaveBeenCalled()
  f.pointer('pointerdown'); f.pointer('click'); disposers.pop()!()
  vi.runAllTimers(); expect(f.open).not.toHaveBeenCalled()
})
