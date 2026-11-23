/** Canvas, embedded conversations, and human-editable summary presentation. */
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent } from 'react'
import { Button, Input, MarkdownText, Toast, Tooltip, Menu, Modal, IconTrashOutlineRegular, IconBranchOutlineRegular, IconSearchOutlineRegular, IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRenderFactories, PropsRenderSlots, PropsRuntime, FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { CanvasId, CanvasNode } from '../types.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DraftQuoteSource } from './quote-reference.ts'
import type { CanvasFace, CanvasState } from './controller.ts'
import { NodeName } from './node-name.tsx'
import { useSummarySelection } from './summary-selection.ts'
import { subtreeIds } from '../subtree.ts'
import { treeLayout } from './layout.ts'
import type { NodeSize } from './layout.ts'
import { branchAppearance } from './appearance.ts'
import type { NodeAppearance } from './appearance.ts'
import { zoomAt, stepZoom, fitCanvas, ZOOM_LEVELS } from './zoom.ts'
import type { CanvasViewport } from './zoom.ts'
import type { CanvasNavigation } from './navigation.ts'
import css from './view.module.css'

type Face = InjectFace<CanvasFace> & PropsLocale<'sessionCanvas'>
type PageProps = PropsRuntime<'main'> & Face & PropsRenderSlots<'session-canvas.node'> & {
  readonly bindNavigation: (element: HTMLElement, actions: CanvasNavigation) => () => void
}
type CardProps = PropsRuntime<'session-canvas.node'> & Face & PropsRenderSlots<'session-canvas.content'>
type ContentProps = PropsRuntime<'session-canvas.content'> & Face & PropsRenderFactories & {
  readonly mountSummaryEditor: (id: SessionId, element: HTMLElement) => () => void
}

function SummaryEditor({ sessionId, label, mount }: {
  readonly sessionId: SessionId
  readonly label: string
  readonly mount: ContentProps['mountSummaryEditor']
}) {
  const unmount = useRef<(() => void) | null>(null)
  const attach = useCallback((element: HTMLDivElement | null) => {
    unmount.current?.()
    unmount.current = element === null ? null : mount(sessionId, element)
  }, [mount, sessionId])
  return <div ref={attach} className={css.editor} aria-label={label} data-summary-editor="" />
}

/** Sidebar glyph reuses the shared branching icon. */
export function CanvasIcon({ size }: PropsRuntime<'sidebar.panellist'>) { return <IconBranchOutlineRegular size={size} /> }

/** Global feedback remains mounted when a canvas or node is hidden. */
export function CanvasToast({ useCanvas, dismissNotice, showSummary, openChild, t }: Face) {
  const notice = useCanvas(state => state.notice)
  if (notice === null) return null
  const sourceId = notice.sessionId
  return <Toast key={notice.id} text={t(notice.kind)} onDone={dismissNotice}
    {...notice.kind === 'saved' || notice.kind === 'added' || notice.kind === 'removed' || notice.kind === 'mapped' ? { tone: 'success' as const } : { holdMs: 7000 }}
    {...sourceId === undefined ? {} : { actions: [{ label: t(notice.kind === 'explainFailed' ? 'chat' : 'viewSummary'), onClick: () => {
      if (notice.kind === 'explainFailed') openChild(sourceId)
      else showSummary(sourceId)
      dismissNotice()
    } }] }} />
}

function QuoteChoices({ choice, ...props }: Pick<PageProps, 'useSessions' | 'useCanvas' | 'openChild' | 'dismissQuoteChoices'> & {
  readonly choice: NonNullable<CanvasState['quoteChoices']>
}) {
  const names = props.useSessions(state => state.projectionsBySession)
  const canvas = props.useCanvas(state => state.canvases.find(value => value.id === choice.canvasId))
  return <Menu open anchor={null} portal compact side="top" className={css.selectionAnchor}
    getAnchorRect={() => new DOMRect(choice.point.x, choice.point.y, 0, 0)} onClose={props.dismissQuoteChoices}
    items={choice.ids.flatMap(id => {
      const node = canvas?.nodes.find(node => node.sessionId === id)
      return node === undefined ? [] : [{ id, label: names[id]?.values.sessionCanvas?.title ?? node.title }]
    })} onSelect={id => { props.openChild(id as SessionId) }} />
}

type SceneProps = Pick<CardProps, 'scale' | 'onMove'> & {
  readonly canvasId: CanvasId | undefined
  readonly nodes: readonly CanvasNode[]
  readonly sizes: ReadonlyMap<SessionId, NodeSize>
  readonly appearance: ReadonlyMap<SessionId, NodeAppearance>
  readonly focused: SessionId | undefined
  readonly onFocus: (id: SessionId) => void
  readonly onMeasure: NonNullable<CardProps['onMeasure']>
  readonly renderSlot: PageProps['renderSlot']
}

/** A neighboring node move must not invalidate an unchanged retained conversation. */
const CanvasNodeSlot = memo(function CanvasNodeSlot(props: Pick<SceneProps, 'scale' | 'onMove' | 'onFocus' | 'onMeasure' | 'renderSlot'> & {
  readonly canvasId: CanvasId
  readonly node: CanvasNode
  readonly appearance: NodeAppearance | undefined
  readonly focused: boolean
}) {
  const { canvasId, node, scale, focused, onMeasure, onMove, onFocus, renderSlot, appearance } = props
  return <div className={css.tone} data-tone={appearance?.tone} data-node-level={appearance?.level}>
    {renderSlot('session-canvas.node', { canvasId, node, scale, focused, onMeasure, onMove,
      onFocus: () => { onFocus(node.sessionId) } })}
  </div>
})

/** Viewport translation belongs to the outer transform, not the conversation render tree. */
const CanvasScene = memo(function CanvasScene({ canvasId, nodes, sizes, appearance, focused, ...props }: SceneProps) {
  const byId = useMemo(() => new Map(nodes.map(node => [node.sessionId, node])), [nodes])
  const width = Math.max(2000, ...nodes.map(node => node.x + 600))
  const height = Math.max(2000, ...nodes.map(node => node.y + 660))
  return <>
    <svg className={css.edges} width={width} height={height} aria-hidden="true">
      {nodes.map((node) => {
        const parent = node.parentId === null ? undefined : byId.get(node.parentId)
        if (parent === undefined) return null
        const right = node.x >= parent.x
        const parentSize = sizes.get(parent.sessionId), size = sizes.get(node.sessionId)
        const x = parent.x + (right ? parentSize?.width ?? 560 : 0), y = parent.y + (parentSize?.height ?? 56) / 2
        const dx = node.x + (right ? 0 : size?.width ?? 560), dy = node.y + (size?.height ?? 56) / 2
        return <path key={node.sessionId} data-canvas-edge={node.sessionId} className={css.tone}
          data-tone={appearance.get(node.sessionId)?.tone} data-node-level={appearance.get(node.sessionId)?.level}
          d={`M ${x} ${y} C ${(x + dx) / 2} ${y}, ${(x + dx) / 2} ${dy}, ${dx} ${dy}`} />
      })}
    </svg>
    {canvasId !== undefined && nodes.map(node => <CanvasNodeSlot key={node.sessionId} {...props}
      canvasId={canvasId} node={node} appearance={appearance.get(node.sessionId)} focused={focused === node.sessionId} />)}
  </>
})

/** Pan and zoom a canvas; conversation scrolling and text selection remain local to cards. */
export function CanvasPage(props: PageProps) {
  const { useCanvas, t, renderSlot, bindNavigation } = props
  const { canvases, activeId, loading, failed, busy, viewportTarget, quoteChoices, fitRequest, mapping, summaryOnly: summaryCanvases, summaries } = useCanvas(state => state)
  const canvas = canvases.find(value => value.id === activeId)
  const summaryOnly = activeId !== null && summaryCanvases.includes(activeId)
  const appearance = useMemo(() => branchAppearance(canvas?.nodes ?? []), [canvas?.nodes])
  const [movement, setMovement] = useState<{ canvasId: CanvasId; sessionId: SessionId; x: number; y: number } | null>(null)
  const onMove = useCallback<CardProps['onMove']>((sessionId, position) => {
    if (activeId === null) return
    setMovement(current => position === null
      ? current?.canvasId === activeId && current.sessionId === sessionId ? null : current
      : { canvasId: activeId, sessionId, ...position })
  }, [activeId])
  const [measurements, setMeasurements] = useState<{
    canvasId: CanvasId | null
    sizes: ReadonlyMap<SessionId, NodeSize & { readonly summaryOnly: boolean }>
  }>({ canvasId: null, sizes: new Map() })
  const onMeasure = useCallback<NonNullable<CardProps['onMeasure']>>((id, size) => {
    setMeasurements((value) => {
      const previous = value.canvasId === activeId ? value.sizes.get(id) : undefined
      if (previous?.width === size.width && previous.height === size.height && previous.summaryOnly === size.summaryOnly) return value
      return { canvasId: activeId, sizes: new Map(value.canvasId === activeId ? value.sizes : []).set(id, size) }
    })
  }, [activeId])
  const measuredNodes = useMemo(() => canvas?.nodes.flatMap((node) => {
    const size = measurements.canvasId === activeId ? measurements.sizes.get(node.sessionId) : undefined
    return size === undefined || size.summaryOnly !== summaryOnly ? [] : [{ ...node, ...size }]
  }) ?? [], [canvas?.nodes, measurements, activeId, summaryOnly])
  const layoutReady = canvas !== undefined && measuredNodes.length === canvas.nodes.length
  const compactNodes = useMemo(() => {
    if (!summaryOnly || !layoutReady) return canvas?.nodes ?? []
    const positions = new Map(treeLayout(measuredNodes).map(point => [point.sessionId, point]))
    return canvas.nodes.map(node => ({ ...node, ...positions.get(node.sessionId) }))
  }, [canvas?.nodes, summaryOnly, layoutReady, measuredNodes])
  // One position feeds both the card and its connectors throughout the gesture and save.
  const displayedNodes = useMemo(() => compactNodes.map(node =>
    !summaryOnly && movement?.canvasId === activeId && movement.sessionId === node.sessionId
      ? { ...node, x: movement.x, y: movement.y } : node), [compactNodes, movement, activeId, summaryOnly])
  const [viewport, setViewport] = useState({ x: 0, y: 0, scale: 1 })
  const [focus, setFocus] = useState<{ sessionId: SessionId; previous: CanvasViewport } | null>(null)
  const [editingName, setEditingName] = useState(false)
  const [zoomMenu, setZoomMenu] = useState(false)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const currentView = useRef({ viewport, focus })
  useLayoutEffect(() => { currentView.current = { viewport, focus } }, [viewport, focus])
  const fittedRequest = useRef(0)
  const summaryView = useRef<{ canvasId: CanvasId | null; previous: CanvasViewport; fitted: boolean } | null>(null)
  const unbindNavigation = useRef<(() => void) | null>(null)
  const attachViewport = useCallback((element: HTMLDivElement | null) => {
    unbindNavigation.current?.()
    viewportRef.current = element
    unbindNavigation.current = element === null ? null : bindNavigation(element, {
      zoom: (factor, anchor) => { setViewport(value => zoomAt(value, value.scale * factor, anchor)) },
      pan: (x, y) => { setViewport(value => ({ ...value, x: value.x + x, y: value.y + y })) },
      step: (direction) => { setViewport(value => zoomAt(value, stepZoom(value.scale, direction),
        { x: element.clientWidth / 2, y: element.clientHeight / 2 })) },
      actualSize: () => { setViewport(value => zoomAt(value, 1, { x: element.clientWidth / 2, y: element.clientHeight / 2 })) },
    })
  }, [bindNavigation])
  useLayoutEffect(() => {
    if (summaryView.current !== null && summaryView.current.canvasId !== activeId) summaryView.current = null
    if (!summaryOnly) {
      if (summaryView.current !== null) { setViewport(summaryView.current.previous); summaryView.current = null; setFocus(null) }
      return
    }
    summaryView.current ??= { canvasId: activeId, previous: viewport, fitted: false }
    const requested = fitRequest?.canvasId === activeId && fittedRequest.current !== fitRequest.request
    if (summaryView.current.fitted && !requested) return
    const element = viewportRef.current
    const measured = element !== null && [...element.querySelectorAll<HTMLElement>('[data-canvas-session]')].every((card) => {
      const size = measurements.sizes.get(card.dataset.canvasSession as SessionId)
      return size?.width === card.offsetWidth && size.height === card.offsetHeight
    })
    if (layoutReady && measured && canvas.nodes.every(node => summaries[node.sessionId] !== undefined)) {
      if (requested && fitRequest !== null) fittedRequest.current = fitRequest.request
      summaryView.current.fitted = true
      setViewport(fitCanvas(element)); setFocus(null)
    }
  }, [activeId, summaryOnly, layoutReady, compactNodes, canvas?.nodes, summaries, viewport, measurements, fitRequest])
  const select = (id: CanvasId): void => {
    props.selectCanvas(id); setMovement(null); setViewport({ x: 0, y: 0, scale: 1 }); setFocus(null); setEditingName(false)
  }
  const focusNode = useCallback((sessionId: SessionId, toggle = true): void => {
    const { viewport, focus } = currentView.current
    if (toggle && focus?.sessionId === sessionId) { setViewport(focus.previous); setFocus(null); return }
    const element = viewportRef.current
    const card = element?.querySelector<HTMLElement>(`[data-canvas-session="${CSS.escape(sessionId)}"]`)
    if (element == null || card == null) return
    const scale = Math.max(0.2, Math.min(1.5,
      (element.clientWidth - 48) / card.offsetWidth, (element.clientHeight - 80) / card.offsetHeight))
    setFocus({ sessionId, previous: focus?.previous ?? viewport })
    setViewport({ scale, x: (element.clientWidth - card.offsetWidth * scale) / 2 - card.offsetLeft * scale,
      y: (element.clientHeight - card.offsetHeight * scale) / 2 - card.offsetTop * scale })
  }, [])
  useLayoutEffect(() => {
    const element = viewportRef.current
    if (viewportTarget === null || element === null) return
    if (viewportTarget.focus) { focusNode(viewportTarget.sessionId, false); return }
    const card = element.querySelector<HTMLElement>(`[data-canvas-session="${CSS.escape(viewportTarget.sessionId)}"]`)
    if (card === null) return
    setFocus(null)
    setViewport(value => ({ ...value,
      x: (element.clientWidth - card.offsetWidth * value.scale) / 2 - card.offsetLeft * value.scale,
      y: Math.max(0, (element.clientHeight - card.offsetHeight * value.scale) / 2) - card.offsetTop * value.scale,
    }))
  }, [activeId, viewportTarget, focusNode])
  const zoom = (scale: number): void => {
    const element = viewportRef.current
    if (element === null) return
    const center = { x: element.clientWidth / 2, y: element.clientHeight / 2 }
    setViewport(value => zoomAt(value, scale, center))
  }
  return <section className={css.page} data-session-canvas="">
    <header className={css.toolbar}>
      <div className={css.title}><IconBranchOutlineRegular size={20} /><span>{t('panel')}</span></div>
      <select aria-label={t('selectCanvas')} value={activeId ?? ''} onChange={(event) => { select(event.target.value as CanvasId) }}>
        {canvases.length === 0 && <option value="">{t('selectCanvas')}</option>}
        {canvases.map(value => <option key={value.id} value={value.id}>{value.title}</option>)}
      </select>
      <Button size="sm" disabled={busy} onClick={() => { props.createCanvas(t('newCanvas')) }}>{t('newCanvas')}</Button>
      {canvas !== undefined && <>
        {editingName ? <Input aria-label={t('canvasName')} autoFocus defaultValue={canvas.title}
          onBlur={(event) => { if (event.target.value.trim()) props.renameCanvas(canvas.id, event.target.value); setEditingName(false) }}
          onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') setEditingName(false) }} />
          : <Button size="sm" onClick={() => { setEditingName(true) }}>{t('rename')}</Button>}
        <span className={css.divider} />
        <Button size="sm" disabled={busy} onClick={() => { props.addRoot(canvas.id, t('newNode')) }}>{t('newNode')}</Button>
        <Button size="sm" disabled={busy} onClick={() => { props.setMode(canvas.id, 'chat') }}>{t('allChat')}</Button>
        <Button size="sm" disabled={busy} onClick={() => { props.setMode(canvas.id, 'summary') }}>{t('allSummary')}</Button>
        <Button size="sm" disabled={busy || !layoutReady} onClick={() => {
          if (summaryOnly) { if (viewportRef.current !== null) setViewport(fitCanvas(viewportRef.current)) }
          else { props.arrange(canvas.id, treeLayout(measuredNodes)); setViewport({ x: 0, y: 0, scale: 1 }) }
          setFocus(null)
        }}>{t('arrange')}</Button>
      </>}
      {mapping !== null && <span role="status">{t('mapping')} <Button size="sm" onClick={props.cancelMindmap}>{t('cancel')}</Button></span>}
      <Button size="sm" disabled={loading} onClick={props.reload}>{t('refresh')}</Button>
    </header>
    {quoteChoices !== null && quoteChoices.canvasId === activeId && <QuoteChoices {...props} choice={quoteChoices} />}
    <div ref={attachViewport} className={css.viewport} aria-label={t('canvas')} tabIndex={0}>
      {(canvas === undefined || canvas.nodes.length === 0) && <div className={css.empty}>
        <IconBranchOutlineRegular size={36} />
        <p>{loading ? t('loading') : failed ? t('failed') : canvas === undefined ? t('empty') : t('emptyCanvas')}</p>
        <Button variant="primary" disabled={busy || loading} onClick={() => {
          if (canvas === undefined) props.createCanvas(t('newCanvas'))
          else props.addRoot(canvas.id, t('newNode'))
        }}>
          {canvas === undefined ? t('newCanvas') : t('newNode')}
        </Button>
      </div>}
      <div className={css.world} data-canvas-world="" style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})` }}>
        <CanvasScene canvasId={canvas?.id} nodes={displayedNodes} sizes={measurements.sizes} appearance={appearance}
          scale={viewport.scale} focused={focus?.sessionId} onMeasure={onMeasure} onMove={onMove}
          onFocus={focusNode} renderSlot={renderSlot} />
      </div>
      <nav className={css.zoom} data-canvas-navigation="" aria-label={t('navigation')}>
        <Button size="sm" aria-label={t('zoomOut')} disabled={viewport.scale <= 0.1} onClick={() => { zoom(stepZoom(viewport.scale, -1)) }}>−</Button>
        <Menu open={zoomMenu} onClose={() => { setZoomMenu(false) }} side="top" align="end" portal compact
          anchor={<Button size="sm" aria-label={t('zoomLevel')} aria-haspopup="menu" aria-expanded={zoomMenu}
            onClick={() => { setZoomMenu(value => !value) }}>{Math.round(viewport.scale * 100)}%
            <IconChevronDownOutlineRegular size={14} /></Button>}
          items={[...ZOOM_LEVELS.toReversed().map(scale => ({ id: String(scale), label: `${scale * 100}%` })),
            { type: 'separator', id: 'fit-separator' }, { id: 'fit', label: t('fitMap') }]}
          selectedId={String(viewport.scale)} onSelect={(id) => {
            if (id === 'fit') { if (viewportRef.current !== null) setViewport(fitCanvas(viewportRef.current)); setFocus(null) }
            else zoom(Number(id))
            setZoomMenu(false)
          }} />
        <Button size="sm" aria-label={t('zoomIn')} disabled={viewport.scale >= 5} onClick={() => { zoom(stepZoom(viewport.scale, 1)) }}>+</Button>
        <Button size="sm" onClick={() => { zoom(1) }}>{t('actualSize')}</Button>
        <Button size="sm" onClick={() => { if (viewportRef.current !== null) setViewport(fitCanvas(viewportRef.current)); setFocus(null) }}>{t('fitMap')}</Button>
      </nav>
    </div>
  </section>
}

/** A draggable Session occurrence retains its conversation independently of main-chat selection. */
export function CanvasCard(props: CardProps) {
  const { canvasId, node, scale, focused, onFocus, onMeasure, onMove, useResource, useCanvas,
    SessionProvider, renderSlot, updateNode, arrange, t } = props
  const resource = useResource<'canvaschat'>(`dsh-resource://canvaschat/${encodeURIComponent(node.sessionId)}`)
  const title = props.useSessions(state => state.projectionsBySession[node.sessionId]?.values.sessionCanvas?.title) ?? node.title
  const summaryOnly = useCanvas(state => state.summaryOnly.includes(canvasId))
  const [deleting, setDeleting] = useState(false)
  const removal = useCanvas(state => ({ busy: state.busy,
    count: subtreeIds(state.canvases.find(value => value.id === canvasId)?.nodes ?? [], node.sessionId).size }))
  const cardRef = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const element = cardRef.current
    if (element === null || onMeasure === undefined) return
    const measure = (): void => { onMeasure(node.sessionId, { width: element.offsetWidth, height: element.offsetHeight, summaryOnly }) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [node.sessionId, onMeasure, summaryOnly])
  const dragged = useRef(false)
  const committing = useRef(false)
  const gesture = useRef<{ x: number; y: number; px: number; py: number; pointerId: number; scale: number } | null>(null)
  const cancelDrag = (event: PointerEvent<HTMLElement>): void => {
    if (gesture.current?.pointerId !== event.pointerId) return
    gesture.current = null
    onMove(node.sessionId, null)
  }
  const stopDrag = async (event: PointerEvent<HTMLElement>): Promise<void> => {
    if (gesture.current?.pointerId !== event.pointerId) return
    const start = gesture.current
    gesture.current = null
    const x = Math.max(0, start.x + (event.clientX - start.px) / start.scale)
    const y = Math.max(0, start.y + (event.clientY - start.py) / start.scale)
    if (x === start.x && y === start.y) { onMove(node.sessionId, null); return }
    onMove(node.sessionId, { x, y }); committing.current = true
    try { await arrange(canvasId, [{ sessionId: node.sessionId, x, y }]) }
    finally { committing.current = false; onMove(node.sessionId, null) }
  }
  return <article ref={cardRef} className={css.card} aria-label={title} data-canvas-session={node.sessionId}
    data-summary-only={summaryOnly || undefined} data-focused={focused || undefined} style={{ left: node.x, top: node.y }}
    onPointerDown={() => { dragged.current = false }}
    onClick={(event) => {
      if (dragged.current || !window.getSelection()?.isCollapsed) return
      if (event.target instanceof Element && event.target.closest('button, a, select, [role="button"], [role="menuitem"]')) return
      props.followParent(node.sessionId)
    }}>
    <header className={css.cardHeader} hidden={summaryOnly}
      onPointerDown={(event) => {
        if (event.button !== 0 || gesture.current !== null || committing.current || removal.busy
          || (event.target instanceof Element && event.target.closest('button,input'))) return
        event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
        gesture.current = { x: node.x, y: node.y, px: event.clientX, py: event.clientY, pointerId: event.pointerId, scale }
      }}
      onPointerMove={(event) => {
        const start = gesture.current
        if (start?.pointerId !== event.pointerId) return
        if (Math.hypot(event.clientX - start.px, event.clientY - start.py) > 3) dragged.current = true
        onMove(node.sessionId, {
          x: Math.max(0, start.x + (event.clientX - start.px) / start.scale),
          y: Math.max(0, start.y + (event.clientY - start.py) / start.scale),
        })
      }}
      onPointerUp={event => { void stopDrag(event) }} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}>
      <NodeName title={title} label={t('renameNode')} disabled={resource.value === undefined || removal.busy}
        rename={value => props.renameNode(node.sessionId, value)} />
      <Button size="sm" aria-pressed={node.mode === 'chat'} onClick={() => { updateNode({ canvasId, sessionId: node.sessionId, mode: 'chat' }) }}>{t('chat')}</Button>
      <Button size="sm" aria-pressed={node.mode === 'summary'} onClick={() => { updateNode({ canvasId, sessionId: node.sessionId, mode: 'summary' }) }}>{t('summary')}</Button>
      <Button size="sm" aria-label={t(node.collapsed ? 'expand' : 'collapse')} onClick={() => { updateNode({ canvasId, sessionId: node.sessionId, collapsed: !node.collapsed }) }}>{node.collapsed ? '+' : '−'}</Button>
      {onFocus !== undefined && <Tooltip label={t(focused ? 'unfocusNode' : 'focusNode')} side="top" portal>
        <Button size="sm" aria-label={t(focused ? 'unfocusNode' : 'focusNode')} onClick={onFocus}>
          <span className={css.focusIcon}><IconSearchOutlineRegular size={20} /><span>{focused ? '−' : '+'}</span></span>
        </Button>
      </Tooltip>}
    </header>
    <div className={css.deleteNode}>
      <Tooltip label={t('deleteNode')} side="top" portal>
        <Button size="sm" aria-label={t('deleteNode')} disabled={removal.busy} onClick={() => { setDeleting(true) }}>
          <IconTrashOutlineRegular size={16} />
        </Button>
      </Tooltip>
    </div>
    <Modal open={deleting} onClose={() => { if (!removal.busy) setDeleting(false) }}
      title={t('deleteTitle', { count: removal.count })} closeLabel={t('close')} description={t('deleteDescription')}
      footer={<>
        <Button disabled={removal.busy} onClick={() => { setDeleting(false) }}>{t('cancel')}</Button>
        <Button variant="primary" disabled={removal.busy} onClick={() => { props.removeNode(canvasId, node.sessionId) }}>{t('confirmDelete')}</Button>
      </>} />
    <div className={css.cardBody} hidden={node.collapsed && !summaryOnly}>
      {resource.value === undefined ? <div className={css.empty}>{t(resource.status === 'failed' ? 'failed' : 'loading')}</div> :
        <SessionProvider session={resource.value.reference}>{renderSlot('session-canvas.content', { canvasId, node: { ...node, title } })}</SessionProvider>}
    </div>
  </article>
}

