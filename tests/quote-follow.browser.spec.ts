/** Real canvas selection, child colors, parent scrolling, and durable reload. */
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { chromium } from 'playwright'
import type { Browser, Locator } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'

async function launchCanvasBrowser(seed?: (home: string) => Promise<void>, fallback = false) {
  const runtime = process.env.DSH_RUNTIME_ROOT
  if (!runtime) throw new Error('Set DSH_RUNTIME_ROOT to an installed DSH 0.2.2-rc.1 runtime containing node_modules')
  const home = await mkdtemp(join(tmpdir(), 'canvas-quote-follow-'))
  const profile = join(home, 'profiles/web'), plugin = resolve(process.env.CANVAS_PACKAGE_DIR ?? 'packages/session-canvas')
  await mkdir(join(profile, 'node_modules/@deepseek-ai'), { recursive: true })
  await symlink(plugin, join(profile, 'node_modules/@deepseek-ai/dsh-session-canvas'))
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'canvas-browser-test', private: true,
    dependencies: { '@deepseek-ai/dsh-session-canvas': `link:${plugin}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-session-canvas'] } },
  }))
  await seed?.(home)
  const probe = createServer()
  await new Promise<void>(resolve => { probe.listen(0, '127.0.0.1', resolve) })
  const port = (probe.address() as { port: number }).port
  await new Promise<void>((resolve, reject) => { probe.close(error => error ? reject(error) : resolve()) })
  const environment = { ...process.env, DSH_HOME: home }; delete environment.NODE_PATH
  const host = spawn(process.execPath, [join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'web', '--no-open', '--host', '127.0.0.1', '--port', String(port)], { env: environment })
  let logs = '', browser: Browser | undefined, capture: (() => Promise<void>) | undefined
  host.stdout.on('data', chunk => { logs += String(chunk) }); host.stderr.on('data', chunk => { logs += String(chunk) })
  onTestFinished(async () => {
    await capture?.()
    await writeFile(resolve('.artifacts/quote-follow-host.log'), logs.replace(/(http:\/\/[^?\s]+)\?\S+/gu, '$1?[redacted]'))
    await browser?.close()
    if (host.exitCode === null) {
      const stopped = new Promise<void>(resolve => { host.once('exit', () => resolve()) })
      host.kill('SIGTERM')
      const force = setTimeout(() => { host.kill('SIGKILL') }, 5000)
      await stopped; clearTimeout(force)
    }
    await rm(home, { recursive: true, force: true })
  })
  await expect.poll(() => logs, { timeout: 30_000 }).toMatch(/dsh web: http/)
  const url = logs.match(/dsh web: (http[^\s]+)/)![1]!
  browser = await chromium.launch()
  const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1720, height: 1150 } })
  if (fallback) await page.addInitScript(() => { Reflect.deleteProperty(CSS, 'highlights'); Reflect.deleteProperty(window, 'Highlight') })
  page.setDefaultTimeout(12_000)
  capture = async () => {
    await mkdir(resolve('.artifacts'), { recursive: true })
    await writeFile(resolve('.artifacts/quote-follow-last.txt'), await page.locator('body').ariaSnapshot())
    await page.screenshot({ path: resolve('.artifacts/quote-follow-last.png'), fullPage: true })
  }
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message) })
  await page.goto(url)
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByText('Session canvas', { exact: true }).first().click()
  return { page, errors }
}

it.each(['colors', 'navigation'] as const)('preserves child quote %s after clearing drafts and reloading', async (scenario) => {
  const { page, errors } = await launchCanvasBrowser()
  const canvas = page.locator('[data-session-canvas]')
  await canvas.getByRole('button', { name: 'New canvas', exact: true }).first().click()
  await canvas.getByRole('button', { name: 'New conversation', exact: true }).first().click()
  const parent = canvas.locator('[data-canvas-session]').first()
  await parent.locator('[data-composer-input]').waitFor()
  await parent.getByRole('button', { name: 'Summary', exact: true }).click()
  await parent.getByRole('button', { name: 'Edit Markdown', exact: true }).click()
  const editor = parent.getByRole('textbox', { name: 'Edit Markdown', exact: true })
  const paragraphs = Array.from({ length: 64 }, (_, index) => index === 12 || index === 50 ? 'Repeated selected passage.' : `Paragraph ${index}: context around the selected source.`)
  await editor.fill(paragraphs.join('\n\n')); await editor.press('Escape')
  await parent.locator('[data-canvas-summary] [role="status"]').waitFor({ state: 'hidden' })
  const selected = parent.locator('[data-summary-document] p').filter({ hasText: 'Repeated selected passage.' })
  const quoteAt = async (index: number) => {
    const paragraph = selected.nth(index)
    await paragraph.scrollIntoViewIfNeeded()
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await paragraph.dispatchEvent('pointerdown', { button: 0 })
    await paragraph.evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element)
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })
    await paragraph.dispatchEvent('pointerup', { button: 0 })
    await page.getByRole('menuitem', { name: 'Quote in child conversation', exact: true }).click()
  }
  await quoteAt(0)
  await expect.poll(() => canvas.locator('[data-canvas-session]').count()).toBe(2)
  await canvas.getByRole('button', { name: 'Fit map', exact: true }).click()
  await quoteAt(1)
  await expect.poll(() => canvas.locator('[data-canvas-session]').count()).toBe(3)
  await canvas.getByRole('button', { name: 'Fit map', exact: true }).click()
  const children = canvas.locator('[data-canvas-session]'), red = children.nth(1), orange = children.nth(2)
  const checkColors = async () => {
    for (const [child, tone, index] of [[red, 'red', 0], [orange, 'orange', 1]] as const) {
      await expect.poll(() => page.evaluate(tone => CSS.highlights.get(`session-canvas-quote-${tone}`)?.size ?? 0, tone)).toBe(1)
      expect(await selected.nth(index).evaluate((element, tone) => {
        const range = [...CSS.highlights.get(`session-canvas-quote-${tone}`)!][0] as Range
        return element.contains(range.startContainer) && range.toString() === 'Repeated selected passage.'
      }, tone)).toBe(true)
      const color = await child.evaluate(element => getComputedStyle(element).getPropertyValue('--canvas-branch').trim())
      const colors = await selected.nth(index).evaluate((element, { tone, color }) => {
        const sample = document.createElement('span'); sample.style.backgroundColor = `color-mix(in srgb, ${color} 35%, transparent)`; element.append(sample)
        const expected = getComputedStyle(sample).backgroundColor; sample.remove()
        return { actual: getComputedStyle(element, `::highlight(session-canvas-quote-${tone})`).backgroundColor, expected, color }
      }, { tone, color })
      await writeFile(resolve(`.artifacts/quote-colors-${tone}.json`), JSON.stringify(colors))
      if (colors.actual !== colors.expected) await page.screenshot({ path: resolve('.artifacts/quote-follow-color-failure.png'), fullPage: true })
      expect(colors.actual).toBe(colors.expected)
    }
  }
  if (scenario === 'colors') await checkColors()
  const scroll = parent.locator('[data-canvas-summary]')
  const clickAndCheck = async (child: Locator, index: number) => {
    await scroll.evaluate(element => { element.scrollTop = 0 })
    const viewport = await canvas.locator('[data-canvas-world]').getAttribute('style')
    await child.locator('[data-composer-input]').click()
    await expect.poll(() => selected.nth(index).evaluate(element => {
      const rect = element.getBoundingClientRect(), bounds = element.closest('[data-canvas-summary]')!.getBoundingClientRect()
      return rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1
    })).toBe(true)
    expect(await child.locator('[data-composer-input]').evaluate(element => element.contains(document.activeElement) || element === document.activeElement)).toBe(true)
    expect(await canvas.locator('[data-canvas-world]').getAttribute('style')).toBe(viewport)
  }
  if (scenario === 'navigation') { await clickAndCheck(red, 0); await clickAndCheck(orange, 1) }
  await red.getByRole('button', { name: 'Remove quote', exact: true }).click()
  await orange.getByRole('button', { name: 'Remove quote', exact: true }).click()
  await page.reload()
  await page.getByText('Session canvas', { exact: true }).first().click()
  await canvas.waitFor(); await canvas.getByRole('button', { name: 'Fit map', exact: true }).click()
  if (scenario === 'colors') await checkColors(); if (scenario === 'navigation') { await clickAndCheck(red, 0); await clickAndCheck(orange, 1) }
  const shots = resolve('.artifacts'); await mkdir(shots, { recursive: true })
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme }); if (scenario === 'colors') await checkColors()
    await page.screenshot({ path: join(shots, `quote-follow-${scenario}-${colorScheme}.png`), fullPage: true })
  }
  // A child view control must retain ordinary behavior without following the parent.
  await scroll.evaluate(element => { element.scrollTop = 0 })
  await red.getByRole('button', { name: 'Summary', exact: true }).click()
  expect(await scroll.evaluate(element => element.scrollTop)).toBe(0)
  expect(errors).toEqual([])
})

/** Seed a recorded completed turn; the stock renderer and real UI create the quoted child. */
async function seedChat(home: string, title?: string) {
  const id = 'session-quoted-chat', canvasId = 'quoted-chat'
  const project = `--${home.replaceAll('/', '-').replace(/^-+/u, '')}--`, directory = join(home, 'sessions', project, id)
  const text = Array.from({ length: 48 }, (_, index) => index === 8 || index === 35
    ? `Selected path: \`application_dev\` (passage ${index}).`
    : `Paragraph ${index}: surrounding context in the original conversation.`).join('\n\n')
  const fixture = (await readFile(resolve('tests/fixtures/session.v4.jsonl'), 'utf8')).trim().split('\n')
    .map(line => JSON.parse(line.replaceAll('{{session:1}}', id).replaceAll('{{clientTimeZone}}', 'UTC').replaceAll('{{cwd}}', home)))
    .filter(record => !record.ignorable)
    .map((record, index) => index === 0 ? record : { ...record, seq: index - 1, time: index })
  for (const record of fixture) {
    if (record.type === 'assistant/message') {
      record.data.message.content = [{ type: 'reasoning', text: 'Inspect the selected path.' }, { type: 'text', text }]
      record.data.stream = []
    }
  }
  if (title !== undefined) fixture.push({ type: 'session/title', seq: fixture.length - 1, time: fixture.length,
    data: { title, messageSeqs: [fixture.find(record => record.type === 'user/message' && record.data.source.kind === 'user')!.seq],
      source: { kind: 'provider', provider: 'fixture' } } })
  await mkdir(directory, { recursive: true }); await mkdir(join(home, 'storages'), { recursive: true })
  // The stock log reader requires the header in its own Zstandard frame.
  await writeFile(join(directory, 'session.v4.jsonl.zstd'), Buffer.concat(fixture.map(record => zstdCompressSync(JSON.stringify(record) + '\n'))))
  await writeFile(join(home, 'storages/session_canvas.json'), JSON.stringify({ unit: { name: 'session_canvas', version: 1 }, global: null,
    tables: { canvases: { [canvasId]: { id: canvasId, title: 'Chat quote regression', revision: 1, nodes: [
      { sessionId: id, parentId: null, forkSeq: null, title: 'Parent', x: 80, y: 80, mode: 'chat', collapsed: false },
    ] } }, summaries: { [id]: { sessionId: id, markdown: '', revision: 0, version: 0, versions: [], excerpts: [], draft: null } } },
  }))
}

