import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type Ref, type RefObject } from 'react'
import { ActionMenu, IconButton, Tabs, cn, type ActionMenuItem, type TabItem } from '@renderer/lib/ui'
import { shortcutLabel } from '@renderer/lib/shortcuts'
import { INSPECTOR_TAB_SHORTCUTS } from '@renderer/lib/shortcuts/bindings'
import type { ChatRightPanelId } from '@renderer/lib/utils/layout'
import { stripEdgeMask, useStripEdges } from '@renderer/lib/hooks/useStripEdges'
import { fitTabs } from './tabOverflow'

/** The strip's order — Alt 1–6 follow it. */
export const INSPECTOR_TABS: readonly ChatRightPanelId[] = ['changes', 'files', 'terminal', 'browser', 'pr', 'plan']

/** Each panel's name on the strip — and wherever else the panel is named. */
export const INSPECTOR_TAB_LABEL: Record<ChatRightPanelId, string> = {
  changes: 'Changes',
  files: 'Files',
  terminal: 'Terminal',
  browser: 'Browser',
  pr: 'PR',
  plan: 'Plan'
}

/** `gap-2` between row tabs, and the xs "More panels" button (size-6). */
const TAB_GAP_PX = 8
const MORE_BUTTON_PX = 24
/** Each tab controls `dock-panel-<id>`; also how a measured tab names itself. */
const PANEL_ID_PREFIX = 'dock-panel-'

/**
 * The tabs that don't fit the strip, measured live: each tab's width is
 * remembered from when it was last shown, so a hidden one comes back as soon
 * as there is room for it.
 */
function useHiddenTabs(
  wrapRef: RefObject<HTMLDivElement | null>,
  ids: readonly ChatRightPanelId[],
  active: ChatRightPanelId,
  /** Changes when a tab's content (a count, a live dot) can change its width. */
  contentKey: string
): ChatRightPanelId[] {
  const [hidden, setHidden] = useState<ChatRightPanelId[]>([])
  const widths = useRef(new Map<ChatRightPanelId, number>())
  useLayoutEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const measure = (): void => {
      for (const tab of wrap.querySelectorAll<HTMLElement>(`[role="tab"][aria-controls^="${PANEL_ID_PREFIX}"]`)) {
        const width = tab.offsetWidth
        const id = tab.getAttribute('aria-controls')!.slice(PANEL_ID_PREFIX.length) as ChatRightPanelId
        if (width > 0) widths.current.set(id, width)
      }
      const available = wrap.clientWidth
      // Nothing measured (jsdom, a collapsed pane): leave every tab out on the strip.
      if (available <= 0 || widths.current.size === 0) {
        setHidden((prev) => (prev.length === 0 ? prev : []))
        return
      }
      const next = fitTabs({
        ids,
        widthOf: (id) => widths.current.get(id) ?? 0,
        available,
        gap: TAB_GAP_PX,
        moreWidth: MORE_BUTTON_PX,
        active
      }).hidden
      setHidden((prev) => (prev.length === next.length && prev.every((id, i) => id === next[i]) ? prev : next))
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(wrap)
    return () => observer?.disconnect()
  }, [wrapRef, ids, active, contentKey, hidden])
  return hidden
}

/** How long a {@link InspectorTabState.detail} may be before the host truncates it. */
export const INSPECTOR_DETAIL_MAX = 48

/** What a tab says about its panel without opening it. */
export type InspectorTabState = {
  /** Something waiting for you there (Changes: files to review). */
  count?: number
  /** The run is working there right now. */
  live?: boolean
  /** Said on hover: "Editing src/x.ts", "Running pnpm test". */
  detail?: string
}

/**
 * The inspector holds the task's artifacts — never the conversation. One tab
 * strip for all six panels, expand to the whole work area, hide. It replaces
 * the side rail, the dock's tab bar and its quick-launch icons, and the
 * immersive mode.
 *
 * Docked, it draws the hairline on its left, which the resize handle over it
 * lights up on hover and drag; expanded, the work area's edge is the only
 * line.
 */
