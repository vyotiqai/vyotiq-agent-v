import type { CSSProperties, ReactNode, Ref } from 'react'
import { IconButton, Tabs, cn, type TabItem } from '@renderer/lib/ui'
import { shortcutLabel } from '@renderer/lib/shortcuts'
import { INSPECTOR_TAB_SHORTCUTS } from '@renderer/lib/shortcuts/bindings'
import type { ChatRightPanelId } from '@renderer/lib/utils/layout'

/** The strip's order — Alt 1–6 follow it. */
export const INSPECTOR_TABS: readonly ChatRightPanelId[] = ['changes', 'files', 'terminal', 'browser', 'pr', 'plan']

const LABEL: Record<ChatRightPanelId, string> = {
  changes: 'Changes',
  files: 'Files',
  terminal: 'Terminal',
  browser: 'Browser',
  pr: 'PR',
  plan: 'Plan'
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
      label: LABEL[id],
      ...(s?.count ? { count: s.count } : {}),
      ...(s?.live ? { live: true } : {}),
      title: s?.detail ? `${s.detail} · ${chord}` : chord
    }
  })
  const style: CSSProperties | undefined = expanded ? undefined : { width }
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
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2" data-inspector-tabs>
          <Tabs
            items={items}
            value={tab}
            onChange={onSelect}
            size="sm"
            label="Inspector"
            panelIdPrefix="dock-panel-"
            // A narrow inspector scrolls its strip sideways; the padding keeps
            // the current tab's underline inside the scroller.
            className="min-w-0 flex-1 overflow-x-auto pb-px [scrollbar-width:none]"
          />
          <IconButton
            icon={expanded ? 'collapse' : 'expand'}
            label={
              expanded
                ? `Back to the record (${shortcutLabel('inspectorExpand')})`
                : `Expand to full width (${shortcutLabel('inspectorExpand')})`
            }
            size="sm"
            tone="muted"
            onClick={onToggleExpanded}
          />
          <IconButton
            icon="close"
            label={`Hide inspector (${shortcutLabel('inspector')})`}
            size="sm"
            tone="muted"
            onClick={onHide}
          />
        </div>
      )}
      {children}
    </section>
  )
}
