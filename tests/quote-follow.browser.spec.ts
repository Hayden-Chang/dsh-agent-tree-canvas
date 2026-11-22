/** Real canvas selection, child colors, parent scrolling, and durable reload. */
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import type { Browser, Locator } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'

it.each(['colors', 'navigation'] as const)('preserves child quote %s after clearing drafts and reloading', async (scenario) => {
  const runtime = process.env.DSH_RUNTIME_ROOT
  if (!runtime) throw new Error('Set DSH_RUNTIME_ROOT to an installed DSH 0.2.2-rc.1 runtime containing node_modules')
  const home = await mkdtemp(join(tmpdir(), 'canvas-quote-follow-'))
  const profile = join(home, 'profiles/web'), plugin = resolve('packages/session-canvas')
  await mkdir(join(profile, 'node_modules/@deepseek-ai'), { recursive: true })
  await symlink(plugin, join(profile, 'node_modules/@deepseek-ai/dsh-session-canvas'))
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'canvas-browser-test', private: true,
    dependencies: { '@deepseek-ai/dsh-session-canvas': `link:${plugin}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-session-canvas'] } },
  }))
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
