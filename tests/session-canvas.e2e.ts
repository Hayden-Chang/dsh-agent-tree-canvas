/** Real optional-plugin composition, snapshot forks, and human notes in the Web UI. */
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import type { Browser, Locator } from 'playwright'
import { expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
import type {} from '@deepseek-ai/dsh-session-canvas'
import { captureStableAria, compareOrRefreshGolden, fixtureUserPrompts, launchWebScaffold, selectedSessionFixture, watchConsole, webSnapshotMode } from '@stock/scaffold'
import type { WebScaffold } from '@stock/scaffold'
import { newEnglishPage, saveFailureShot } from '@stock/support'

const answer = 'A branch keeps its original context. Later conversations develop independently.'
const summary = '# Research notes\n\n- Each branch owns its future conversation.'
const fixturePath = fileURLToPath(new URL('./fixtures/session.v4.jsonl', import.meta.url))
const replayOverride = fileURLToPath(new URL('./fixtures/replay.override.json', import.meta.url))

async function selectMessage(source: Locator): Promise<void> {
  await source.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1 })
  await source.evaluate((element) => {
    const range = document.createRange(); range.selectNodeContents(element)
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  await source.dispatchEvent('pointerup', { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 0 })
}

async function sourceIsVisible(node: Locator): Promise<boolean> {
  return node.locator('[data-canvas-quote-source]').evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const toolbar = document.querySelector('[data-session-canvas] > header')!.getBoundingClientRect()
    const center = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2)
    return rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= toolbar.bottom && rect.bottom <= window.innerHeight
      && center?.closest('[data-canvas-session]') === element.closest('[data-canvas-session]')
  })
}

