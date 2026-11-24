/** Canvas-local DOM addresses and accessible previews over the stock Chat renderer. */
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { DraftQuoteSource } from './quote-reference.ts'
import { QUOTE_SOURCE } from './quote-reference.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** @param sessionId - viewed Session. @returns selected source and UTF-16 rendered-text offset. */
export function selectedSource(sessionId: SessionId): DraftQuoteSource | undefined {
  const selection = window.getSelection()
  if (selection === null || selection.rangeCount === 0) return
  const range = selection.getRangeAt(0)
  const element = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
  const row = element?.closest<HTMLElement>('[data-chat-seq]')
  const message = element?.closest<HTMLElement>('[data-text-interaction-source]')
  if (row === undefined || row === null || message === undefined || message === null
    || !message.contains(range.endContainer)) return
  const seq = Number(row.dataset.chatSeq), turn = Number(row.dataset.chatTurn)
  if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(turn)) return
  const prefix = range.cloneRange(); prefix.selectNodeContents(message); prefix.setEnd(range.startContainer, range.startOffset)
  return { sessionId, seq, turn, offset: prefix.toString().length }
}

/** Decorate only this plugin's retained card; all listeners and added nodes leave with it. */
export function decorateChat(root: HTMLElement, options: {
  readonly chat: () => ChatSnapshot | undefined
  readonly onMutation: () => void
  readonly forkTurn: (turn: number) => void
  readonly openQuote: (index: number) => void
  readonly removeQuote: (index: number) => void
  readonly sourceLabel: string
  readonly removeLabel: string
  readonly popupClass: string
}): () => void {
  const document = root.ownerDocument
  let popup: HTMLDivElement | null = null
  let hovered: HTMLElement | null = null
  const hide = (): void => { popup?.remove(); popup = null; hovered = null }
  const chips = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(`[data-composer-chip="${QUOTE_SOURCE}"]`)]
  const decorate = (): void => {
    const nodes = options.chat()?.nodes
    for (const row of root.querySelectorAll<HTMLElement>('[data-chat-node-key]')) {
      const node = nodes?.get(row.dataset.chatNodeKey ?? '')
      if (node !== undefined) row.dataset.chatSeq = String(node.anchorSeq)
    }
    const flow = root.querySelector<HTMLElement>('[data-chat-flow]')
    const scroll = flow?.closest<HTMLElement>('[data-conversation-scroll]') ?? flow?.parentElement
    if (scroll !== null && scroll !== undefined) scroll.dataset.chatScroll = ''
    for (const chip of chips()) {
      const label = chip.querySelector<HTMLElement>('[title]')
      if (label === null) continue
      label.setAttribute('data-quote-preview-text', '')
      label.setAttribute('role', 'button'); label.tabIndex = 0
      label.setAttribute('aria-label', options.sourceLabel)
      chip.setAttribute('data-quote-preview', '')
      if (chip.querySelector('[data-canvas-remove-quote]') === null) {
        const button = document.createElement('button')
        button.type = 'button'; button.textContent = '×'; button.setAttribute('aria-label', options.removeLabel)
        button.setAttribute('data-canvas-remove-quote', '')
        chip.append(button)
      }
    }
    if (hovered !== null && !root.contains(hovered)) hide()
    options.onMutation()
  }
  const quoteAt = (event: Event): HTMLElement | null => event.target instanceof Element
    ? event.target.closest<HTMLElement>(`[data-composer-chip="${QUOTE_SOURCE}"]`) : null
  const show = (event: Event): void => {
    const chip = quoteAt(event)
    if (chip === null || chip === hovered) return
    const label = chip.querySelector<HTMLElement>('[title]')
    const text = label?.getAttribute('title')
    if (text === null || text === undefined) return
    hide(); hovered = chip
    popup = document.createElement('div'); popup.className = options.popupClass
    popup.setAttribute('data-quote-popover', ''); popup.setAttribute('role', 'tooltip'); popup.textContent = text
    document.body.append(popup)
    const bounds = chip.getBoundingClientRect(), margin = 12
    const width = Math.min(popup.offsetWidth, window.innerWidth - margin * 2)
    popup.style.left = `${Math.max(margin, Math.min(bounds.left, window.innerWidth - width - margin))}px`
    const height = popup.offsetHeight
    popup.style.top = `${Math.max(margin, bounds.top >= height + margin ? bounds.top - height - 6
      : Math.min(bounds.bottom + 6, window.innerHeight - height - margin))}px`
  }
  const leave = (event: Event): void => {
    const target = event instanceof MouseEvent || event instanceof FocusEvent ? event.relatedTarget : null
    if (target instanceof Node && hovered?.contains(target)) return
    hide()
  }
  const remove = (event: Event): void => {
    if (!(event.target instanceof Element) || !event.target.closest('[data-canvas-remove-quote]')) return
    event.preventDefault(); event.stopPropagation()
    const chip = quoteAt(event)
    if (event.type === 'click' && chip !== null) { hide(); options.removeQuote(chips().indexOf(chip)) }
  }
  const key = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') { hide(); return }
    if (event.key !== 'Enter' && event.key !== ' ') return
    if (!(event.target instanceof Element) || event.target.closest('[data-canvas-remove-quote]')) return
    const chip = quoteAt(event)
    if (chip === null) return
    event.preventDefault(); event.stopPropagation(); hide(); options.openQuote(chips().indexOf(chip))
  }
  const branch = (event: MouseEvent): void => {
    const button = event.target instanceof Element ? event.target.closest('button') : null
    const tail = button?.closest<HTMLElement>('[data-turn-tail]')
    if (button === null || tail === undefined || tail === null || !root.contains(tail)
      || button.querySelector('[data-icon="dsw-icon-branch-outline-regular"]') === null
      || button.disabled || button.getAttribute('aria-disabled') === 'true') return
    event.preventDefault(); event.stopPropagation()
    options.forkTurn(Number(tail.dataset.turnTail))
  }
  const observer = new MutationObserver(decorate)
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] })
  root.addEventListener('pointerover', show); root.addEventListener('pointerout', leave)
  root.addEventListener('focusin', show); root.addEventListener('focusout', leave)
  root.addEventListener('pointerdown', remove, true); root.addEventListener('click', remove, true)
  root.addEventListener('keydown', key, true)
  root.addEventListener('click', branch, true)
  document.addEventListener('scroll', hide, true)
  window.addEventListener('resize', hide)
  decorate()
  return () => {
    observer.disconnect(); hide()
    root.removeEventListener('pointerover', show); root.removeEventListener('pointerout', leave)
    root.removeEventListener('focusin', show); root.removeEventListener('focusout', leave)
    root.removeEventListener('pointerdown', remove, true); root.removeEventListener('click', remove, true)
    root.removeEventListener('keydown', key, true)
    root.removeEventListener('click', branch, true)
    document.removeEventListener('scroll', hide, true); window.removeEventListener('resize', hide)
    for (const element of root.querySelectorAll('[data-canvas-remove-quote]')) element.remove()
  }
}