/** Restrict this canvas occurrence while leaving the Session and ordinary Chat unchanged. */
function FixedChat(props: ConversationViewsProps) {
  const transcript = props.useProjection('sessionCanvas')
  const chat = props.useChat(value => value)
  const conversation = props.useConversation(value => value)
  if (transcript === undefined) return null
  const prefix = `[data-canvas-transcript="${CSS.escape(props.sessionId)}"]`
  const selectors = chat.order.flatMap(key => {
    const node = chat.nodes.get(key)
    return node !== undefined && node.anchorSeq < transcript.inheritedEventCount
      ? [`${prefix} [data-chat-node-key="${CSS.escape(key)}"]`] : []
  })
  const grouped = conversation.views.grouped('chat')
  for (const entry of grouped?.entries ?? []) {
    if (entry.kind !== 'group') continue
    const members = grouped?.groupSource(entry.key).getSnapshot()?.members ?? []
    if (members.length > 0 && members.every(member => (chat.nodes.get(member.key)?.anchorSeq ?? -1) < transcript.inheritedEventCount)) {
      selectors.push(`${prefix} [data-chat-group-key="${CSS.escape(entry.key)}"]`)
    }
  }
  return <div className={css.transcript} data-canvas-transcript={props.sessionId}>
    {selectors.length > 0 && <style>{`${selectors.join(',')} { display: none !important; }`}</style>}
    {props.renderSlot('conversation.session', { view: 'chat' })}
    {props.renderFactorySlot('session-canvas.turns', {})}
  </div>
}