it('keeps snapshot branches and verbatim human notes separate from the conversation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-canvas-web-'))
  const resources: { scaffold?: WebScaffold; browser?: Browser } = {}
  onTestFinished(async () => {
    try { await resources.browser?.close() } finally {
      try { await resources.scaffold?.close() } finally { await rm(root, { recursive: true, force: true }) }
    }
  })
  const scaffold = resources.scaffold = await launchWebScaffold({
    profile: { packages: [{ dir: process.env.CANVAS_PACKAGE_DIR ?? fileURLToPath(new URL('../packages/session-canvas', import.meta.url)), enabled: true }] },
    replayFixture: fixturePath, replayOverride, compareReplaySession: true,
  })
  const host = scaffold
  const browser = resources.browser = await chromium.launch()
  const page = await newEnglishPage(browser), consoleIssues = watchConsole(page)
  page.setDefaultTimeout(15_000)
  onTestFailed(() => { console.error('Browser errors', consoleIssues) })
  await page.setViewportSize({ width: 1580, height: 1100 })
  onTestFailed(() => saveFailureShot(page, 'web-e2e-session-canvas'))
  await page.goto(host.authenticatedUrl)
  await page.getByText('Session canvas', { exact: true }).first().click()
  const canvas = page.locator('[data-session-canvas]')
  await canvas.getByRole('button', { name: 'New canvas', exact: true }).first().click()
  await canvas.getByRole('button', { name: 'New conversation', exact: true }).first().click()
  const parent = canvas.locator('[data-canvas-session]').first()
  const input = parent.locator('[data-composer-input]')
  await input.waitFor()
  const zoomControls = canvas.getByRole('navigation')
  const shots = fileURLToPath(new URL('../.artifacts', import.meta.url))
  await mkdir(shots, { recursive: true })
  const emptyChatHeight = (await parent.boundingBox())!.height
  expect(emptyChatHeight).toBeLessThan(400)
  await canvas.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await expect.poll(() => zoomControls.textContent()).toContain('120%')
  await canvas.getByRole('button', { name: 'Zoom out', exact: true }).click()
  await expect.poll(() => zoomControls.textContent()).toContain('100%')
  const beforeZoom = (await parent.boundingBox())!
  const pointer = { x: beforeZoom.x + beforeZoom.width / 2, y: beforeZoom.y + 100 }
  await page.mouse.move(pointer.x, pointer.y)
  await page.keyboard.down('Meta')
  await page.mouse.wheel(0, -20)
  await page.keyboard.up('Meta')
  await expect.poll(() => zoomControls.textContent()).toContain('108%')
  const wheelGain = Math.exp(0.08)
  await expect.poll(async () => (await parent.boundingBox())!.width / beforeZoom.width).toBeCloseTo(wheelGain, 5)
  const afterZoom = (await parent.boundingBox())!
  expect((pointer.x - afterZoom.x) / afterZoom.width).toBeCloseTo((pointer.x - beforeZoom.x) / beforeZoom.width, 3)
  expect((pointer.y - afterZoom.y) / afterZoom.height).toBeCloseTo((pointer.y - beforeZoom.y) / beforeZoom.height, 3)
  await canvas.getByLabel('Conversation canvas', { exact: true }).dispatchEvent('wheel', {
    deltaY: -2, ctrlKey: true, clientX: pointer.x, clientY: pointer.y,
  })
  await expect.poll(async () => (await parent.boundingBox())!.width / afterZoom.width).toBeCloseTo(Math.exp(0.02), 5)
  await canvas.getByRole('button', { name: 'Fit map', exact: true }).click()
  const viewport = canvas.getByLabel('Conversation canvas', { exact: true })
  const bounds = (await viewport.boundingBox())!
  const blank = { x: bounds.x + bounds.width - 30, y: bounds.y + 60 }
  const beforePan = (await parent.boundingBox())!
  await page.mouse.move(blank.x, blank.y)
  await page.mouse.wheel(30, 60)
  await expect.poll(async () => (await parent.boundingBox())!.x).toBeCloseTo(beforePan.x - 30)
  expect((await parent.boundingBox())!.y).toBeCloseTo(beforePan.y - 60)
  expect((await parent.boundingBox())!.width).toBeCloseTo(beforePan.width)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(blank.x + 20, blank.y + 25, { steps: 5 })
  await page.mouse.up({ button: 'right' })
  await expect.poll(async () => (await parent.boundingBox())!.x).toBeCloseTo(beforePan.x - 10)
  expect((await parent.boundingBox())!.y).toBeCloseTo(beforePan.y - 35)
  await viewport.press('Control+=')
  await expect.poll(() => zoomControls.textContent()).toContain('120%')
  await viewport.press('Control+0')
  await expect.poll(() => zoomControls.textContent()).toContain('100%')
  await canvas.getByRole('button', { name: 'Zoom level', exact: true }).click()
  await expect.poll(() => page.getByRole('menuitem', { name: '500%', exact: true }).isVisible()).toBe(true)
  await page.screenshot({ path: join(shots, 'zoom-menu-light.png'), fullPage: true })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: join(shots, 'zoom-menu-dark.png'), fullPage: true })
  await page.getByRole('menuitem', { name: '100%', exact: true }).click()
  await page.emulateMedia({ colorScheme: 'light' })
  await canvas.getByRole('button', { name: 'Fit map', exact: true }).click()
  const fixtureText = await readFile(await selectedSessionFixture(fixturePath), 'utf8')
  await input.fill(fixtureUserPrompts(fixtureText)[0]!)
  const settled = host.whenTurnSettled()
  await input.press('Enter')
  const parentId = await settled
  await expect.poll(() => parent.textContent()).toContain(answer)
  const agent = host.ctx.agents.get(parentId)!
  expect(host.ctx.tools.schemas(agent)).toEqual([])
  const source = parent.locator('[data-text-interaction-source]').filter({ hasText: answer }).first()
  await selectMessage(source)
  const selected = await page.evaluate(() => window.getSelection()?.toString())
  expect(await parent.getByRole('button', { name: 'Add to summary', exact: true }).evaluate(element =>
    getComputedStyle(element.parentElement!).backgroundColor)).not.toMatch(/rgba\([^)]*,\s*0\)|transparent/u)
  await parent.getByRole('button', { name: 'Add to summary', exact: true }).click()
  await expect.poll(() => host.ctx.sessionCanvas.summary(parentId).markdown).toBe(selected)
  expect(await input.isVisible()).toBe(true)
  await parent.getByRole('button', { name: 'Summary', exact: true }).click()
  expect(host.ctx.sessionCanvas.summary(parentId).excerpts[0]?.turn).toBe(1)
  await parent.getByText('Excerpts and sources', { exact: true }).click()
  await parent.getByRole('button', { name: 'View source · turn 1', exact: true }).click()
  await expect.poll(() => input.isVisible()).toBe(true)
  await parent.getByRole('button', { name: 'Summary', exact: true }).click()
  await parent.getByText('Excerpts and sources', { exact: true }).click()
  await parent.getByRole('button', { name: 'Update summary', exact: true }).click()
  await parent.getByRole('button', { name: 'Use this draft', exact: true }).waitFor()
  expect(host.ctx.sessionCanvas.summary(parentId).markdown).toBe(selected)
  await parent.getByRole('button', { name: 'Use this draft', exact: true }).click()
  await expect.poll(() => host.ctx.sessionCanvas.summary(parentId).markdown).toBe(summary)
  const unchangedRevision = host.ctx.sessionCanvas.summary(parentId).revision
  await parent.locator('[data-summary-document]').dblclick()
  await parent.getByRole('textbox', { name: 'Edit Markdown', exact: true }).press('Escape')
  expect(host.ctx.sessionCanvas.summary(parentId).revision).toBe(unchangedRevision)
  expect(await page.evaluate(sessionId => localStorage.getItem(`dsh-session-canvas-draft:${sessionId}`), parentId)).toBeNull()
  await parent.getByRole('button', { name: 'Edit Markdown', exact: true }).click()
  const parentEditor = parent.getByRole('textbox', { name: 'Edit Markdown', exact: true })
  await parentEditor.click()
  await parentEditor.press('ControlOrMeta+A')
  await parentEditor.press('Backspace')
  await expect.poll(() => parentEditor.textContent()).toBe('')
  await parentEditor.pressSequentially('# Manual notes')
  await parentEditor.press('Enter')
  await parentEditor.pressSequentially('PRIVATE NOTES')
  await expect.poll(() => host.ctx.sessionCanvas.summary(parentId).markdown).toContain('PRIVATE NOTES')
  await expect.poll(() => parentEditor.locator('h1').textContent()).toBe('Manual notes')
  await parentEditor.press('Escape')
  const beforeFocus = (await parent.boundingBox())!
  await parent.getByRole('button', { name: 'Focus and enlarge node', exact: true }).click()
  await expect.poll(async () => (await parent.boundingBox())!.width).toBeGreaterThan(beforeFocus.width)
  await page.screenshot({ path: join(shots, 'focus.png'), fullPage: true })
  await parent.getByRole('button', { name: 'Return to previous view', exact: true }).click()
  expect((await parent.boundingBox())!.x).toBeCloseTo(beforeFocus.x)
  expect((await parent.boundingBox())!.width).toBeCloseTo(beforeFocus.width)
  await parent.getByRole('button', { name: 'Branch', exact: true }).click()
  await expect.poll(() => host.ctx.sessionCanvas.list()[0]?.nodes.length).toBe(2)
  const tree = host.ctx.sessionCanvas.list()[0]!, childId = tree.nodes[1]!.sessionId
  const child = canvas.locator(`[data-canvas-session="${childId}"]`)
  await child.locator('[data-composer-input]').waitFor()
  expect(await child.locator('[data-chat-turn]:visible').count()).toBe(0)
  expect(await child.innerText()).not.toContain(answer)
  expect(host.ctx.sessionCanvas.summary(childId).markdown).toBe('')
  const childAgent = host.ctx.agents.get(childId)!
  const inherited = host.ctx.sessionProjections.snapshot(childAgent.session).values.sessionCanvas?.messages
  expect(inherited?.every(message => message.inherited)).toBe(true)
  expect(inherited?.some(message => message.text === answer)).toBe(true)
  const chatPositions = tree.nodes.map(({ sessionId, x, y }) => ({ sessionId, x, y }))
  const chatViewport = await canvas.locator('[data-canvas-world]').getAttribute('style')
  await canvas.getByRole('button', { name: 'All summaries', exact: true }).click()
  await expect.poll(() => host.ctx.sessionCanvas.list()[0]?.nodes.map(node => node.mode)).toEqual(['summary', 'summary'])
  await expect.poll(() => parent.locator('header').isVisible()).toBe(false)
  expect(await child.locator('header').isVisible()).toBe(false)
  expect(await canvas.locator('[data-canvas-session] button:visible').count()).toBe(2)
  expect(await canvas.getByRole('button', { name: 'Delete node', exact: true }).count()).toBe(2)
  expect((await child.boundingBox())!.height).toBeLessThan(100)
  expect(await child.evaluate(element => (element as HTMLElement).offsetWidth)).toBe(160)
  expect(host.ctx.sessionCanvas.summary(childId).markdown).toBe('')
  await page.screenshot({ path: join(shots, 'summary-only.png'), fullPage: true })
  await child.locator('[data-summary-document]').dblclick()
  const childEditor = child.getByRole('textbox', { name: 'Edit Markdown', exact: true })
  await childEditor.fill('Short note')
  await expect.poll(() => host.ctx.sessionCanvas.summary(childId).markdown).toContain('Short note')
  const shortHeight = (await child.boundingBox())!.height
  await childEditor.fill(Array.from({ length: 50 }, (_, index) => `Paragraph ${index}: a longer note for scrolling.`).join('\n\n'))
  await expect.poll(async () => (await child.boundingBox())!.height).toBeGreaterThan(shortHeight * 3)
  expect((await child.boundingBox())!.height).toBeLessThanOrEqual(580)
  await expect.poll(async () => {
    const parentBox = (await parent.boundingBox())!, childBox = (await child.boundingBox())!
    return Math.abs(parentBox.y + parentBox.height / 2 - childBox.y - childBox.height / 2)
  }).toBeLessThan(1)
  await childEditor.fill('Short note')
  await childEditor.press('Escape')
  await expect.poll(() => host.ctx.sessionCanvas.summary(childId).markdown).toContain('Short note')
  await expect.poll(async () => (await child.boundingBox())!.height).toBeLessThan(100)
  await canvas.getByRole('button', { name: 'All chats', exact: true }).click()
  await expect.poll(() => parent.locator('header').isVisible()).toBe(true)
  await expect.poll(() => canvas.locator('[data-canvas-world]').getAttribute('style')).toBe(chatViewport)
  expect(host.ctx.sessionCanvas.list()[0]!.nodes.map(({ sessionId, x, y }) => ({ sessionId, x, y }))).toEqual(chatPositions)
  expect(await canvas.locator('[data-canvas-session]').evaluateAll(elements => elements.map(element => ({
    sessionId: (element as HTMLElement).dataset.canvasSession,
    x: (element as HTMLElement).offsetLeft, y: (element as HTMLElement).offsetTop,
  })))).toEqual(chatPositions)
  await parent.getByRole('button', { name: 'Summary', exact: true }).click()
  await expect.poll(() => host.ctx.sessionCanvas.list()[0]?.nodes.map(node => node.mode)).toEqual(['summary', 'chat'])
  await compareOrRefreshGolden(fileURLToPath(new URL('./expected/tree.expected.md', import.meta.url)),
    await captureStableAria(page, '[data-session-canvas]', host.workspaceCwd), webSnapshotMode())
  await page.screenshot({ path: join(shots, 'light.png'), fullPage: true })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: join(shots, 'dark.png'), fullPage: true })
  await page.setViewportSize({ width: 980, height: 800 })
  expect(await canvas.getByRole('button', { name: 'All summaries', exact: true }).isVisible()).toBe(true)
  await page.screenshot({ path: join(shots, 'narrow.png'), fullPage: true })
  await page.setViewportSize({ width: 616, height: 804 })
  await canvas.getByRole('button', { name: 'Fit map', exact: true }).click()
  await parent.getByRole('button', { name: 'Chat', exact: true }).click()
  await source.waitFor({ state: 'visible' })
  await selectMessage(source)
  await parent.getByRole('button', { name: 'Quote in child conversation', exact: true }).click()
  await expect.poll(() => host.ctx.sessionCanvas.list()[0]?.nodes.length).toBe(3)
  const quotedId = host.ctx.sessionCanvas.list()[0]!.nodes[2]!.sessionId
  const quoted = canvas.locator(`[data-canvas-session="${quotedId}"]`)
  await expect.poll(() => quoted.locator('[data-composer-input]').textContent()).toContain(answer)
  await expect.poll(() => quoted.evaluate((element) => {
    const card = element.getBoundingClientRect()
    const toolbar = document.querySelector('[data-session-canvas] > header')!.getBoundingClientRect()
    return { top: card.top, bottom: card.bottom, left: card.left, right: card.right,
      visible: card.top >= toolbar.bottom && card.bottom <= window.innerHeight && card.left >= 0 && card.right <= window.innerWidth }
  })).toMatchObject({ visible: true })
  await expect.poll(() => canvas.getByRole('button', { name: 'Fit map', exact: true }).evaluate((element) => {
    const control = element.getBoundingClientRect()
    return control.bottom <= window.innerHeight && control.top >= window.innerHeight - 80
  })).toBe(true)
  const goToSource = quoted.getByRole('button', { name: 'Go to quoted source', exact: true })
  await goToSource.hover()
  await expect.poll(() => page.locator('[data-quote-popover]').textContent()).toBe(answer)
  await page.screenshot({ path: join(shots, 'quote-hover-dark.png'), fullPage: true })
  await goToSource.click()
  await expect.poll(() => parent.locator('[data-canvas-quote-source]').textContent()).toContain(answer)
  await expect.poll(() => sourceIsVisible(parent)).toBe(true)
  await page.setViewportSize({ width: 1580, height: 1400 })
  await canvas.getByRole('button', { name: 'Fit map', exact: true }).click()
  await parent.getByRole('button', { name: 'Collapse', exact: true }).click()
  await parent.getByRole('button', { name: 'Expand', exact: true }).waitFor()
  await goToSource.press('Enter')
  await expect.poll(() => parent.getByRole('button', { name: 'Collapse', exact: true }).isVisible()).toBe(true)
  await expect.poll(() => parent.locator('[data-canvas-quote-source]').textContent()).toContain(answer)
  await selectMessage(source)
  await page.screenshot({ path: join(shots, 'own-quote-menu.png'), fullPage: true })
  await parent.getByRole('button', { name: 'Quote text', exact: true }).click()
  await parent.getByRole('button', { name: 'Go to quoted source', exact: true }).click()
  await expect.poll(() => parent.locator('[data-canvas-quote-source]').textContent()).toContain(answer)
  await expect.poll(() => sourceIsVisible(parent)).toBe(true)
  expect(await quoted.locator('[data-canvas-quote-source]').count()).toBe(0)
  await compareOrRefreshGolden(fileURLToPath(new URL('./expected/quote-source.expected.md', import.meta.url)),
    await captureStableAria(page, `[data-canvas-session="${parentId}"]`, host.workspaceCwd), webSnapshotMode())
  await page.emulateMedia({ colorScheme: 'light' })
  await canvas.getByRole('button', { name: 'Fit map', exact: true }).hover()
  await parent.getByRole('button', { name: 'Go to quoted source', exact: true }).hover()
  await expect.poll(() => page.locator('[data-quote-popover]').textContent()).toBe(answer)
  await page.screenshot({ path: join(shots, 'quote-hover-light.png'), fullPage: true })
  expect(await quoted.locator('[data-chat-turn]:visible').count()).toBe(0)
  expect(host.ctx.agents.get(quotedId)!.session.snapshotEvents().filter(event => event.type === 'turn/start').length).toBe(1)
  expect(host.ctx.sessionCanvas.summary(parentId).markdown).toContain('PRIVATE NOTES')
  await canvas.getByRole('button', { name: 'Fit map', exact: true }).click()
  await parent.getByRole('button', { name: 'Summary', exact: true }).click()
  await expect.poll(() => host.ctx.sessionCanvas.list()[0]?.nodes.find(node => node.sessionId === parentId)?.mode).toBe('summary')
  // Simulate an existing source-addressed draft saved by the earlier DSH fork.
  await page.evaluate(id => {
    const key = `dsh.conversation.${id}`
    const stored = JSON.parse(localStorage.getItem(key)!)
    const reference = stored.draft.references.find((item: { source: string }) => item.source === 'session-canvas-quote')
    const quote = JSON.parse(reference.ref)
    stored.draft.references = []
    stored.draft.quotes = [{ text: quote.text, source: quote.source, offset: reference.offset, length: reference.length }]
    localStorage.setItem(key, JSON.stringify(stored))
  }, quotedId)
  const catalogRequested = Promise.withResolvers<undefined>(), catalogReady = Promise.withResolvers<undefined>()
  const listSessions = host.ctx.sessionController.list.bind(host.ctx.sessionController)
  const heldCatalog = vi.spyOn(host.ctx.sessionController, 'list').mockImplementation(async (...args) => {
    catalogRequested.resolve(undefined); await catalogReady.promise
    return listSessions(...args)
  })
  try {
    await page.reload()
    await catalogRequested.promise
    await page.getByText('Session canvas', { exact: true }).first().click()
    await expect.poll(() => page.locator('[data-canvas-session]').count()).toBe(3)
    expect(await page.locator(`[data-canvas-session="${parentId}"]`).textContent()).toContain('Loading')
    expect(consoleIssues.pageErrors).toEqual([])
  } finally { catalogReady.resolve(undefined); heldCatalog.mockRestore() }
  await page.locator(`[data-canvas-session="${parentId}"] [data-summary-document]`).waitFor()
  expect(await page.locator(`[data-canvas-session="${parentId}"]`).textContent()).toContain('PRIVATE NOTES')
  const reopened = page.locator(`[data-canvas-session="${quotedId}"]`)
  await expect.poll(() => reopened.locator('[data-composer-input]').textContent()).toContain(answer)
  expect(await reopened.locator('[data-chat-turn]:visible').count()).toBe(0)
  await reopened.getByRole('button', { name: 'Go to quoted source', exact: true }).click()
  await expect.poll(() => page.locator(`[data-canvas-session="${parentId}"] [data-canvas-quote-source]`).textContent()).toContain(answer)
  expect(await page.evaluate(id => localStorage.getItem(`session-canvas.legacy-draft.${id}`), quotedId)).not.toBeNull()
  await reopened.getByRole('button', { name: 'Remove quote', exact: true }).click()
  await expect.poll(() => reopened.locator('[data-composer-chip="session-canvas-quote"]').count()).toBe(0)
  expect(await parent.getByRole('button', { name: 'Go to quoted source', exact: true }).count()).toBe(1)
  // Reuse the recorded conversation to inspect all six branch colors without model calls.
  for (let index = 0; index < 4; index++) await host.ctx.sessionCanvas.fork(tree.id, parentId, null, `Branch ${index + 3}`)
  const styledTree = host.ctx.sessionCanvas.list()[0]!
  const notes = [
    '# 阅读与思考\n\n把一本书，读成自己的知识。\n\n从一段对话出发，让问题沿着不同方向生长。',
    '## 捕捉灵感\n\n留住阅读中打动你的句子，随时补充自己的理解。',
    '## 深入追问\n\n**为什么？还有什么可能？**\n\n沿着一个问题，继续探索。',
    '## 连接知识\n\n- 关联相似概念\n- 比较不同观点\n- 回到原文验证',
    '## 整理笔记\n\n把零散的想法，整理成清晰的 Markdown。',
    '## 形成观点\n\n> 用自己的语言解释，才是理解的开始。',
    '## 付诸行动\n\n选一个值得尝试的想法，带到生活中去。',
  ]
  for (const [index, node] of styledTree.nodes.entries()) await host.ctx.sessionCanvas.saveSummary({
    sessionId: node.sessionId, revision: host.ctx.sessionCanvas.summary(node.sessionId).revision, markdown: notes[index]!,
  })
  await host.ctx.sessionCanvas.arrange(tree.id, styledTree.nodes.map((node, index) => ({
    sessionId: node.sessionId, x: index === 0 ? 676 : index <= 3 ? 32 : 1320,
    y: index === 0 ? 380 : 80 + ((index - 1) % 3) * 300,
  })))
  await canvas.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect.poll(() => canvas.locator('[data-canvas-session]').count()).toBe(7)
  await canvas.getByRole('button', { name: 'All summaries', exact: true }).click()
  await expect.poll(() => canvas.locator('[data-summary-only]').count()).toBe(7)
  await expect.poll(() => canvas.locator('[data-summary-only]').evaluateAll((elements) => {
    const children = elements.slice(1) as HTMLElement[]
    return children.slice(1).map((child, index) => child.offsetTop - (children[index]!.offsetTop + children[index]!.offsetHeight))
  })).toEqual([48, 48, 48, 48, 48])
  await expect.poll(() => canvas.locator('[data-canvas-edge]').evaluateAll(paths => paths.every((element) => {
    const path = element as SVGPathElement
    const child = document.querySelector<HTMLElement>(`[data-canvas-session="${path.dataset.canvasEdge}"]`)!
    const end = path.getPointAtLength(path.getTotalLength())
    return Math.abs(end.x - child.offsetLeft) < 1 && Math.abs(end.y - child.offsetTop - child.offsetHeight / 2) < 1
  }))).toBe(true)
  await page.setViewportSize({ width: 1840, height: 1100 })
  await canvas.getByRole('button', { name: 'Fit map', exact: true }).click()
  await expect.poll(() => canvas.locator('[data-summary-only]').evaluateAll((elements) => {
    const navigation = document.querySelector('[data-canvas-navigation]')!.getBoundingClientRect()
    return elements.every(element => element.getBoundingClientRect().bottom < navigation.top)
  })).toBe(true)
  await compareOrRefreshGolden(fileURLToPath(new URL('./expected/appearance.expected.md', import.meta.url)),
    await captureStableAria(page, '[data-session-canvas]', host.workspaceCwd), webSnapshotMode())
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await page.screenshot({ path: join(shots, `xmind-summary-${colorScheme}.png`), fullPage: true })
    const colors = await canvas.locator('[data-canvas-session]').evaluateAll(elements =>
      elements.map(element => getComputedStyle(element).borderTopColor))
    expect(new Set(colors).size).toBe(7)
    expect(await canvas.locator('[data-summary-only] > header:visible').count()).toBe(0)
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-sidebar-toggle]').waitFor({ state: 'hidden' })
  await expect.poll(async () => (await canvas.boundingBox())!.width).toBe(390)
  await canvas.getByRole('button', { name: 'Fit map', exact: true }).click()
  await page.screenshot({ path: join(shots, 'xmind-summary-mobile.png'), fullPage: true })
  expect(consoleIssues.pageErrors).toEqual([])
  expect(consoleIssues.warnings).toEqual([])
})


