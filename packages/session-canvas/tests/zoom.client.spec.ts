// @vitest-environment jsdom
/** Direct canvas zoom, scroll ownership, and desktop navigation gestures. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { ZoomOptions } from '../src/zoom-options.ts'
import { bindCanvasNavigation } from '../src/client/navigation.ts'
import { fitCanvas, stepZoom, zoomAt } from '../src/client/zoom.ts'
import type { CanvasNavigation } from '../src/client/navigation.ts'

function fixture() {
  const element = document.createElement('div')
  element.tabIndex = 0
  element.style.lineHeight = '20px'
  Object.defineProperties(element, { clientHeight: { value: 400 }, clientWidth: { value: 800 } })
  element.setPointerCapture = vi.fn()
  element.hasPointerCapture = () => false
  document.body.append(element)
  const actions = { zoom: vi.fn<CanvasNavigation['zoom']>(), pan: vi.fn<CanvasNavigation['pan']>(),
    step: vi.fn<CanvasNavigation['step']>(), actualSize: vi.fn<CanvasNavigation['actualSize']>() }
  const dispose = bindCanvasNavigation(element, ZoomOptions({}), actions)
  onTestFinished(() => { dispose(); element.remove() })
  const wheel = (deltaY: number, init: WheelEventInit = {}, target: HTMLElement = element) => {
    const event = new WheelEvent('wheel', { deltaY, metaKey: true, clientX: 200, clientY: 100, cancelable: true, bubbles: true, ...init })
    target.dispatchEvent(event)
    return event
  }
  const key = (type: string, init: KeyboardEventInit, target: HTMLElement = element) => {
    const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
    target.dispatchEvent(event)
    return event
  }
  const pointer = (type: string, x: number, y: number, button = 0, target: HTMLElement = element) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button })
    Object.defineProperty(event, 'pointerId', { value: 1 })
    target.dispatchEvent(event)
    return event
  }
  return { element, actions, dispose, wheel, key, pointer,
    scale: () => actions.zoom.mock.calls.reduce((scale, [factor]) => scale * factor, 1) }
}

it('applies wheel distance immediately without velocity amplification or trailing animation', async () => {
  vi.useFakeTimers()
  onTestFinished(() => { vi.useRealTimers() })
  const slow = fixture(), fast = fixture()
  for (let i = 0; i < 6; i++) { slow.wheel(-20); await vi.advanceTimersByTimeAsync(200) }
  for (let i = 0; i < 6; i++) fast.wheel(-20)
  expect(slow.scale()).toBeCloseTo(Math.exp(0.48), 6)
  expect(fast.scale()).toBeCloseTo(slow.scale(), 6)
  expect(fast.actions.zoom).toHaveBeenCalledTimes(6)
  await vi.advanceTimersByTimeAsync(2000)
  expect(fast.actions.zoom).toHaveBeenCalledTimes(6)
  fast.wheel(20)
  expect(fast.actions.zoom.mock.lastCall![0]).toBeLessThan(1)
  expect(fast.actions.zoom.mock.lastCall![1]).toEqual({ x: 200, y: 100 })
})

it('normalizes wheel units and distinguishes physical Control from a browser pinch', () => {
  const f = fixture()
  f.wheel(-1, { deltaMode: WheelEvent.DOM_DELTA_LINE })
  f.wheel(-0.05, { deltaMode: WheelEvent.DOM_DELTA_PAGE })
  expect(f.scale()).toBeCloseTo(Math.exp(0.16), 6)
  f.key('keydown', { key: 'Control' })
  f.wheel(-20, { metaKey: false, ctrlKey: true })
  expect(f.actions.zoom.mock.lastCall![0]).toBeCloseTo(Math.exp(0.08), 6)
  f.key('keyup', { key: 'Control' })
  f.wheel(-2, { metaKey: false, ctrlKey: true })
  expect(f.actions.zoom.mock.lastCall![0]).toBeCloseTo(Math.exp(0.02), 6)
})

it('pans both axes and Shift-wheel while retaining nested scrollers even at their edge', () => {
  const f = fixture()
  expect(f.wheel(30, { metaKey: false, deltaX: 12 }).defaultPrevented).toBe(true)
  expect(f.actions.pan).toHaveBeenLastCalledWith(-12, -30)
  f.wheel(20, { metaKey: false, shiftKey: true })
  expect(f.actions.pan).toHaveBeenLastCalledWith(-20, -0)
  const body = document.createElement('div')
  body.style.overflowY = 'auto'
  Object.defineProperties(body, { clientHeight: { value: 100 }, scrollHeight: { value: 300 } })
  body.scrollTop = 200
  f.element.append(body)
  expect(f.wheel(40, { metaKey: false }, body).defaultPrevented).toBe(false)
  expect(f.actions.pan).toHaveBeenCalledTimes(2)
  expect(f.wheel(-20, {}, body).defaultPrevented).toBe(true)
  const editor = document.createElement('div')
  editor.setAttribute('contenteditable', 'true')
  f.element.append(editor)
  expect(f.wheel(30, { metaKey: false }, editor).defaultPrevented).toBe(false)
})

it('pans with right drag, keeps stationary right clicks, and leaves text drags to selection', () => {
  const f = fixture(), card = document.createElement('article')
  card.dataset.canvasSession = 'test'
  f.element.append(card)
  f.pointer('pointerdown', 10, 10, 0, card)
  f.pointer('pointermove', 50, 40, 0, card)
  expect(f.actions.pan).not.toHaveBeenCalled()
  f.pointer('pointerdown', 10, 10, 2, card)
  f.pointer('pointermove', 11, 10, 2, card)
  f.pointer('pointerup', 11, 10, 2, card)
  expect(f.pointer('contextmenu', 11, 10, 2, card).defaultPrevented).toBe(false)
  f.pointer('pointerdown', 10, 10, 2, card)
  f.pointer('pointermove', 50, 40, 2, card)
  expect(f.actions.pan).toHaveBeenLastCalledWith(40, 30)
  f.pointer('pointerup', 50, 40, 2, card)
  expect(f.pointer('contextmenu', 50, 40, 2, card).defaultPrevented).toBe(true)
  expect(f.element.dataset.canvasDragging).toBeUndefined()
})

it('owns Space drag and scale shortcuts only outside editors, and releases on blur and disposal', () => {
  const f = fixture(), card = document.createElement('article'), editor = document.createElement('textarea')
  card.dataset.canvasSession = 'test'
  card.append(editor); f.element.append(card)
  expect(f.key('keydown', { code: 'Space', key: ' ' }, editor).defaultPrevented).toBe(false)
  expect(f.key('keydown', { key: '+', metaKey: true }, editor).defaultPrevented).toBe(false)
  f.key('keydown', { code: 'Space', key: ' ' })
  expect(f.element.dataset.canvasHand).toBe('')
  f.pointer('pointerdown', 0, 0, 0, card)
  f.pointer('pointermove', 12, 15, 0, card)
  expect(f.actions.pan).toHaveBeenLastCalledWith(12, 15)
  window.dispatchEvent(new Event('blur'))
  f.pointer('pointermove', 30, 30, 0, card)
  expect(f.actions.pan).toHaveBeenCalledTimes(1)
  expect(f.element.dataset.canvasHand).toBeUndefined()
  f.key('keydown', { key: '=', ctrlKey: true })
  f.key('keydown', { key: '-', metaKey: true })
  f.key('keydown', { key: '0', metaKey: true })
  expect(f.actions.step.mock.calls).toEqual([[1], [-1]])
  expect(f.actions.actualSize).toHaveBeenCalledOnce()
  f.dispose()
  expect(f.wheel(30).defaultPrevented).toBe(false)
  f.key('keydown', { key: '=', ctrlKey: true })
  expect(f.actions.step).toHaveBeenCalledTimes(2)
})

it('preserves the pointer anchor and uses the desktop scale presets and limits', () => {
  const initial = { x: -80, y: 40, scale: 0.8 }, anchor = { x: 450, y: 320 }
  const zoomed = zoomAt(initial, 1.2, anchor)
  expect((anchor.x - zoomed.x) / zoomed.scale).toBeCloseTo((anchor.x - initial.x) / initial.scale)
  expect((anchor.y - zoomed.y) / zoomed.scale).toBeCloseTo((anchor.y - initial.y) / initial.scale)
  const largest = zoomAt(initial, 10, anchor), smallest = zoomAt(initial, 0.01, anchor)
  expect(largest.scale).toBe(5); expect(smallest.scale).toBe(0.1)
  expect(zoomAt(largest, 10, anchor)).toBe(largest)
  expect(zoomAt(smallest, 0.01, anchor)).toBe(smallest)
  expect([stepZoom(1, 1), stepZoom(1.2, 1), stepZoom(1.2, -1), stepZoom(0.94, 1), stepZoom(0.94, -1)])
    .toEqual([1.2, 1.5, 1, 1, 0.8])
  expect(stepZoom(5, 1)).toBe(5); expect(stepZoom(0.1, -1)).toBe(0.1)
})

it('fits actual card extents above the navigation controls without modifying node positions', () => {
  const f = fixture()
  for (const [x, y, width, height] of [[100, 80, 560, 180], [800, 350, 560, 576]]) {
    const card = document.createElement('article')
    card.dataset.canvasSession = 'test'
    Object.defineProperties(card, { offsetLeft: { value: x }, offsetTop: { value: y },
      offsetWidth: { value: width }, offsetHeight: { value: height } })
    f.element.append(card)
  }
  const result = fitCanvas(f.element)
  expect(result.scale).toBeCloseTo(288 / 846)
  expect(result.x + (100 + 1360) / 2 * result.scale).toBeCloseTo(400)
  expect(result.y + 80 * result.scale).toBeCloseTo(32)
  expect(result.y + 926 * result.scale).toBeCloseTo(320)
})

it('validates wheel and pinch gains', () => {
  for (const invalid of [0, -1, NaN, Infinity, 1]) {
    expect(() => ZoomOptions({ wheelSensitivity: invalid })).toThrow()
    expect(() => ZoomOptions({ pinchSensitivity: invalid })).toThrow()
  }
})
