/** Optional Remote, resource, page, and selection-action composition. */
import type { Context } from '@deepseek-ai/cordis'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { quoteTrigger, migrateQuoteDraft } from './quote-reference.ts'
import type { CanvasId, CanvasNode } from '../types.ts'
import { CanvasController } from './controller.ts'
import { bindCanvasNavigation } from './navigation.ts'
import type { CanvasNavigation } from './navigation.ts'
import type { ZoomOptions } from '../zoom-options.ts'
import { createDraftJournal } from './draft-journal.ts'
import { CanvasPage, CanvasCard, CanvasContent, CanvasIcon, CanvasToast, SelectionActions, CanvasTurns } from './view.tsx'
import { NS, en, zh, type CanvasKey } from './locales.ts'

const PANEL = 'session-canvas' as MainPanelId
const INTERACTION = 'session-canvas'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { sessionCanvas: CanvasKey }
  interface ResourceProtocolMap { canvaschat: { readonly reference: SessionReference } }
  interface SlotFactoryMap {
    'session-canvas.turns': { scope: 'session'; props: Record<never, never>; inject: CanvasController['face']; locale: 'sessionCanvas' }
  }
  interface SlotMap {
    /** Supply canvas identity, node placement, and zoom to replace a card; absence leaves no card. */
    'session-canvas.node': {
      kind: 'single'
      scope: 'root'
      owner: {
        readonly canvasId: CanvasId
        readonly node: CanvasNode
        readonly scale: number
        readonly focused?: boolean
        readonly onFocus?: () => void
        /** Report unscaled card dimensions after mount, resize, and view changes. */
        readonly onMeasure?: (id: SessionId,
          size: { readonly width: number; readonly height: number; readonly summaryOnly: boolean }) => void
      }
    }
    /** Supply the node and canvas within its retained Session to replace chat and summary content; absence leaves an empty card body. */
    'session-canvas.content': { kind: 'single'; scope: 'session'; owner: { readonly canvasId: CanvasId; readonly node: CanvasNode } }
  }
}
declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap { sessionCanvas: unknown }
}

/** Browser services used to assemble the optional plugin. */
export const inject = ['remote', 'slots', 'locale', 'layout', 'resources', 'sessions', 'uiConversation', 'conversation', 'inputTriggers']

/**
 * Mount the generated Remote before UI consumers, then withdraw UI before Remote disposal.
 * @param ctx - plugin lifetime.
 * @param contribution - generated Session canvas methods.
 * @param zoomOptions - validated browser gesture gains.
 * @param autosaveDelayMs - idle delay before saving summary edits.
 * @returns combined asynchronous disposer.
 */
export async function mountCanvas(
  ctx: Context, contribution: TypertRemoteContribution, zoomOptions: ZoomOptions, autosaveDelayMs: number,
): Promise<() => Promise<void>> {
  const unmount = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.sessionCanvas', ...inject.slice(1)], (scope) => {
    const controller = new CanvasController(scope, () => { scope.layout.selectPanel(PANEL) },
      autosaveDelayMs, createDraftJournal(localStorage))
    scope.effect(() => () => controller.dispose())
    scope.effect(() => scope.locale.register(NS, { en, zh }))
    const face = controller.face
    const mountSummaryEditor = (id: SessionId, element: HTMLElement) => scope.effect(() => controller.mountEditor(id, element))
    const bindNavigation = (element: HTMLElement, actions: CanvasNavigation) =>
      scope.effect(() => bindCanvasNavigation(element, zoomOptions, actions))
    scope.effect(() => scope.inputTriggers.registerSource(quoteTrigger((sessionId, text, source) =>
      controller.openReference(sessionId, text, source))))
    scope.on('connection/reset', () => { controller.reload() })
    scope.effect(() => scope.resources.register({
      protocol: 'canvaschat',
      async *open(address, { signal }) {
        const id = decodeURIComponent(new URL(address).pathname.slice(1)) as SessionId
        signal.throwIfAborted()
        if (scope.sessions.list.getSnapshot().byId[id] === undefined) await scope.sessions.refresh()
        signal.throwIfAborted()
        migrateQuoteDraft(localStorage, id)
        const reference = scope.sessions.retain(id, { source: 'sessionCanvas', signal })
        try {
          face.loadSummary(id)
          const binding = await reference.ready
          signal.throwIfAborted()
          controller.prepareChat(binding)
          yield { ok: true, value: { reference } }
          if (!signal.aborted) await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
        } finally { reference.release() }
      },
    }))
    scope.slots.inject('main', () => scope.slots.register({ name: 'main', key: PANEL, locale: NS,
      inject: () => ({ ...face, bindNavigation }),
      children: { 'session-canvas.node': { kind: 'single', scope: 'root' } },
    }, CanvasPage))
    scope.slots.inject('session-canvas.node', () => scope.slots.register({ name: 'session-canvas.node', locale: NS,
      inject: () => face,
      children: { 'session-canvas.content': { kind: 'single', scope: 'session' } },
    }, CanvasCard))
    scope.slots.inject('session-canvas.content', () => scope.slots.register({ name: 'session-canvas.content', locale: NS,
      inject: () => ({ ...face, mountSummaryEditor }),
    }, CanvasContent))
    scope.slots.inject('sidebar.panellist', () => scope.slots.register({ name: 'sidebar.panellist', id: PANEL, label: () => scope.locale.bind(NS)('panel'), locale: NS }, CanvasIcon))
    scope.slots.inject('shell.overlay', () => scope.slots.register({ name: 'shell.overlay', id: 'session-canvas-toast', locale: NS, inject: () => face }, CanvasToast))
    scope.effect(() => scope.uiConversation.interactions.register({
      id: INTERACTION,
      onInteraction(request) {
        if (!request.hasSelection || request.readText() === null) return
        const node = controller.source.getSnapshot().canvases.some(canvas =>
          canvas.nodes.some(node => node.sessionId === request.sessionId))
        if (!node) return
        request.open()
      },
    }))
    scope.slots.inject('conversation.chat.text-interaction', () => {
      const entries = ['quote', INTERACTION].map(key => scope.slots.register({
        name: 'conversation.chat.text-interaction', key, priority: -200, locale: NS,
        inject: (sessionId: SessionId) => ({ ...face, selection: face.selectedSource(sessionId) }),
      }, SelectionActions))
      return () => { for (const dispose of entries) dispose() }
    })
    scope.slots.registerFactory({ name: 'session-canvas.turns', scope: 'session', locale: NS,
      inject: () => face,
    }, CanvasTurns)
    controller.reload()
  })
  try { await ui } catch (error) { await ui.dispose(); await unmount(); throw error }
  return async () => { await ui.dispose(); await unmount() }
}
