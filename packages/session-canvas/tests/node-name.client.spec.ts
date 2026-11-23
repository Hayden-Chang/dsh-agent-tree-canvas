import { createElement } from 'react'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NodeName } from '../src/client/node-name.tsx'

// Unit-test editing semantics; the browser test exercises the shipped DSH controls.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const { createElement } = await import('react')
  return {
    Button: (props: ButtonHTMLAttributes<HTMLButtonElement>) => createElement('button', props),
    Input: (props: InputHTMLAttributes<HTMLInputElement>) => createElement('input', props),
    Tooltip: ({ children }: { children: ReactNode }) => children,
    IconEditOutlineRegular: () => createElement('svg'),
  }
})

afterEach(cleanup)
const label = 'Edit conversation name'

it('shows automatic updates without replacing an in-progress human edit; Escape cancels', () => {
  const rename = vi.fn(async () => true)
  const view = (title: string) => createElement(NodeName, { title, label, disabled: false, rename })
  const ui = render(view('Initial question'))
  ui.rerender(view('Generated name'))
  expect(screen.getByText('Generated name')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: label }))
  const input = screen.getByRole('textbox', { name: label })
  fireEvent.change(input, { target: { value: 'My own title' } })
  ui.rerender(view('New automatic title'))
  expect((input as HTMLInputElement).value).toBe('My own title')
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(screen.getByText('New automatic title')).toBeTruthy()
  expect(rename).not.toHaveBeenCalled()
})

it('keeps failed edits, ignores IME confirmation, and sends Enter plus blur only once', async () => {
  const pending = Promise.withResolvers<boolean>()
  const rename = vi.fn(() => pending.promise)
  render(createElement(NodeName, { title: 'Automatic title', label, disabled: false, rename }))
  fireEvent.click(screen.getByRole('button', { name: label }))
  const input = screen.getByRole('textbox', { name: label })
  fireEvent.change(input, { target: { value: '自定义名称' } })
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
  expect(rename).not.toHaveBeenCalled()
  fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.blur(input)
  expect(rename).toHaveBeenCalledTimes(1)
  expect(rename).toHaveBeenCalledWith('自定义名称')
  pending.resolve(false)
  await vi.waitFor(() => { expect((input as HTMLInputElement).readOnly).toBe(false) })
  expect((input as HTMLInputElement).value).toBe('自定义名称')
  rename.mockResolvedValue(true)
  fireEvent.keyDown(input, { key: 'Enter' })
  await vi.waitFor(() => { expect(screen.queryByRole('textbox')).toBeNull() })
})

it('leaves the accepted name intact when an empty edit loses focus', () => {
  const rename = vi.fn(async () => true)
  render(createElement(NodeName, { title: 'Accepted title', label, disabled: false, rename }))
  fireEvent.click(screen.getByRole('button', { name: label }))
  const input = screen.getByRole('textbox', { name: label })
  fireEvent.change(input, { target: { value: '   ' } }); fireEvent.blur(input)
  expect(screen.getByText('Accepted title')).toBeTruthy()
  expect(rename).not.toHaveBeenCalled()
})