export function Inspector({
  tab,
  onSelect,
  state,
  expanded,
  onToggleExpanded,
  onHide,
  width,
  sectionRef,
  bare = false,
  children
}: {
  tab: ChatRightPanelId
  onSelect: (tab: ChatRightPanelId) => void
  state: Partial<Record<ChatRightPanelId, InspectorTabState>>
  expanded: boolean
  onToggleExpanded: () => void
  onHide: () => void
  width: number
  sectionRef?: Ref<HTMLElement>
  /** The panel draws its own header (the review): no tab strip. */
  bare?: boolean
  children: ReactNode
}) {
  const items: TabItem<ChatRightPanelId>[] = INSPECTOR_TABS.map((id, i) => {
    const s = state[id]
    const chord = shortcutLabel(INSPECTOR_TAB_SHORTCUTS[i] ?? 'inspector')
    return {
      id,
      label: INSPECTOR_TAB_LABEL[id],
      ...(s?.count ? { count: s.count } : {}),
      ...(s?.live ? { live: true } : {}),
      title: s?.detail ? `${s.detail} · ${chord}` : chord
    }
  })
  const style: CSSProperties | undefined = expanded ? undefined : { width }
  const stripRef = useRef<HTMLDivElement>(null)
  const contentKey = INSPECTOR_TABS.map((id) => `${state[id]?.count ?? ''}${state[id]?.live ? '*' : ''}`).join('|')
  const hidden = useHiddenTabs(stripRef, INSPECTOR_TABS, tab, contentKey)
  const shown = hidden.length === 0 ? items : items.filter((item) => !hidden.includes(item.id))
  const edges = useStripEdges(stripRef, tab, { strip: '[role="tablist"]', current: '[aria-selected="true"]' })
  const [moreOpen, setMoreOpen] = useState(false)
  const moreItems: ActionMenuItem[] = hidden.map((id) => {
    const s = state[id]
    return {
      id,
      label: INSPECTOR_TAB_LABEL[id],
      ...(s?.count ? { detail: String(s.count) } : s?.live ? { detail: 'working now' } : {}),
      onSelect: () => onSelect(id)
    }
  })
  // A hidden tab with something waiting or working marks the button, as its tab would.
  const moreSignals = hidden.some((id) => Boolean(state[id]?.count) || Boolean(state[id]?.live))
  return (
    <section
      ref={sectionRef}
      aria-label="Inspector"
      className={cn(
        'flex min-h-0 min-w-0 flex-col overflow-hidden bg-bg',
        expanded ? 'flex-1' : 'shrink-0 border-l border-border'
      )}
      style={style}
      data-inspector
      data-right-dock
      data-dock-expanded={expanded ? '1' : '0'}
    >
      {bare ? null : (
        // pl-3: each row-size tab pads its label 4px for the ring, so labels start at 16px.
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-3 pr-2" data-inspector-tabs>
          <div ref={stripRef} className="flex min-w-0 flex-1 items-center gap-2 self-stretch">
            <Tabs
              items={shown}
              value={tab}
              onChange={onSelect}
              size="row"
              label="Inspector"
              panelIdPrefix={PANEL_ID_PREFIX}
              // A narrow inspector scrolls its strip sideways; an edge with
              // tabs past it fades, so a cut label reads as more, not a typo.
              className={cn(
                'min-w-0 flex-1 overflow-x-auto [scrollbar-width:none]',
                stripEdgeMask(edges)
              )}
            />
            {hidden.length > 0 ? (
              <ActionMenu
                open={moreOpen}
                onOpenChange={setMoreOpen}
                placement="down"
                align="end"
                aria-label="More panels"
                items={moreItems}
                trigger={(t) => (
                  <span className="relative inline-flex shrink-0" data-inspector-more>
                    <IconButton
                      ref={t.ref}
                      icon="more"
                      label={`More panels: ${hidden.map((id) => INSPECTOR_TAB_LABEL[id]).join(', ')}`}
                      size="xs"
                      tone="muted"
                      aria-expanded={t['aria-expanded']}
                      aria-controls={t['aria-controls']}
                      aria-haspopup={t['aria-haspopup']}
                      onClick={t.onClick}
                    />
                    {moreSignals ? (
                      <span aria-hidden="true" className="pointer-events-none absolute right-0.5 top-0.5 size-1.5 rounded-full bg-accent" />
                    ) : null}
                  </span>
                )}
              />
            ) : null}
          </div>
          <IconButton
            icon={expanded ? 'collapse' : 'expand'}
            label={
              expanded
                ? `Back to the record (${shortcutLabel('inspectorExpand')})`
                : `Expand to full width (${shortcutLabel('inspectorExpand')})`
            }
            size="xs"
            tone="muted"
            onClick={onToggleExpanded}
          />
          <IconButton
            icon="close"
            label={`Hide inspector (${shortcutLabel('inspector')})`}
            size="xs"
            tone="muted"
            onClick={onHide}
          />
        </div>
      )}
      {children}
    </section>
  )
}