it('keeps the composer at the card floor while a long conversation scrolls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-canvas-long-chat-'))
  const resources: { scaffold?: WebScaffold; browser?: Browser } = {}
  onTestFinished(async () => {
    try { await resources.browser?.close() } finally {
      try { await resources.scaffold?.close() } finally { await rm(root, { recursive: true, force: true }) }
    }
  })
  // Expand the recorded answer without changing the replayed Session lifecycle.
  const longAnswer = Array.from({ length: 12 }, (_, index) =>
    `## ${index + 1}. Design a verifiable agent task\n\nKeep the objective clear and the result reviewable. Each session keeps its own history.\n\n- Separate independent work.\n- State the expected result.\n- Review the completed result.`).join('\n\n')
  const fixture = (await readFile(fixturePath, 'utf8')).trim().split('\n')
    .filter(line => JSON.parse(line).type !== 'plugin:session-canvas/summary-request').join('\n')
    .replaceAll(JSON.stringify(answer).slice(1, -1), JSON.stringify(longAnswer).slice(1, -1))
  const longFixture = join(root, 'session.v4.jsonl')
  await writeFile(longFixture, `${fixture}\n`)
  const host = resources.scaffold = await launchWebScaffold({
    profile: { packages: [{ dir: process.env.CANVAS_PACKAGE_DIR ?? fileURLToPath(new URL('../packages/session-canvas', import.meta.url)), enabled: true }] },
    replayFixture: longFixture, compareReplaySession: false,
  })
  const browser = resources.browser = await chromium.launch()
  const page = await newEnglishPage(browser), consoleIssues = watchConsole(page)
  page.setDefaultTimeout(15_000)
  await page.setViewportSize({ width: 1580, height: 1100 })
  onTestFailed(() => saveFailureShot(page, 'web-e2e-session-canvas-composer'))
  await page.goto(host.authenticatedUrl)
  await page.getByText('Session canvas', { exact: true }).first().click()
  const canvas = page.locator('[data-session-canvas]')
  await canvas.getByRole('button', { name: 'New canvas', exact: true }).first().click()
  await canvas.getByRole('button', { name: 'New conversation', exact: true }).first().click()
  const card = canvas.locator('[data-canvas-session]').first()
  const input = card.locator('[data-composer-input]')
  await input.waitFor()
  const emptyHeight = await card.evaluate(element => (element as HTMLElement).offsetHeight)
  expect(emptyHeight).toBeLessThan(400)
  const settled = host.whenTurnSettled()
  await input.fill('Explain snapshot branching.')
  await input.press('Enter')
  await settled
  await expect.poll(() => card.textContent()).toContain('12. Design a verifiable agent task')
  const scroll = card.locator('[data-conversation-scroll]')
  await expect.poll(() => scroll.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(1500)
  const longHeight = await card.evaluate(element => (element as HTMLElement).offsetHeight)
  expect(longHeight).toBeGreaterThan(emptyHeight)
  expect(longHeight).toBeLessThanOrEqual(640)

  const expectComposerAtFloor = async (): Promise<void> => {
    await expect.poll(() => card.evaluate(element => {
      const scroll = element.querySelector('[data-conversation-scroll]')!.getBoundingClientRect()
      const seat = element.querySelector('[data-composer-seat]')!.getBoundingClientRect()
      const card = element.getBoundingClientRect()
      return { bottomGap: Math.round(scroll.bottom - seat.bottom),
        insideCard: seat.top >= scroll.top && seat.bottom <= card.bottom }
    })).toEqual({ bottomGap: 0, insideCard: true })
  }
  for (const scale of ['100%', '50%', '150%']) {
    await canvas.getByRole('button', { name: 'Zoom level', exact: true }).click()
    await page.getByRole('menuitem', { name: scale, exact: true }).click()
    for (const fraction of [0, 0.5, 1]) {
      await scroll.evaluate((element, fraction) => { element.scrollTop = (element.scrollHeight - element.clientHeight) * fraction }, fraction)
      await expectComposerAtFloor()
    }
  }
  await canvas.getByRole('button', { name: 'Fit map', exact: true }).click()
  await input.fill(Array.from({ length: 16 }, (_, index) => `Draft line ${index + 1}`).join('\n'))
  await expectComposerAtFloor()
  await input.fill('')
  await card.getByRole('button', { name: 'Summary', exact: true }).click()
  await card.getByRole('button', { name: 'Chat', exact: true }).click()
  await expectComposerAtFloor()
  await card.getByRole('button', { name: 'Collapse', exact: true }).click()
  await card.getByRole('button', { name: 'Expand', exact: true }).click()
  await expectComposerAtFloor()
  const shots = fileURLToPath(new URL('../.artifacts', import.meta.url))
  await mkdir(shots, { recursive: true })
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await scroll.evaluate(element => { element.scrollTop = (element.scrollHeight - element.clientHeight) / 2 })
    await expectComposerAtFloor()
    await page.screenshot({ path: join(shots, `long-chat-composer-${colorScheme}.png`), fullPage: true })
  }
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight })
  await expect.poll(() => card.locator('[data-chat-flow]').first().evaluate(element => {
    const end = element.getBoundingClientRect().bottom
    const seat = element.closest('[data-conversation-scroll]')!.querySelector('[data-composer-seat]')!.getBoundingClientRect()
    return end <= seat.top
  })).toBe(true)
  expect(consoleIssues.pageErrors).toEqual([])
  expect(consoleIssues.warnings).toEqual([])
})


