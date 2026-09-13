import { useMemo, type RefObject } from 'react'
import { Tooltip, cn } from '@renderer/lib/ui'
import { Icon, type IconName } from '@renderer/lib/icons'
import { TITLEBAR_ACTIONS_PAD, type ChatRightPanelId, type DockImmersiveTabId } from '@renderer/lib/utils/layout'
import { DOCK_PANELS, dockPanelDef } from '@renderer/lib/utils/dockPanels'
import { handleTabListKeyDown } from '@renderer/lib/utils/tabListKeyboard'
import { DOCK_CHROME_ICON_HOVER, DOCK_QUICK_LAUNCH_BTN, dockPanelTabButtonClass, dockPanelTabCloseClass, dockPanelTabShellClass, tabMiddleClickHandlers } from './PanelChrome'
import { DockQuickLaunch } from './DockQuickLaunch'

export type DockTabItem = {
  id: DockImmersiveTabId
  label: string
  icon: IconName
  /** When false, omit the close control (Agent tab). Defaults to true for panel tabs. */
  closable?: boolean
}

export const AGENT_DOCK_TAB: DockTabItem = {
  id: 'agent',
  label: 'Agent',
  icon: 'bot',
  closable: false
}

/**
 * Cursor-style horizontal tabs above the active right dock panel.
 * Immersive / titlebar-embedded: panel tabs, then spacer, then
 * quick-launch icons / expand — sessions never sit beside quick launch.
 */