/** Canvas-local turn navigation excludes the inherited snapshot. */
export function CanvasTurns({ useProjection, revealSource, sessionId, t }: FactoryComponentPropsOf<'session-canvas.turns'>) {
  const transcript = useProjection('sessionCanvas')
  const turns = transcript?.turns.filter(turn => turn.seq >= transcript.inheritedEventCount) ?? []
  if (turns.length < 2) return null
  return <nav className={css.turns} aria-label={t('turnNavigation')}>
    {turns.map((turn, index) => {
      const prior = transcript?.turns.findLast(value => value.turn < turn.turn)
      const first = transcript?.messages.find(message => message.seq > (prior?.seq ?? -1) && message.seq < turn.seq)
      return <Tooltip key={turn.turn} label={first?.text || t('turn', { turn: turn.turn })} side="left" portal>
        <button type="button" aria-label={t('jumpTurn', { turn: turn.turn })}
          onClick={() => { revealSource(sessionId, turn.turn, (prior?.seq ?? -1) + 1) }}>{index + 1}</button>
      </Tooltip>
    })}
  </nav>
}

/** Embedded Chat and Summary remain separate views of one durable Session. */
export function CanvasContent(props: ContentProps) {
  const { node, canvasId, sessionId, useProjection, useSession, useConversation, useCanvas, renderFactorySlot, t } = props
  const attachSource = useCallback((element: HTMLDivElement | null) => { props.registerSourceRoot(sessionId, element) },
    [props.registerSourceRoot, sessionId])
  const session = useSession(value => value)
  const conversation = useConversation(value => value)
  const transcript = useProjection('sessionCanvas')
  const state = useCanvas(value => value)
  const summaryOnly = state.summaryOnly.includes(canvasId)
  const document = state.summaries[sessionId], draft = state.drafts[sessionId]
  const saveStatus = state.saveStates[sessionId]
  const generating = state.generating.includes(sessionId)
  const [editing, setEditing] = useState(false), [history, setHistory] = useState(false)
  const summarySelection = useSummarySelection(node.mode === 'summary' || summaryOnly)
  const active = conversation.activeTargets.size > 0 || !session.blank || session.running
  const phase = active ? 'active' : session.openState === 'loading' ? 'settling' : 'hero'
  const labels = { code: { copyLabel: t('copy'), copiedLabel: t('copied') }, footnotes: t('footnotes') }
  const markdown = draft?.markdown ?? document?.markdown ?? ''
  const showSource = (turn: number | null): void => {
    const previous = transcript?.turns.findLast(value => turn !== null && value.turn < turn)
    props.revealSource(sessionId, turn, previous === undefined ? 0 : previous.seq + 1)
  }
  return <div ref={attachSource} className={css.content}>
    <div className={css.chat} hidden={node.mode !== 'chat' || summaryOnly}>
      {renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero: false }, { slots: { views: FixedChat } })}
    </div>
    <div className={css.summary} data-canvas-summary="" hidden={node.mode !== 'summary' && !summaryOnly}>
      {document === undefined ? <div className={css.empty}><p>{t('loading')}</p><Button onClick={() => { props.loadSummary(sessionId) }}>{t('retry')}</Button></div> : <>
        <div className={css.summaryToolbar} hidden={summaryOnly}>
          <Button size="sm" disabled={generating} onClick={() => { props.generate(sessionId) }}>{t(generating ? 'generating' : document.markdown ? 'regenerate' : 'generate')}</Button>
          {generating && <Button size="sm" onClick={() => { props.cancelGeneration(sessionId) }}>{t('cancel')}</Button>}
          <Button size="sm" onClick={() => { setEditing(value => !value) }}>{t(editing ? 'preview' : 'edit')}</Button>
          <Button size="sm" onClick={() => {
            const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' }), url = URL.createObjectURL(blob)
            const link = window.document.createElement('a'); link.href = url; link.download = `${node.title.replace(/[/\\:]/gu, '-') || 'summary'}.md`; link.click()
            setTimeout(() => { URL.revokeObjectURL(url) }, 1000)
          }}>{t('export')}</Button>
          <Button size="sm" onClick={() => { setHistory(value => !value) }}>{t('history')}</Button>
        </div>
        {saveStatus !== undefined && <div className={css.saveStatus} role="status"
          data-save-error={saveStatus === 'failed' || saveStatus === 'conflict' || undefined}>
          {t(saveStatus === 'pending' ? 'saving' : saveStatus)}
          {(saveStatus === 'failed' || saveStatus === 'conflict') && <>
            <Button size="sm" onClick={() => { props.saveSummary(sessionId) }}>{t('retry')}</Button>
            <Button size="sm" onClick={() => { props.discardEdits(sessionId) }}>{t('discardEdits')}</Button>
          </>}
        </div>}
        {history && !summaryOnly && <div className={css.versions}>{[...document.versions].reverse().map(version =>
          <details key={version.revision}>
            <summary>{t('version', { revision: version.revision })}</summary>
            <MarkdownText text={version.markdown} labels={labels} />
            <Button size="sm" disabled={draft !== undefined || state.busy}
              onClick={() => { props.restore(sessionId, version.revision) }}>{t('restore')}</Button>
          </details>)}</div>}
        <div ref={summarySelection.root} className={css.summaryDocument} data-summary-document=""
          onPointerUp={summarySelection.capture} onKeyUp={(event) => { if (event.key !== 'Escape') summarySelection.capture() }} tabIndex={editing ? -1 : 0}
          aria-label={t('edit')} onDoubleClick={() => { summarySelection.dismiss(); setEditing(true) }}
          onKeyDownCapture={(event) => {
            // The menu handles Escape on document capture, before the rich editor.
            if (event.key === 'Escape' && event.defaultPrevented) event.stopPropagation()
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && summarySelection.selection !== null) { event.preventDefault(); summarySelection.dismiss(); return }
            if (!editing && event.key === 'Enter') { event.preventDefault(); setEditing(true) }
            if (editing && event.key === 'Escape') { event.preventDefault(); props.saveSummary(sessionId); setEditing(false) }
          }} onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) props.saveSummary(sessionId)
          }}>
          {editing && (node.mode === 'summary' || summaryOnly) ? <SummaryEditor sessionId={sessionId} label={t('edit')} mount={props.mountSummaryEditor} />
            : markdown ? <MarkdownText text={markdown} labels={labels} /> : <div className={css.blankSummary} />}
        </div>
        <Menu open={summarySelection.selection !== null} anchor={null} portal compact side="top" className={css.selectionAnchor}
          listClassName={css.summarySelection} onClose={summarySelection.dismiss}
          getAnchorRect={() => summarySelection.selection?.range.getBoundingClientRect() ?? null}
          items={[{ id: 'quote', label: t('quoteText'), disabled: state.busy },
            { id: 'child', label: t('quoteChild'), disabled: state.busy },
            { id: 'explain', label: t('explainChild'), disabled: state.busy },
            { id: 'mindmap', label: t('mindmap'), disabled: state.busy }]}
          onSelect={(action) => {
            const selected = summarySelection.selection
            if (selected === null) return
            if (action === 'quote') props.quoteSummary(canvasId, sessionId, selected.text, selected.offset)
            else if (action === 'mindmap') props.mindmap(canvasId, sessionId, null, selected.text)
            else (action === 'explain' ? props.explainChild : props.quoteChild)(canvasId, sessionId, null, `${node.title} · ${t('fork')}`, selected.text,
              { kind: 'summary', sessionId, offset: selected.offset })
            summarySelection.clear()
          }} />
        {document.draft !== null && !summaryOnly && <section className={css.candidate}>
          <h3>{t('candidate')}</h3>
          <p className={css.hint}>{t(document.draft.baseRevision === document.revision ? 'candidateHint' : 'changed')}</p>
          <MarkdownText text={document.draft.markdown} labels={labels} />
          <div className={css.summaryToolbar}>
            <Button size="sm" variant="primary" disabled={draft !== undefined || state.busy} onClick={() => { props.resolveDraft(sessionId, true) }}>{t('adopt')}</Button>
            <Button size="sm" disabled={state.busy} onClick={() => { props.resolveDraft(sessionId, false) }}>{t('discard')}</Button>
          </div>
        </section>}
        {document.excerpts.length > 0 && !summaryOnly && <details className={css.sources}><summary>{t('sources')}</summary>
          {document.excerpts.map(excerpt => <div key={excerpt.revision}><blockquote>{excerpt.text}</blockquote>
            <Button size="sm" onClick={() => { showSource(excerpt.turn) }}>{excerpt.turn === null ? t('sourceSession') : t('source', { turn: excerpt.turn })}</Button>
          </div>)}
        </details>}
      </>}
    </div>
  </div>
}