it('branches turn footer actions into canvas children at the selected snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-canvas-turn-fork-'))
  const resources: { scaffold?: WebScaffold; browser?: Browser } = {}
  onTestFinished(async () => {
    try { await resources.browser?.close() } finally {
      try { await resources.scaffold?.close() } finally { await rm(root, { recursive: true, force: true }) }
    }
  })
  const later = 'LATER ONLY: this belongs to the second turn.'
  const scripts = JSON.parse(await readFile(replayOverride, 'utf8'))
  const turnsOverride = join(root, 'replay.override.json')
  await writeFile(turnsOverride, JSON.stringify([scripts[0],
    JSON.parse(JSON.stringify(scripts[0]).replaceAll(answer, later))]))
  const host = resources.scaffold = await launchWebScaffold({
    profile: { packages: [{ dir: process.env.CANVAS_PACKAGE_DIR ?? fileURLToPath(new URL('../packages/session-canvas', import.meta.url)), enabled: true }] },
    replayFixture: fixturePath, replayOverride: turnsOverride, compareReplaySession: false,
  })
  const browser = resources.browser = await chromium.launch()
  const page = await newEnglishPage(browser), consoleIssues = watchConsole(page)
  page.setDefaultTimeout(15_000)
  await page.setViewportSize({ width: 1580, height: 1100 })
  onTestFailed(() => saveFailureShot(page, 'web-e2e-session-canvas-turn-fork'))
  await page.goto(host.authenticatedUrl)
  await page.getByText('Session canvas', { exact: true }).first().click()
  const canvas = page.locator('[data-session-canvas]')
  await canvas.getByRole('button', { name: 'New canvas', exact: true }).first().click()
  await canvas.getByRole('button', { name: 'New conversation', exact: true }).first().click()
  const parent = canvas.locator('[data-canvas-session]').first()
  const input = parent.locator('[data-composer-input]')
  await input.waitFor()
  let settled = host.whenTurnSettled()
  await input.fill('Explain snapshot branching.')
  await input.press('Enter')
  const parentId = await settled
  await expect.poll(() => parent.textContent()).toContain(answer)
  settled = host.whenTurnSettled()
  await input.fill('Add a second detail.')
  await input.press('Enter')
  await settled
  await expect.poll(() => parent.textContent()).toContain(later)
  const parentAgent = host.ctx.agents.get(parentId)!
  const boundaries = parentAgent.session.snapshotEvents().filter(event => event.type === 'turn/end').map(event => event.seq)
  expect(boundaries).toHaveLength(2)
  const tree = host.ctx.sessionCanvas.list()[0]!
  const footer = (turn: number) => parent.locator(`[data-turn-tail="${turn}"]`)
    .getByRole('button', { name: 'Branch into a new conversation', exact: true })
  await footer(1).click()
  await expect.poll(() => host.ctx.sessionCanvas.list()[0]?.nodes.length).toBe(2)
  expect(await canvas.isVisible()).toBe(true)
  const first = host.ctx.sessionCanvas.list()[0]!.nodes[1]!
  expect(first.parentId).toBe(parentId)
  expect(first.forkSeq).toBe(boundaries[0])
  const child = canvas.locator(`[data-canvas-session="${first.sessionId}"]`)
  await expect.poll(() => child.locator('[data-composer-input]').evaluate(element => element.contains(document.activeElement))).toBe(true)
  expect(await child.locator('[data-chat-turn]:visible').count()).toBe(0)
  const inherited = host.ctx.sessionProjections.snapshot(host.ctx.agents.get(first.sessionId)!.session).values.sessionCanvas!
  expect(inherited.messages.some(message => message.text === answer)).toBe(true)
  expect(inherited.messages.some(message => message.text === later)).toBe(false)
  expect(inherited.messages.every(message => message.inherited)).toBe(true)
  expect(host.ctx.sessionCanvas.summary(first.sessionId).markdown).toBe('')
  await canvas.getByRole('button', { name: 'Fit map', exact: true }).click()
  await footer(2).press('Enter')
  await expect.poll(() => host.ctx.sessionCanvas.list()[0]?.nodes.length).toBe(3)
  const second = host.ctx.sessionCanvas.list()[0]!.nodes[2]!
  expect(second.parentId).toBe(parentId)
  expect(second.forkSeq).toBe(boundaries[1])
  await expect.poll(() => canvas.locator(`[data-canvas-session="${second.sessionId}"] [data-composer-input]`)
    .evaluate(element => element.contains(document.activeElement))).toBe(true)
  expect(host.ctx.sessionProjections.snapshot(host.ctx.agents.get(second.sessionId)!.session)
    .values.sessionCanvas?.messages.some(message => message.text === later)).toBe(true)
  await page.reload()
  await page.getByText('Session canvas', { exact: true }).first().click()
  await expect.poll(() => canvas.locator('[data-canvas-session]').count()).toBe(3)
  expect(host.ctx.sessionCanvas.list()[0]!.id).toBe(tree.id)
  await canvas.getByRole('button', { name: 'Fit map', exact: true }).click()
  await compareOrRefreshGolden(fileURLToPath(new URL('./expected/turn-fork.expected.md', import.meta.url)),
    await captureStableAria(page, '[data-session-canvas]', host.workspaceCwd), webSnapshotMode())
  await page.screenshot({ path: fileURLToPath(new URL('../.artifacts/turn-fork.png', import.meta.url)), fullPage: true })
  // The same Session outside the canvas keeps the stock fork destination.
  await host.ctx.sessionController.rename({ sessionId: parentId, title: 'Original canvas parent' })
  await page.getByRole('button', { name: 'Search sessions', exact: true }).click()
  await page.getByRole('textbox', { name: 'Search session names', exact: true }).fill('Original canvas parent')
  await page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem').click()
  await expect.poll(() => canvas.isVisible()).toBe(false)
  const ordinary = page.locator('[data-conversation-content]:visible [data-turn-tail="2"]')
  await ordinary.getByRole('button', { name: 'Branch into a new conversation', exact: true }).click()
  await expect.poll(() => page.locator('[data-conversation-content]:visible').getAttribute('data-conversation-session')).not.toBe(parentId)
  expect(host.ctx.sessionCanvas.list()[0]!.nodes).toHaveLength(3)
  expect(consoleIssues.pageErrors).toEqual([])
  expect(consoleIssues.warnings).toEqual([])
})