export function DockTabBar({
  active,
  tabs,
  onSelect,
  onCloseTab,
  onOpenPanel,
  expanded,
  onToggleExpanded,
  variant = 'dock',
  terminalSessionBarHostRef,
  embeddedInTitleBar = false,
  className
}: {
  active: DockImmersiveTabId
  tabs: DockTabItem[]
  onSelect: (id: DockImmersiveTabId) => void
  onCloseTab: (id: ChatRightPanelId) => void
  onOpenPanel: (id: ChatRightPanelId) => void
  expanded?: boolean
  onToggleExpanded?: () => void
  variant?: 'dock' | 'immersive'
  /** Host for {@link TerminalSessionBar} when the terminal panel is active. */
  terminalSessionBarHostRef?: RefObject<HTMLDivElement | null>
  /** Side-dock tabs portaled into the title bar — fill host height, no second border. */
  embeddedInTitleBar?: boolean
  className?: string
}) {
  const immersive = variant === 'immersive'
  const inTitleBar = immersive || embeddedInTitleBar
  const hasSessionChrome = Boolean(terminalSessionBarHostRef)
  /** Push quick-launch / expand away from session + (side-dock strip and immersive titlebar). */
  const separateActions = inTitleBar || hasSessionChrome

  const openIds = useMemo(() => new Set(tabs.map((t) => t.id)), [tabs])
  const addable = useMemo(
    () => DOCK_PANELS.filter((p) => !openIds.has(p.id)),
    [openIds]
  )
  const tabIds = useMemo(() => tabs.map((t) => t.id), [tabs])

  const quickLaunch =
    addable.length > 0 ? (
      <DockQuickLaunch panels={addable} onOpenPanel={onOpenPanel} className="min-w-0 flex-1" />
    ) : null

  const showActionsDivider =
    (tabs.length > 0 || hasSessionChrome) &&
    (addable.length > 0 || onToggleExpanded != null)

  return (
    <div
      className={cn(
        'flex min-w-0 shrink-0 flex-row items-center gap-0.5 bg-transparent',
        inTitleBar
          ? 'h-full w-full min-w-0 border-0 px-1 py-0'
          : 'border-b border-border/40 px-1 py-0.5',
        className
      )}
      data-dock-tab-bar
      data-dock-tab-variant={variant}
      data-dock-embedded={embeddedInTitleBar ? '1' : undefined}
    >
      <div
        className={cn(
          'flex min-w-0 flex-row items-center gap-1',
          inTitleBar
            ? 'app-region-no-drag min-w-0 flex-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:h-0 [&::-webkit-scrollbar]:w-0'
            : separateActions
              ? 'min-w-0 max-w-full shrink overflow-x-auto'
              : 'sidebar-scroll-x min-w-0 flex-1 overflow-x-auto'
        )}
        role="tablist"
        aria-label={immersive ? 'Agent and panels' : 'Panels'}
        tabIndex={-1}
        data-dock-panel-tablist
        onKeyDown={(e) =>
          handleTabListKeyDown(e, {
            tabs: tabIds,
            activeId: active,
            onSelect: (id) => onSelect(id as DockImmersiveTabId)
          })
        }
      >
        {tabs.map((tab) => {
          const selected = tab.id === active
          const closable = tab.closable !== false && tab.id !== 'agent'
          return (
              <div
                key={tab.id}
                className={dockPanelTabShellClass(selected, closable)}
                {...tabMiddleClickHandlers(() => {
                  if (closable && tab.id !== 'agent') onCloseTab(tab.id)
                })}
              >
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`dock-panel-${tab.id}`}
                tabIndex={selected ? 0 : -1}
                className={dockPanelTabButtonClass(selected)}
                onKeyDown={(e) => {
                  if (e.key === 'Delete' && closable && tab.id !== 'agent') {
                    e.preventDefault()
                    onCloseTab(tab.id)
                  }
                }}
                onClick={() => onSelect(tab.id)}
              >
                <Icon
                  name={tab.icon}
                  size={14}
                  className={cn('shrink-0 self-center', selected ? 'text-fg' : 'text-secondary')}
                />
                <span className="min-w-0 truncate leading-tight">{tab.label}</span>
              </button>
              {closable ? (
                <Tooltip content={`Close ${tab.label}`}>
                  <button
                    type="button"
                    className={dockPanelTabCloseClass(selected)}
                    aria-label={`Close ${tab.label}`}
                    aria-keyshortcuts="Delete"
                    tabIndex={selected ? 0 : -1}
                    onClick={() => {
                      if (tab.id !== 'agent') onCloseTab(tab.id)
                    }}
                  >
                    <Icon name="close" size={10} />
                  </button>
                </Tooltip>
              ) : null}
            </div>
          )
        })}
      </div>

      {terminalSessionBarHostRef ? (
        <>
          <span className="mx-0.5 h-4 w-px shrink-0 bg-border/40" aria-hidden />
          <div
            ref={terminalSessionBarHostRef}
            className={cn(
              'inline-flex min-w-0 max-w-[min(100%,11rem)] shrink items-center overflow-hidden',
              inTitleBar && 'app-region-no-drag'
            )}
            data-terminal-session-bar-host="1"
          />
        </>
      ) : null}

      {separateActions && !embeddedInTitleBar ? (
        <div
          className={cn(
            'min-w-3 flex-1 self-stretch',
            inTitleBar && 'app-region-drag'
          )}
          aria-hidden
          data-titlebar-drag-spacer={inTitleBar ? '' : undefined}
          data-dock-action-spacer={!inTitleBar ? '' : undefined}
          onDoubleClick={
            inTitleBar ? () => void window.vyotiq?.windowMaximize() : undefined
          }
        />
      ) : null}

      <div
        className={cn(
          'relative flex h-7 min-w-0 max-w-[min(100%,12rem)] shrink items-center gap-0.5',
          inTitleBar && 'app-region-no-drag',
          inTitleBar && TITLEBAR_ACTIONS_PAD
        )}
      >
        {showActionsDivider ? (
          <span className="mx-0.5 h-4 w-px shrink-0 bg-border/40" aria-hidden />
        ) : null}
        {quickLaunch}
        {onToggleExpanded ? (
          <Tooltip content={expanded ? 'Collapse panel' : 'Expand panel'}>
            <button
              type="button"
              className={cn(DOCK_QUICK_LAUNCH_BTN, DOCK_CHROME_ICON_HOVER, 'shrink-0')}
              aria-label={expanded ? 'Collapse panel' : 'Expand panel'}
              onClick={onToggleExpanded}
            >
              <Icon name={expanded ? 'sidebar' : 'expand'} size={14} className="shrink-0" />
            </button>
          </Tooltip>
        ) : null}
      </div>
    </div>
  )
}

export function defaultDockTab(id: ChatRightPanelId, prNumber?: number | null): DockTabItem {
  const def = dockPanelDef(id)
  if (id === 'pr' && prNumber != null) {
    return { id, label: `PR #${prNumber}`, icon: def.icon }
  }
  return { id, label: def.label, icon: def.icon }
}