it('keeps connectors attached while dragging at reduced zoom, after saving, and when cancelling', async () => {
  const { page, errors } = await launchCanvasBrowser(seedChat)
  const canvas = page.locator('[data-session-canvas]')
  const parent = canvas.locator('[data-canvas-session="session-quoted-chat"]')
  const source = parent.locator('[data-chat-flow-kind="assistant-step"]:not([hidden]) [data-text-interaction-source]:visible code').nth(1)
  await source.scrollIntoViewIfNeeded()
  await source.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1 })
  await source.evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  await source.dispatchEvent('pointerup', { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 0 })
  await page.getByRole('button', { name: 'Quote in child conversation', exact: true }).click()
  const child = canvas.locator('[data-canvas-session]').nth(1)
  await child.locator('[data-composer-input]').waitFor()
  const childId = (await child.getAttribute('data-canvas-session'))!
  const position = (card: Locator) => card.evaluate(element => ({ x: (element as HTMLElement).offsetLeft, y: (element as HTMLElement).offsetTop }))
  const assertAttached = async () => {
    await expect.poll(() => page.evaluate(id => {
      const child = document.querySelector<HTMLElement>(`[data-canvas-session="${id}"]`)!
      const parent = document.querySelector<HTMLElement>('[data-canvas-session="session-quoted-chat"]')!
      const path = document.querySelector<SVGPathElement>(`[data-canvas-edge="${id}"]`)!
      const matrix = path.getScreenCTM()!
      const first = path.getPointAtLength(0).matrixTransform(matrix)
      const last = path.getPointAtLength(path.getTotalLength()).matrixTransform(matrix)
      const a = parent.getBoundingClientRect(), b = child.getBoundingClientRect()
      const right = child.offsetLeft >= parent.offsetLeft
      return Math.max(Math.abs(first.x - (right ? a.right : a.left)), Math.abs(first.y - (a.top + a.bottom) / 2),
        Math.abs(last.x - (right ? b.left : b.right)), Math.abs(last.y - (b.top + b.bottom) / 2))
    }, childId)).toBeLessThan(2)
  }
  const halfSize = async () => {
    await canvas.getByRole('button', { name: 'Fit map', exact: true }).click()
    await canvas.getByRole('button', { name: 'Zoom level', exact: true }).click()
    await page.getByRole('menuitem', { name: '50%', exact: true }).click()
  }
  const startDrag = async (card: Locator, dx: number, dy: number) => {
    const bounds = (await card.locator('header').boundingBox())!
    const x = bounds.x + 80, y = bounds.y + bounds.height / 2
    await page.mouse.move(x, y); await page.mouse.down()
    await page.mouse.move(x + dx, y + dy, { steps: 6 })
  }
  await halfSize(); await assertAttached()
  const before = await position(child)
  await startDrag(child, 110, 70)
  await expect.poll(() => position(child)).toEqual({ x: before.x + 220, y: before.y + 140 })
  // This assertion runs before pointerup: a saved-position-only edge cannot pass.
  await assertAttached()
  await page.screenshot({ path: resolve('.artifacts/edge-drag-live.png'), fullPage: true })
  await page.mouse.up()
  await expect.poll(() => canvas.getByRole('button', { name: 'New conversation', exact: true }).isEnabled()).toBe(true)
  const saved = await position(child)
  expect(saved).toEqual({ x: before.x + 220, y: before.y + 140 })
  await page.reload(); await page.getByText('Session canvas', { exact: true }).first().click()
  await child.locator('[data-composer-input]').waitFor()
  expect(await position(child)).toEqual(saved)
  await halfSize(); await assertAttached()
  // The other endpoint follows a parent drag, including the zero-coordinate clamp.
  const originalParent = await position(parent)
  await startDrag(parent, -80, 45)
  await expect.poll(() => position(parent)).toEqual({ x: Math.max(0, originalParent.x - 160), y: originalParent.y + 90 })
  await assertAttached()
  await parent.locator('header').dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse' })
  await page.mouse.up()
  expect(await position(parent)).toEqual(originalParent)
  await assertAttached()
  // Crossing the parent switches the connected sides while the pointer is held.
  await startDrag(child, (0 - saved.x) / 2, -20)
  await expect.poll(() => position(child)).toEqual({ x: 0, y: Math.max(0, saved.y - 40) })
  await assertAttached()
  await child.locator('header').dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse' })
  await page.mouse.up()
  expect(await position(child)).toEqual(saved)
  await assertAttached()
  expect(errors).toEqual([])
})