it('quotes summary selections in place or into children and removes confirmed subtrees', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-canvas-summary-actions-'))
  const resources: { scaffold?: WebScaffold; browser?: Browser } = {}
  onTestFinished(async () => {
    try { await resources.browser?.close() } finally {
      try { await resources.scaffold?.close() } finally { await rm(temporary, { recursive: true, force: true }) }
    }
  })
  const scripts = JSON.parse(await readFile(replayOverride, 'utf8'))
  const singleOverride = join(temporary, 'replay.override.json')
  await writeFile(singleOverride, JSON.stringify([scripts[0]]))
  const host = resources.scaffold = await launchWebScaffold({
    profile: { packages: [{ dir: process.env.CANVAS_PACKAGE_DIR ?? fileURLToPath(new URL('../packages/session-canvas', import.meta.url)), enabled: true }] },
    replayFixture: fixturePath, replayOverride: singleOverride, compareReplaySession: false,
  })
  const browser = resources.browser = await chromium.launch()
  const page = await newEnglishPage(browser), issues = watchConsole(page)
  page.setDefaultTimeout(15_000)
  await page.setViewportSize({ width: 1480, height: 1100 })
  onTestFailed(async () => { console.error('Browser errors', issues); await saveFailureShot(page, 'web-e2e-summary-actions') })
  await page.goto(host.authenticatedUrl)
  await page.getByText('Session canvas', { exact: true }).first().click()
  const canvas = page.locator('[data-session-canvas]')
  await canvas.getByRole('button', { name: 'New canvas', exact: true }).first().click()
  await canvas.getByRole('button', { name: 'New conversation', exact: true }).first().click()
  const root = canvas.locator('[data-canvas-session]').first()
  const input = root.locator('[data-composer-input]')
  await input.waitFor()
  const fixtureText = await readFile(await selectedSessionFixture(fixturePath), 'utf8')
  await input.fill(fixtureUserPrompts(fixtureText)[0]!)
  const settled = host.whenTurnSettled(); await input.press('Enter')
  const parentId = await settled
  const tree = host.ctx.sessionCanvas.list()[0]!
  const parent = canvas.locator(`[data-canvas-session="${parentId}"]`)
  const events = host.ctx.agents.get(parentId)!.session.snapshotEvents()
  await input.fill('Continue with this: ')
  await canvas.getByRole('button', { name: 'All summaries', exact: true }).click()
  await parent.locator('[data-summary-document]').dblclick()
  const editor = parent.getByRole('textbox', { name: 'Edit Markdown', exact: true })
  await editor.fill('Before selected summary sentence after.')
  await expect.poll(() => host.ctx.sessionCanvas.summary(parentId).markdown).toContain('selected summary sentence')
  // Selecting while editing preserves the editor; Escape dismisses the menu.
  await selectMessage(editor.locator('p').first())
  await page.getByRole('menuitem', { name: 'Quote text', exact: true }).waitFor()
  await page.keyboard.press('Escape')
  await expect.poll(() => page.getByRole('menuitem', { name: 'Quote text', exact: true }).count()).toBe(0)
  await editor.press('Escape')
  const source = parent.locator('[data-summary-document] p').first()
  const selectPartial = async (): Promise<void> => {
    await source.dispatchEvent('pointerdown', { button: 0 })
    await source.evaluate(element => {
      const text = element.firstChild!, range = document.createRange()
      range.setStart(text, 7); range.setEnd(text, 32)
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })
    await source.dispatchEvent('pointerup', { button: 0 })
  }
  await selectPartial()
  expect(await page.getByRole('menu').getByRole('menuitem').allTextContents()).toEqual(['Quote text', 'Quote in child conversation', 'Generate mind map'])
  const menuBounds = (await page.getByRole('menu').boundingBox())!
  expect(menuBounds.x).toBeGreaterThanOrEqual(0)
  expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(1480)
  const shots = fileURLToPath(new URL('../.artifacts', import.meta.url)); await mkdir(shots, { recursive: true })
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await page.screenshot({ path: join(shots, `summary-menu-${colorScheme}.png`), fullPage: true })
  }
  await compareOrRefreshGolden(fileURLToPath(new URL('./expected/summary-selection.expected.md', import.meta.url)),
    await captureStableAria(page, '[role="menu"]', host.workspaceCwd), webSnapshotMode())
  await page.getByRole('menuitem', { name: 'Quote text', exact: true }).click()
  await expect.poll(() => input.textContent()).toContain('selected summary sentence')
  await expect.poll(() => input.evaluate(element => element.contains(document.activeElement))).toBe(true)
  expect(await input.textContent()).toContain('Continue with this: ')
  expect(host.ctx.sessionCanvas.list()[0]!.nodes).toHaveLength(1)
  expect(host.ctx.agents.get(parentId)!.session.snapshotEvents()).toEqual(events)
  const original = parent.getByRole('button', { name: 'Go to quoted source', exact: true })
  await original.click()
  await expect.poll(() => parent.locator('[data-summary-document][data-canvas-quote-source]').count()).toBe(1)
  // The saved summary reference survives browser reload and still opens notes.
  await page.reload(); await page.getByText('Session canvas', { exact: true }).first().click()
  await parent.getByRole('button', { name: 'Chat', exact: true }).click()
  await original.hover()
  await expect.poll(() => page.locator('[data-quote-popover]').textContent()).toBe('selected summary sentence')
  await original.click()
  await expect.poll(() => parent.locator('[data-summary-document][data-canvas-quote-source]').count()).toBe(1)
  await canvas.getByRole('button', { name: 'All summaries', exact: true }).click()
  await selectPartial()
  await page.getByRole('menuitem', { name: 'Quote in child conversation', exact: true }).click()
  await expect.poll(() => host.ctx.sessionCanvas.list()[0]?.nodes.length).toBe(2)
  const child = host.ctx.sessionCanvas.list()[0]!.nodes.at(-1)!
  const childCard = canvas.locator(`[data-canvas-session="${child.sessionId}"]`)
  await expect.poll(() => childCard.locator('[data-composer-input]').textContent()).toContain('selected summary sentence')
  expect(child.parentId).toBe(parentId)
  expect(host.ctx.sessionProjections.snapshot(host.ctx.agents.get(child.sessionId)!.session)
    .values.sessionCanvas!.messages.every(message => message.inherited)).toBe(true)
  expect(host.ctx.sessionCanvas.summary(child.sessionId).markdown).toBe('')
  await childCard.getByRole('button', { name: 'Go to quoted source', exact: true }).click()
  await expect.poll(() => parent.locator('[data-summary-document][data-canvas-quote-source]').count()).toBe(1)
  // A separate root with notes and no chat can also create a quoted child.
  const blankCanvas = await host.ctx.sessionCanvas.addRoot(tree.id, 'Blank notes')
  const blankId = blankCanvas.nodes.at(-1)!.sessionId
  await host.ctx.sessionCanvas.saveSummary({ sessionId: blankId, revision: 0, markdown: 'A handwritten thought.' })
  await canvas.getByRole('button', { name: 'Refresh', exact: true }).click()
  const blank = canvas.locator(`[data-canvas-session="${blankId}"]`)
  await blank.waitFor()
  await canvas.getByRole('button', { name: 'All summaries', exact: true }).click()
  await blank.locator('[data-summary-document] p').waitFor({ state: 'visible' })
  await selectMessage(blank.locator('[data-summary-document] p'))
  await page.getByRole('menuitem', { name: 'Quote in child conversation', exact: true }).click()
  await expect.poll(() => host.ctx.sessionCanvas.list()[0]?.nodes.length).toBe(4)
  const emptyChild = host.ctx.sessionCanvas.list()[0]!.nodes.at(-1)!
  expect(emptyChild).toMatchObject({ parentId: blankId, forkSeq: null })
  await expect.poll(() => canvas.locator(`[data-canvas-session="${emptyChild.sessionId}"] [data-composer-input]`).textContent()).toContain('A handwritten thought.')
  await canvas.getByRole('button', { name: 'All summaries', exact: true }).click()
  await parent.hover()
  await parent.getByRole('button', { name: 'Delete node', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Permanently delete 2 nodes?', exact: true })
  await dialog.waitFor()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(host.ctx.sessionCanvas.list()[0]!.nodes).toHaveLength(4)
  await parent.hover()
  await parent.getByRole('button', { name: 'Delete node', exact: true }).click()
  await dialog.evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)) })
  expect(await dialog.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
  await page.screenshot({ path: join(shots, 'delete-subtree.png'), fullPage: true })
  await compareOrRefreshGolden(fileURLToPath(new URL('./expected/delete-subtree.expected.md', import.meta.url)),
    await captureStableAria(page, '[role="dialog"]', host.workspaceCwd), webSnapshotMode())
  const deletedHeaders = [parentId, child.sessionId].map(id => host.ctx.sessions.get(id)!.header)
  const deletedPaths = await Promise.all(deletedHeaders.map(async header => {
    await host.ctx.sessions.flush(host.ctx.sessions.get(header.id)!)
    const stored = await host.ctx.sessionPersistence.stat(header.id)
    if (stored?.location?.kind !== 'jsonl') throw new Error('Expected stock JSONL')
    return dirname(stored.location.path)
  }))
  const indexedBefore = await host.ctx.sessionQuery.searchSessions({ query: 'branch', limit: 100 })
  expect(indexedBefore.items.some(hit => hit.header.id === parentId)).toBe(true)
  await dialog.getByRole('button', { name: 'Delete permanently', exact: true }).click()
  await expect.poll(() => host.ctx.sessionCanvas.list()[0]!.nodes.map(node => node.sessionId)).toEqual([blankId, emptyChild.sessionId])
  await expect.poll(() => parent.count()).toBe(0)
  await expect.poll(() => childCard.count()).toBe(0)
  for (const id of [parentId, child.sessionId]) {
    expect(host.ctx.agents.get(id)).toBeUndefined()
    expect(host.ctx.sessions.get(id)).toBeUndefined()
    expect(await host.ctx.sessionPersistence.stat(id)).toBeUndefined()
    expect(() => host.ctx.sessionCanvas.summary(id)).toThrow()
    expect(await page.evaluate(id => localStorage.getItem(`dsh.conversation.${id}`), id)).toBeNull()
  }
  for (const path of deletedPaths) await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' })
  for (const header of deletedHeaders) expect(host.ctx.sessionProjectionCache.cachedSnapshot(header)).toBeUndefined()
  const hits = await host.ctx.sessionQuery.searchSessions({ query: 'branch', limit: 100 })
  expect(hits.items.some(hit => deletedHeaders.some(header => header.id === hit.header.id))).toBe(false)
  expect(host.ctx.sessionCanvas.summary(blankId).markdown).toBe('A handwritten thought.')
  await page.reload(); await page.getByText('Session canvas', { exact: true }).first().click()
  await expect.poll(() => canvas.locator('[data-canvas-session]').count()).toBe(2)
  expect(issues.pageErrors).toEqual([])
})


