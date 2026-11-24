/** Canvas-local routing of the stock turn-footer branch action. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { decorateChat } from '../src/client/chat-decoration.ts'

function fixture() {
  const root = document.createElement('div')
  root.innerHTML = `<div data-turn-tail="2">
    <button data-action="copy"><svg data-icon="dsw-icon-copy-outline-regular"></svg></button>
    <button data-action="branch"><svg data-icon="dsw-icon-branch-outline-regular"><use /></svg></button>
  </div>`
  document.body.append(root)
  const forkTurn = vi.fn(), stockClick = vi.fn()
  const branch = root.querySelector<HTMLButtonElement>('[data-action="branch"]')!
  branch.addEventListener('click', stockClick)
  const dispose = decorateChat(root, {
    chat: () => undefined, onMutation: () => {}, forkTurn,
    openQuote: () => {}, removeQuote: () => {}, sourceLabel: 'Source', removeLabel: 'Remove', popupClass: 'popup',
  })
  onTestFinished(() => { dispose(); root.remove() })
  return { root, branch, forkTurn, stockClick, dispose }
}

it('routes clicks on the branch icon to the selected canvas turn without opening a stock session', () => {
  const f = fixture()
  f.branch.querySelector('use')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  expect(f.forkTurn).toHaveBeenCalledExactlyOnceWith(2)
  expect(f.stockClick).not.toHaveBeenCalled()
  const copy = vi.fn()
  f.root.querySelector('button')!.addEventListener('click', copy)
  f.root.querySelector('button')!.click()
  expect(copy).toHaveBeenCalledOnce()
  expect(f.forkTurn).toHaveBeenCalledTimes(1)
})

it('keeps unavailable branches inactive and removes canvas routing on disposal', () => {
  const f = fixture()
  f.branch.setAttribute('aria-disabled', 'true')
  f.branch.click()
  expect(f.forkTurn).not.toHaveBeenCalled()
  f.branch.removeAttribute('aria-disabled')
  f.stockClick.mockClear()
  f.dispose()
  f.branch.click()
  expect(f.forkTurn).not.toHaveBeenCalled()
  expect(f.stockClick).toHaveBeenCalledOnce()
})