/** Stock selection slot, with canvas actions and exact source captured before dismissal. */
export function SelectionActions({ sessionId, readText, dismiss, clearSelection, excerpt, quoteChild, explainChild, insertQuote, mindmap,
  inputActions, selection, useCanvas, useProjection, t }: PropsRuntime<'conversation.chat.text-interaction'> & Face & {
    readonly selection: DraftQuoteSource | undefined
  }) {
  const state = useCanvas(value => value)
  const canvas = state.canvases.find(canvas => canvas.nodes.some(node => node.sessionId === sessionId))
  const transcript = useProjection('sessionCanvas')
  const turn = transcript?.turns.find(value => value.turn === selection?.turn)
  return <div className={css.selection} onPointerDown={(event) => { event.preventDefault() }}>
    <Button size="sm" onClick={() => {
      const text = readText()
      if (text === null) { dismiss(); return }
      const inserted = canvas === undefined ? inputActions.insertQuote(text) : insertQuote(sessionId, text, selection)
      if (!inserted) return
      clearSelection(); dismiss()
    }}>{t('quoteText')}</Button>
    {canvas !== undefined && <>
      <Button size="sm" onClick={() => { const text = readText(); if (text !== null) excerpt(sessionId, text, selection?.turn ?? null); dismiss() }}>{t('addSummary')}</Button>
      <Button size="sm" disabled={state.busy || turn === undefined} onClick={() => {
        const text = readText(), node = canvas.nodes.find(node => node.sessionId === sessionId)
        if (text === null || node === undefined || turn === undefined) { dismiss(); return }
        quoteChild(canvas.id, sessionId, turn.seq, `${node.title} · ${t('fork')}`, text, selection)
        clearSelection(); dismiss()
      }}>{t('quoteChild')}</Button>
      <Button size="sm" disabled={state.busy || turn === undefined} onClick={() => {
        const text = readText(), node = canvas.nodes.find(node => node.sessionId === sessionId)
        if (text === null || node === undefined || turn === undefined) { dismiss(); return }
        explainChild(canvas.id, sessionId, turn.seq, `${node.title} · ${t('fork')}`, text, selection)
        clearSelection(); dismiss()
      }}>{t('explainChild')}</Button>
      <Button size="sm" disabled={state.busy || turn === undefined} onClick={() => {
        const text = readText()
        if (text !== null && turn !== undefined) mindmap(canvas.id, sessionId, turn.seq, text)
        clearSelection(); dismiss()
      }}>{t('mindmap')}</Button>
    </>}
  </div>
}