it('generates mind maps from chat and summary selections and restores frozen focus for follow-up', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-canvas-mindmap-'))
  const resources: { scaffold?: WebScaffold; browser?: Browser } = {}
  onTestFinished(async () => {
    try { await resources.browser?.close() } finally {
      try { await resources.scaffold?.close() } finally { await rm(temporary, { recursive: true, force: true }) }
    }
  })
  const material = '## 评测维度\n\n| 维度 | 典型指标 | 说明 |\n| --- | --- | --- |\n| 结果 | pass@k、pass^k | 至少一次成功、全部成功的稳定性 |\n| 过程 | 步数 | 同样成功，20 步和 3 步不同 |\n\n关键原则：**结果指标不可省，过程指标不可滥**。'
  const nodes = [{ depth: 0, text: '评测维度' }, { depth: 1, text: '**结果**' },
    { depth: 2, text: 'pass@k：至少一次成功' }, { depth: 2, text: 'pass^k：全部成功的稳定性' },
    { depth: 1, text: '过程：步数' }, { depth: 1, text: '关键原则：**结果指标不可省，过程指标不可滥**。' }]
  const script = (text: string) => ({ kind: 'chunks', chunks: [
    { type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } },
  ] })
  const override = join(temporary, 'replay.override.json')
  const acceptedReview = script('{"replacements":[],"append":[]}')
  const coarseDraft = script(JSON.stringify({ nodes: [{ depth: 0, text: '评测维度：结果包含 pass@k、pass^k，过程包含步数。' }] }))
  const repairedReview = script(JSON.stringify({ replacements: [{ index: 0, reason: 'Distinct metrics belong under their categories.', nodes }], append: [] }))
  await writeFile(override, JSON.stringify([script(material), script('{"nodes":[]}'), acceptedReview, coarseDraft, repairedReview,
    script(JSON.stringify({ nodes: [{ depth: 0, text: '笔记中的主题' }, { depth: 1, text: '只整理选中的原文' }] })), acceptedReview]))
  const host = resources.scaffold = await launchWebScaffold({
    profile: { packages: [{ dir: process.env.CANVAS_PACKAGE_DIR ?? fileURLToPath(new URL('../packages/session-canvas', import.meta.url)), enabled: true }] },
    replayFixture: fixturePath, replayOverride: override, replayChildFixtures: [fixturePath], compareReplaySession: false,
  })
  const requests: { sessionId: string | undefined; messages: unknown }[] = []
  host.ctx.on('llm/stream', (options, next) => { requests.push({ sessionId: options.sessionId, messages: options.messages }); return next() }, { prepend: true })
  const browser = resources.browser = await chromium.launch()
  const page = await newEnglishPage(browser), issues = watchConsole(page)
  page.setDefaultTimeout(15000)
  await page.setViewportSize({ width: 1580, height: 1100 })
  onTestFailed(async () => { console.error('Browser errors', issues); await saveFailureShot(page, 'web-e2e-mindmap') })
  await page.goto(host.authenticatedUrl)
  await page.getByText('Session canvas', { exact: true }).first().click()
  const canvas = page.locator('[data-session-canvas]')
  const toolbar = canvas.locator(':scope > header')
  await toolbar.getByRole('button', { name: 'New canvas', exact: true }).click()
  await toolbar.getByRole('button', { name: 'New conversation', exact: true }).click()
  const parent = canvas.locator('[data-canvas-session]').first()
  const deletion = parent.getByRole('button', { name: 'Delete node', exact: true })
  const deleteOpacity = () => deletion.evaluate(element => getComputedStyle(element.closest('[class*=deleteNode]')!).opacity)
  await toolbar.hover()
  await expect.poll(deleteOpacity).toBe('0')
  await parent.hover()
  await expect.poll(deleteOpacity).toBe('1')
  await toolbar.hover(); await deletion.focus()
  await expect.poll(deleteOpacity).toBe('1')
  const input = parent.locator('[data-composer-input]')
  await input.focus()
  await expect.poll(deleteOpacity).toBe('0')
  await input.fill('把评测维度整理出来。')
  const settled = host.whenTurnSettled(); await input.press('Enter'); const parentId = await settled
  const source = parent.locator('[data-text-interaction-source]').filter({ hasText: '评测维度' }).first()
  await selectMessage(source)
  const selected = await page.evaluate(() => window.getSelection()!.toString())
  await parent.getByRole('button', { name: 'Generate mind map', exact: true }).click()
  await expect.poll(() => page.getByRole('alert').textContent()).toContain('no useful subdivision')
  expect(host.ctx.sessionCanvas.list()[0]!.nodes).toHaveLength(1)
  expect(await parent.getAttribute('data-summary-only')).toBeNull()
  await compareOrRefreshGolden(fileURLToPath(new URL('./expected/mindmap-unchanged.expected.md', import.meta.url)),
    await captureStableAria(page, '[role="alert"]', host.workspaceCwd), webSnapshotMode())
  const unchangedShots = fileURLToPath(new URL('../.artifacts', import.meta.url))
  await mkdir(unchangedShots, { recursive: true })
  await page.screenshot({ path: join(unchangedShots, 'mindmap-unchanged.png'), fullPage: true })
  await selectMessage(source)
  await parent.getByRole('button', { name: 'Generate mind map', exact: true }).click()
  await expect.poll(() => host.ctx.sessionCanvas.list()[0]?.nodes.length).toBe(7)
  const tree = host.ctx.sessionCanvas.list()[0]!
  expect(tree.nodes[1]!.parentId).toBe(parentId)
  expect(tree.nodes[3]!.parentId).toBe(tree.nodes[2]!.sessionId)
  expect(tree.nodes.slice(1).map(node => host.ctx.sessionCanvas.summary(node.sessionId).markdown)).toEqual(nodes.map(node => node.text))
  await expect.poll(() => canvas.locator('[data-canvas-session][data-summary-only]').count()).toBe(7)
  await expect.poll(() => canvas.locator('[data-summary-document]').allTextContents()).toContain('pass@k：至少一次成功')
  await parent.hover(); await expect.poll(deleteOpacity).toBe('1')
  await toolbar.hover(); await expect.poll(deleteOpacity).toBe('0')
  const sourceSummary = '笔记中的主题：只整理选中的原文。'
  await host.ctx.sessionCanvas.saveSummary({ sessionId: parentId, revision: 0, markdown: sourceSummary })
  await toolbar.getByRole('button', { name: 'Refresh', exact: true }).click()
  const note = parent.locator('[data-summary-document] p')
  await expect.poll(() => note.textContent()).toBe(sourceSummary)
  await selectMessage(note)
  await page.getByRole('menuitem', { name: 'Generate mind map', exact: true }).click()
  await expect.poll(() => host.ctx.sessionCanvas.list()[0]?.nodes.length).toBe(9)
  expect(host.ctx.sessionCanvas.summary(parentId).markdown).toBe(sourceSummary)
  await expect.poll(() => canvas.locator('[data-summary-document]').allTextContents()).toContain('只整理选中的原文')
  await toolbar.hover()
  await compareOrRefreshGolden(fileURLToPath(new URL('./expected/mindmap.expected.md', import.meta.url)),
    await captureStableAria(page, '[data-session-canvas]', host.workspaceCwd), webSnapshotMode())
  const shots = fileURLToPath(new URL('../.artifacts', import.meta.url)); await mkdir(shots, { recursive: true })
  await page.screenshot({ path: join(shots, 'mindmap.png'), fullPage: true })
  const leafId = tree.nodes[3]!.sessionId
  const leaf = canvas.locator(`[data-canvas-session="${leafId}"]`)
  await leaf.locator('[data-summary-document]').dblclick()
  const editor = leaf.getByRole('textbox', { name: 'Edit Markdown', exact: true })
  await editor.fill('MANUAL EDIT MUST NOT ENTER CHAT')
  await editor.press('Escape')
  await expect.poll(() => host.ctx.sessionCanvas.summary(leafId).markdown).toContain('MANUAL EDIT')
  await page.reload(); await page.getByText('Session canvas', { exact: true }).first().click()
  await expect.poll(() => canvas.locator('[data-canvas-session]').count()).toBe(9)
  await toolbar.getByRole('button', { name: 'All chats', exact: true }).click()
  await canvas.getByRole('button', { name: 'Fit map', exact: true }).click()
  const leafInput = leaf.locator('[data-composer-input]')
  await leafInput.fill('展开讲讲')
  const followup = host.whenTurnSettled(); await leafInput.press('Enter'); expect(await followup).toBe(leafId)
  const request = requests.find(request => request.sessionId === leafId)!
  const modelText = JSON.stringify(request.messages)
  expect(modelText).toContain('评测维度')
  expect(modelText).toContain('pass@k：至少一次成功')
  expect(modelText).toContain('session-canvas-mindmap')
  expect(modelText).not.toContain('MANUAL EDIT MUST NOT ENTER CHAT')
  const logged = host.ctx.agents.get(leafId)!.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'session-canvas-mindmap')
  expect(logged).toHaveLength(1)
  const delivered = logged[0]!
  if (delivered.type !== 'user/message') throw new Error('Expected sourced user message')
  const contextText = delivered.data.content.filter(block => block.type === 'text').map(block => block.text).join('')
  const frozen = JSON.parse(contextText.slice(contextText.indexOf('{')))
  expect(frozen.selection).toBe(selected)
  expect(frozen.path).toEqual(['New conversation', '评测维度', '**结果**', 'pass@k：至少一次成功'])
  const current = host.ctx.sessionCanvas.list()[0]!
  const selectedTreeRoot = current.nodes[1]!
  const before = new Set(current.nodes.map(node => node.sessionId))
  const remainder = await host.ctx.sessionCanvas.removeNode(current.id, selectedTreeRoot.sessionId)
  const survivors = new Set(remainder.nodes.map(node => node.sessionId))
  expect(survivors.has(leafId)).toBe(false)
  for (const id of before) if (!survivors.has(id)) {
    expect(await host.ctx.sessionPersistence.stat(id)).toBeUndefined()
    expect(host.ctx.storageDomain.get('session_projcache')!.table('sessions').get(id)).toBeUndefined()
    expect(() => host.ctx.sessionCanvas.summary(id)).toThrow()
  }
  await expect(host.ctx.sessionQuery.observeSession(leafId)).rejects.toThrow()
  expect(issues.pageErrors).toEqual([])
  expect(issues.warnings).toEqual([])
})