it('shows the DSH conversation name and persists manual edits through the header control', async () => {
  const { page, errors } = await launchCanvasBrowser(home => seedChat(home, 'Generated conversation name'))
  const canvas = page.locator('[data-session-canvas]'), parent = canvas.locator('[data-canvas-session]').first()
  const label = 'Edit conversation name'
  await expect.poll(() => parent.locator('header span[title]').innerText()).toBe('Generated conversation name')
  await parent.getByRole('button', { name: label, exact: true }).click()
  const input = parent.getByRole('textbox', { name: label, exact: true })
  await input.fill('我自己起的名字')
  await page.screenshot({ path: resolve('.artifacts/session-name-editing.png'), fullPage: true })
  await input.press('Enter')
  await expect.poll(() => parent.locator('header span[title]').innerText()).toBe('我自己起的名字')
  await page.reload(); await page.getByText('Session canvas', { exact: true }).first().click()
  await expect.poll(() => parent.locator('header span[title]').innerText()).toBe('我自己起的名字')
  await parent.getByRole('button', { name: label, exact: true }).click()
  await input.fill('Cancelled edit'); await input.press('Escape')
  await expect.poll(() => parent.locator('header span[title]').innerText()).toBe('我自己起的名字')
  await page.screenshot({ path: resolve('.artifacts/session-name-saved.png'), fullPage: true })
  expect(errors).toEqual([])
})

