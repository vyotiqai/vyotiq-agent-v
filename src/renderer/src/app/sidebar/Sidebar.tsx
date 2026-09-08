import { cn, NavItem } from '@renderer/lib/ui'
import { shortcutLabel } from '@renderer/lib/shortcuts'
import { useDockImmersive } from '@renderer/lib/hooks/dockImmersiveStore'
import { useWorkspaceHotUi } from '@renderer/lib/hooks/workspaceHotUiStore'
import { useCallback, useEffect, useState } from 'react'
import {
  SIDEBAR_CONTAINER,
  SIDEBAR_PAD_X,
  SIDEBAR_SURFACE,
  SIDEBAR_WIDTH,
  SIDEBAR_WIDTH_COLLAPSED,
  SIDEBAR_WIDTH_COLLAPSED_DARWIN,
  SIDEBAR_WIDTH_PX
} from '@renderer/lib/utils/layout'
import { ChatList } from './ChatList'
import { SidebarCollapsedHeader, SidebarTopBar } from './SidebarTopBar'
import type { SidebarProps } from './types'
import { useSidebarChats } from './useSidebarChats'
import { NotificationsInbox } from './NotificationsInbox'
import { useNotifications } from '@renderer/lib/hooks/useNotifications'

export function Sidebar({
  view,
  onDismissRunsError,
  sessionQuery: sessionQueryProp,
  searchRef,
  hasWorkspace,
  openPaths,
  activePath,
  runsByWorkspacePath,
  activeRuns,
  onSwitchWorkspace,
  onCloseWorkspace,
  onAddWorkspace,
  workspaceHasBackgroundRun,
  onSessionQuery,
  onOpenSettings,
  onOpenNotificationSettings,
  focusedRunId = null,
  onOpenMarketplace,
  onOpenHome,
  onOpenChat,
  onNewChatInWorkspace,
  onSelectRunInWorkspace,
  onRenameRunInWorkspace,
  onDeleteRunInWorkspace,
  onExportRunInWorkspace,
  onLoadOlderRuns,
  isRunOpenInPane,
  isRunFocusedInPane,
  openInstanceRunId = null,
  onCloseDrawer,
  onToggleSidebar,
  collapsed = false,
  hideSessions = false,
  widthPx,
  variant = 'desktop',
  /** Persisted per-workspace expand state + mutator (falls back to local when absent). */
  expandedByPath: expandedByPathProp,
  onSetWorkspaceExpanded
}: SidebarProps) {
  const workspaceReady = Boolean(hasWorkspace)
  const isDarwin = window.vyotiq?.platform === 'darwin'
  const isDrawer = variant === 'drawer'
  // Home mode hides the session list everywhere the sidebar renders it: the
  // desktop rail comes via `collapsed`; the mobile drawer collapses here.
  const isCollapsed = (collapsed && !isDrawer) || (hideSessions && isDrawer)
  const dockImmersive = useDockImmersive()
  const hotUi = useWorkspaceHotUi(activePath)
  const sessionQuery = activePath ? hotUi.sessionQuery : sessionQueryProp

  const [expandedByPathLocal, setExpandedByPathLocal] = useState<Record<string, boolean>>({})
  const expandedByPath = expandedByPathProp ?? expandedByPathLocal
  const setExpanded = useCallback(
    (path: string, expanded: boolean): void => {
      if (onSetWorkspaceExpanded) onSetWorkspaceExpanded(path, expanded)
      else setExpandedByPathLocal((prev) => ({ ...prev, [path]: expanded }))
    },
    [onSetWorkspaceExpanded]
  )

  const { filteredRuns, workspaceGroups } = useSidebarChats({
    openPaths: openPaths ?? [],
    activePath: activePath ?? null,
    sessionQuery,
    runsByWorkspacePath: runsByWorkspacePath ?? {},
    expandedByPath
  })

  const clearSearch = (): void => onSessionQuery('')

  const widthClass = isCollapsed
    ? isDarwin
      ? SIDEBAR_WIDTH_COLLAPSED_DARWIN
      : SIDEBAR_WIDTH_COLLAPSED
    : isDrawer
      ? SIDEBAR_WIDTH
      : undefined

  const expandedWidthPx =
    !isDrawer && !isCollapsed ? (widthPx ?? SIDEBAR_WIDTH_PX) : undefined

  const afterNav = (): void => {
    if (isDrawer) onCloseDrawer()
  }

  const openSettings = (): void => {
    clearSearch()
    onOpenSettings()
    afterNav()
  }

  const openNotificationSettings = (): void => {
    clearSearch()
    ;(onOpenNotificationSettings ?? onOpenSettings)()
    afterNav()
  }

  const { items: notificationItems, unreadCount, markRead, dismiss } = useNotifications({
    focusedRunId
  })

  const openMarketplace = (): void => {
    clearSearch()
    onOpenMarketplace()
    afterNav()
  }

  const openHome = (): void => {
    clearSearch()
    onOpenHome?.()
    afterNav()
  }

  return (
    <aside
      className={cn(
        SIDEBAR_CONTAINER,
        SIDEBAR_SURFACE,
        'flex h-full min-h-0 shrink-0 flex-col self-stretch overflow-hidden',
        widthClass
      )}
      style={expandedWidthPx != null ? { width: expandedWidthPx } : undefined}
      aria-label="Sidebar"
      data-sidebar-shell
      data-collapsed={isCollapsed || undefined}
    >
      {isCollapsed ? (
        <SidebarCollapsedHeader
          isDrawer={isDrawer}
          isCollapsed={isCollapsed}
          isDarwin={isDarwin}
          onToggleSidebar={onToggleSidebar}
          onOpenHome={openHome}
          onAddWorkspace={onAddWorkspace}
        />
      ) : (
        <SidebarTopBar
          isDrawer={isDrawer}
          isDarwin={isDarwin}
          workspaceReady={workspaceReady}
          searchRef={searchRef}
          sessionQuery={sessionQuery}
          onToggleSidebar={onToggleSidebar}
          onSessionQuery={onSessionQuery}
          onOpenHome={openHome}
        />
      )}

      {isCollapsed ? (
        <div className="min-h-0 flex-1" aria-hidden />
      ) : (
        <div
          className="app-region-no-drag sidebar-scroll min-h-0 flex-1 overflow-x-hidden"
          data-sidebar-scroll
        >
          <ChatList
            workspaceReady={workspaceReady}
            sessionQuery={sessionQuery}
            filteredRunsCount={filteredRuns.length}
            workspaceGroups={workspaceGroups}
            onToggleWorkspace={(path) =>
              setExpanded(path, !(expandedByPath[path] ?? false))
            }
            onSwitchWorkspace={(path) => {
              setExpanded(path, true)
              onSwitchWorkspace?.(path)
            }}
            onCloseWorkspace={(path) => onCloseWorkspace?.(path)}
            onAddWorkspace={() => onAddWorkspace?.()}
            activeRuns={activeRuns ?? []}
            workspaceHasBackgroundRun={(path) => workspaceHasBackgroundRun?.(path) ?? false}
            onDismissRunsError={(path) => onDismissRunsError?.(path)}
            onNewChatInWorkspace={
              onNewChatInWorkspace
                ? (path) => {
                    setExpanded(path, true)
                    onNewChatInWorkspace(path)
                  }
                : undefined
            }
            onSelectRun={(path, runId) => {
              setExpanded(path, true)
              onSelectRunInWorkspace?.(path, runId)
              onOpenChat()
              afterNav()
            }}
            onRenameRun={(path, runId, goal) => {
              onRenameRunInWorkspace?.(path, runId, goal)
            }}
            onDeleteRun={(path, runId) => {
              onDeleteRunInWorkspace?.(path, runId)
            }}
            onExportRun={(path, runId) => {
              onExportRunInWorkspace?.(path, runId)
            }}
            onLoadOlderRuns={(path) => {
              setExpanded(path, true)
              onLoadOlderRuns?.(path)
            }}
            isRunOpenInPane={isRunOpenInPane}
            isRunFocusedInPane={isRunFocusedInPane}
            openInstanceRunId={openInstanceRunId}
            hideSessionRuns={dockImmersive && !sessionQuery.trim()}
          />
        </div>
      )}

      <div
        className={cn(
          'app-region-no-drag flex shrink-0 min-w-0 flex-col border-t border-border/30',
          SIDEBAR_PAD_X,
          'gap-0.5 py-2',
          isCollapsed ? 'items-center' : ''
        )}
      >
        <NotificationsInbox
          items={notificationItems}
          unreadCount={unreadCount}
          collapsed={isCollapsed}
          onMarkRead={(req) => {
            void markRead(req)
          }}
          onDismiss={(req) => {
            void dismiss(req)
          }}
          onOpenItem={(item) => {
            const action = item.action
            if (!action) return
            switch (action.type) {
              case 'open_run':
                onSelectRunInWorkspace?.(action.workspacePath, action.runId)
                onOpenChat()
                afterNav()
                return
              case 'open_settings':
                openNotificationSettings()
                return
              default: {
                const _exhaustive: never = action
                return _exhaustive
              }
            }
          }}
          onOpenSettings={openNotificationSettings}
        />
        <NavItem
          label="Settings"
          icon="gear"
          variant={isCollapsed ? 'icon' : 'sidebar'}
          current={view === 'settings'}
          className={isCollapsed ? undefined : 'w-full'}
          title={`Settings (${shortcutLabel('settings')})`}
          onClick={openSettings}
        />
        <NavItem
          label="Marketplace"
          icon="marketplace"
          variant={isCollapsed ? 'icon' : 'sidebar'}
          current={view === 'marketplace'}
          className={isCollapsed ? undefined : 'w-full'}
          onClick={openMarketplace}
        />
      </div>
    </aside>
  )
}