it('deletes an actively streaming conversation without late history or cache resurrection', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-canvas-delete-running-'))
  const resources: { scaffold?: WebScaffold; browser?: Browser } = {}
  onTestFinished(async () => {
    try { await resources.browser?.close() } finally {
      try { await resources.scaffold?.close() } finally { await rm(temporary, { recursive: true, force: true }) }
    }
  })
  const scripts = JSON.parse(await readFile(replayOverride, 'utf8'))
  const override = join(temporary, 'replay.override.json')
  await writeFile(override, JSON.stringify([scripts[0]]))
  const host = resources.scaffold = await launchWebScaffold({
    profile: { packages: [{ dir: process.env.CANVAS_PACKAGE_DIR ?? fileURLToPath(new URL('../packages/session-canvas', import.meta.url)), enabled: true }] },
    replayFixture: fixturePath, replayOverride: override, compareReplaySession: false, paceMs: 1500,
  })
  const browser = resources.browser = await chromium.launch()
  const page = await newEnglishPage(browser), issues = watchConsole(page)
  page.setDefaultTimeout(15_000)
  await page.goto(host.authenticatedUrl)
  await page.getByText('Session canvas', { exact: true }).first().click()
  const canvas = page.locator('[data-session-canvas]')
  await canvas.getByRole('button', { name: 'New canvas', exact: true }).first().click()
  await canvas.getByRole('button', { name: 'New conversation', exact: true }).first().click()
  const input = canvas.locator('[data-composer-input]')
  await input.waitFor()
  const tree = host.ctx.sessionCanvas.list()[0]!, id = tree.nodes[0]!.sessionId
  const agent = host.ctx.agents.get(id)!
  await input.fill('Explain snapshot branching.')
  await input.press('Enter')
  await vi.waitFor(() => expect(agent.status).toBe('running'))
  await expect.poll(() => canvas.textContent(), { timeout: 10000 }).toContain(answer)
  expect(agent.status).toBe('running')
  await host.ctx.sessionCanvas.removeNode(tree.id, id)
  expect(host.ctx.agents.get(id)).toBeUndefined()
  expect(host.ctx.sessions.get(id)).toBeUndefined()
  expect(await host.ctx.sessionPersistence.stat(id)).toBeUndefined()
  expect(host.ctx.storageDomain.get('session_projcache')!.table('sessions').get(id)).toBeUndefined()
  await page.reload(); await page.getByText('Session canvas', { exact: true }).first().click()
  await expect.poll(() => canvas.locator('[data-canvas-session]').count()).toBe(0)
  expect(await host.ctx.sessionPersistence.stat(id)).toBeUndefined()
  expect(host.ctx.storageDomain.get('session_projcache')!.table('sessions').get(id)).toBeUndefined()
  expect(issues.pageErrors).toEqual([])
})