it.each(['native', 'fallback'] as const)('colors and follows a real chat quote using %s highlights', async (mode) => {
  const { page, errors } = await launchCanvasBrowser(seedChat, mode === 'fallback')
  const canvas = page.locator('[data-session-canvas]'), parent = canvas.locator('[data-canvas-session="session-quoted-chat"]')
  const source = parent.locator('[data-chat-flow-kind="assistant-step"]:not([hidden]) [data-text-interaction-source]:visible code').nth(1)
  await source.waitFor()
  await source.scrollIntoViewIfNeeded()
  await source.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1 })
  await source.evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  await source.dispatchEvent('pointerup', { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 0 })
  await page.getByRole('button', { name: 'Quote in child conversation', exact: true }).click()
  const child = canvas.locator('[data-canvas-session]').nth(1)
  await child.locator('[data-composer-input]').waitFor()
  await canvas.getByRole('button', { name: 'Fit map', exact: true }).click()
  // The real renderer emits two rows for this address; the first is hidden process content.
  expect(await source.evaluate(element => {
    const row = element.closest('[data-chat-seq]')!, card = element.closest('[data-canvas-session]')!
    return Array.from(card.querySelectorAll(`[data-chat-seq="${row.getAttribute('data-chat-seq')}"]`)).map(n => !!n.closest('[hidden]'))
  })).toEqual([true, false])
  const assertColor = async () => {
    if (mode === 'native') {
      await expect.poll(() => page.evaluate(() => [...CSS.highlights.get('session-canvas-quote-red') ?? []].map(range => range.toString()))).toEqual(['application_dev'])
      expect(await source.evaluate(element => element.contains([...CSS.highlights.get('session-canvas-quote-red')!][0]!.startContainer))).toBe(true)
    } else {
      await expect.poll(() => parent.locator('[data-canvas-quote-overlay] [data-quote-tone="red"]').count()).toBe(1)
      const marks = parent.locator('[data-canvas-quote-overlay] [data-quote-tone="red"]')
      const expected = await child.evaluate(element => {
        const sample = document.createElement('span'); sample.style.backgroundColor = 'color-mix(in srgb, var(--canvas-branch) 35%, transparent)'; element.append(sample)
        const color = getComputedStyle(sample).backgroundColor; sample.remove(); return color
      })
      expect(await marks.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(expected)
      const sourceRect = await source.evaluate(element => {
        const range = document.createRange(); range.selectNodeContents(element)
        const rect = range.getBoundingClientRect(); return { x: rect.x, y: rect.y }
      }), markRect = (await marks.boundingBox())!
      expect(Math.abs(markRect.x - sourceRect.x)).toBeLessThan(2)
      expect(Math.abs(markRect.y - sourceRect.y)).toBeLessThan(2)
      expect(await marks.evaluate(element => getComputedStyle(element).pointerEvents)).toBe('none')
    }
  }
  const scroll = parent.locator('[data-chat-scroll]')
  const assertFollow = async (header = false) => {
    await scroll.evaluate(element => { element.scrollTop = 0 })
    const viewport = await canvas.locator('[data-canvas-world]').getAttribute('style')
    if (header) await child.locator('header span[title]').click()
    else await child.locator('[data-composer-input]').click()
    await expect.poll(() => source.evaluate(element => {
      const rect = element.getBoundingClientRect(), bounds = element.closest('[data-chat-scroll]')!.getBoundingClientRect()
      return rect.top >= bounds.top && rect.bottom <= bounds.bottom
    })).toBe(true)
    if (!header) expect(await child.locator('[data-composer-input]').evaluate(element => element.contains(document.activeElement))).toBe(true)
    expect(await canvas.locator('[data-canvas-world]').getAttribute('style')).toBe(viewport)
  }
  await assertColor(); await assertFollow()
  await parent.getByRole('button', { name: /^Completed in /u }).click()
  await assertColor(); await assertFollow(true)
  await child.getByRole('button', { name: 'Remove quote', exact: true }).click()
  await page.reload(); await page.getByText('Session canvas', { exact: true }).first().click()
  await canvas.getByRole('button', { name: 'Fit map', exact: true }).click()
  await assertColor(); await assertFollow()
  if (mode === 'fallback') {
    await canvas.getByRole('button', { name: 'Zoom in', exact: true }).click()
    await assertColor()
    await page.setViewportSize({ width: 1500, height: 1000 })
    await assertColor()
  }
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme }); await assertColor()
    await page.screenshot({ path: resolve(`.artifacts/chat-quote-${mode}-${colorScheme}.png`), fullPage: true })
  }
  expect(errors).toEqual([])
})