it('deletes eight nodes with stock full-text search disabled and preserves unrelated data', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'canvas-search-disabled-'))
  const override = join(temporary, 'replay.override.json')
  const scripts = JSON.parse(await readFile(replayOverride, 'utf8'))
  await writeFile(override, JSON.stringify([scripts[0]]))
  const resources: { scaffold?: WebScaffold; browser?: Browser } = {}
  onTestFinished(async () => {
    try { await resources.browser?.close() } finally { try { await resources.scaffold?.close() } finally { await rm(temporary, { recursive: true, force: true }) } }
  })
  const host = resources.scaffold = await launchWebScaffold({
    profile: { packages: [{ dir: process.env.CANVAS_PACKAGE_DIR ?? fileURLToPath(new URL('../packages/session-canvas', import.meta.url)), enabled: true }] },
    replayFixture: fixturePath, replayOverride: override, compareReplaySession: false,
  })
  const search = [...host.ctx.loader.entries()].find(entry => entry.options.id === 'session-query-sqlite')
  if (search === undefined) throw new Error('Stock search service is absent')
  await search.update({ config: { path: ':memory:', openAt: 'never' } })
  await host.ctx.loader.await()
  await expect(host.ctx.sessionQuery.searchSessions({ query: 'test' })).rejects.toMatchObject({ code: 'SESSION_QUERY_SEARCH_DISABLED' })
  const browser = resources.browser = await chromium.launch()
  const page = await newEnglishPage(browser), issues = watchConsole(page)
  page.setDefaultTimeout(15_000)
  await page.setViewportSize({ width: 1480, height: 1100 })
  await page.goto(host.authenticatedUrl)
  await page.getByText('Session canvas', { exact: true }).first().click()
  const panel = page.locator('[data-session-canvas]')
  await panel.getByRole('button', { name: 'New canvas', exact: true }).first().click()
  await panel.getByRole('button', { name: 'New conversation', exact: true }).first().click()
  const root = panel.locator('[data-canvas-session]').first()
  const text = await readFile(await selectedSessionFixture(fixturePath), 'utf8')
  await root.locator('[data-composer-input]').fill(fixtureUserPrompts(text)[0]!)
  const settled = host.whenTurnSettled()
  await root.locator('[data-composer-input]').press('Enter')
  const rootId = await settled
  let canvas = host.ctx.sessionCanvas.list()[0]!
  const ids = [rootId]
  for (let index = 0; index < 7; index++) {
    canvas = await host.ctx.sessionCanvas.fork(canvas.id, ids[Math.floor(index / 2)]!, null, 'Descendant ' + index)
    ids.push(canvas.nodes.at(-1)!.sessionId)
  }
  for (const id of ids) {
    await host.ctx.sessionCanvas.excerpt(id, 'Private original excerpt', null)
    await host.ctx.sessionCanvas.saveSummary({ sessionId: id, revision: 1, markdown: 'Edited private summary' })
    expect(await host.ctx.sessionPersistence.stat(id)).toBeDefined()
  }
  canvas = await host.ctx.sessionCanvas.addRoot(canvas.id, 'Survivor')
  const survivor = canvas.nodes.at(-1)!.sessionId
  await host.ctx.sessionCanvas.excerpt(survivor, 'Surviving notes', null)
  await panel.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect.poll(() => panel.locator('[data-canvas-session]').count()).toBe(9)
  await panel.getByRole('button', { name: 'All summaries', exact: true }).click()
  await root.hover()
  await root.getByRole('button', { name: 'Delete node', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect.poll(() => dialog.textContent()).toContain('8 nodes')
  const searchFailure = vi.spyOn(host.ctx.sessionQuery, 'searchSessions').mockRejectedValueOnce(new Error('Search index unavailable'))
  try {
    await dialog.getByRole('button', { name: 'Delete permanently', exact: true }).click()
    await expect.poll(() => page.getByRole('alert').textContent()).toContain('No node data was deleted')
    expect(host.ctx.sessionCanvas.list()[0]!.nodes).toHaveLength(9)
    for (const id of ids) {
      expect(await host.ctx.sessionPersistence.stat(id)).toBeDefined()
      expect(host.ctx.sessionCanvas.summary(id).markdown).toBe('Edited private summary')
    }
    await compareOrRefreshGolden(fileURLToPath(new URL('./expected/delete-not-started.expected.md', import.meta.url)),
      await captureStableAria(page, '[role="alert"]', host.workspaceCwd), webSnapshotMode())
  } finally { searchFailure.mockRestore() }
  await dialog.getByRole('button', { name: 'Delete permanently', exact: true }).click()
  await expect.poll(() => host.ctx.sessionCanvas.list()[0]!.nodes.length, { timeout: 5000 }).toBe(1)
  await expect.poll(() => panel.locator('[data-canvas-session]').count()).toBe(1)
  for (const id of ids) {
    expect(await host.ctx.sessionPersistence.stat(id)).toBeUndefined()
    expect(host.ctx.agents.get(id)).toBeUndefined()
    expect(host.ctx.storageDomain.get('session_projcache')!.table('sessions').get(id)).toBeUndefined()
    expect(() => host.ctx.sessionCanvas.summary(id)).toThrow()
  }
  expect(host.ctx.sessionCanvas.summary(survivor).markdown).toBe('Surviving notes')
  await expect(host.ctx.sessionQuery.searchSessions({ query: 'test' })).rejects.toMatchObject({ code: 'SESSION_QUERY_SEARCH_DISABLED' })
  await page.reload()
  await page.getByText('Session canvas', { exact: true }).first().click()
  await expect.poll(() => panel.locator('[data-canvas-session]').count()).toBe(1)
  expect(issues.pageErrors).toEqual([])
  expect(issues.warnings).toEqual([])
})
