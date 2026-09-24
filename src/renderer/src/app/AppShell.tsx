import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import type { ActiveRun, NotificationItem, RunSummary } from '@shared/ipc'
import { workspacePathsEqual } from '@shared/workspacePathMatch'
import { BreakpointProvider, useIsDesktop } from '@renderer/lib/context/BreakpointProvider'
import { NavigatorSlotContext } from '@renderer/lib/context/NavigatorSlot'
import { useOverlayPanel } from '@renderer/lib/hooks/useOverlayPanel'
import { usePersistedBoolean } from '@renderer/lib/hooks/usePersistedBoolean'
import { usePersistedNumber } from '@renderer/lib/hooks/usePersistedNumber'
import { useNotifications } from '@renderer/lib/hooks/useNotifications'
import { useRunToasts } from '@renderer/lib/hooks/useRunToasts'
import {
  SIDEBAR_COLLAPSED_KEY,
  SIDEBAR_WIDTH_KEY,
  SIDEBAR_WIDTH_MAX_PX,
  SIDEBAR_WIDTH_MIN_PX,
  SIDEBAR_WIDTH_PX,
  clampSidebarWidthPx
} from '@renderer/lib/utils/layout'
import { PanelResizeHandle, cn, pushToast } from '@renderer/lib/ui'
import { ErrorBoundary } from '@renderer/lib/ErrorBoundary'
import { focusComposerMessage, useAppShortcuts } from '@renderer/lib/shortcuts'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import type { SettingsSection } from '@renderer/features/settings'
import { CommandPalette, type PaletteFile } from '@renderer/features/commandPalette/CommandPalette'
import {
  paletteCommands,
  paletteSettingsCommands,
  paletteUpdateCommands,
  runPaletteCommand
} from '@renderer/features/commandPalette/paletteCommands'
import { SETTINGS_SEARCH_INDEX, revealSettingsFieldWhenMounted } from '@renderer/features/settings/settingsSearchIndex'
import { useUpdaterState } from '@renderer/features/updates/updaterStore'
import { WhatsNewModal } from '@renderer/features/whats-new/WhatsNewModal'
import { TitleBar } from './TitleBar'
import { Navigator, type NavigatorPlace } from './navigator/Navigator'
import { buildNavigatorSections, type NavRow } from './navigator/navigatorModel'
import { useNavigatorScope } from './navigator/useNavigatorScope'

export type ShellView = 'chat' | 'settings' | 'marketplace' | 'teammates' | 'home' | 'usage'

export type AppShellProps = {
  view: ShellView
  /** The active workspace. */
  workspacePath: string | null
  openWorkspaces?: string[]
  runsByWorkspacePath?: Record<string, { runs: RunSummary[]; runsCapped?: boolean; runsError?: string | null }>
  /** Clear a workspace's failed task-list load once it has been read. */
  onDismissRunsError?: (path?: string) => void
  activeRuns?: ActiveRun[]
  activeRunsLoaded?: boolean
  /** The task in the focused pane. */
  focusedRun?: { workspacePath: string; runId: string } | null
  /** True for a task open in any pane (split view). */
  isRunOpenInPane?: (workspacePath: string, runId: string) => boolean
  onOpenSettings: () => void
  onOpenSettingsSection?: (section: SettingsSection) => void
  onOpenFeedback?: () => void
  onOpenMarketplace: () => void
  onOpenChat: () => void
  onOpenHome: () => void
  onOpenUsage: () => void
  onNewChat: () => void
  onNewChatInWorkspace?: (path: string) => void
  /** A new task whose brief starts as `text` (palette Ctrl ↵). */
  onNewTaskWithText?: (path: string, text: string) => void
  onSelectRunInWorkspace?: (path: string, runId: string) => void
  /** A finished task, with Changes on what it changed (a Ready for review toast's Review). */
  onReviewTask?: (path: string, runId: string) => void
  /** Open a task in a second pane beside the focused one (palette Shift ↵). */
  onOpenRunBeside?: (path: string, runId: string) => void
  onRenameRunInWorkspace?: (path: string, runId: string, goal: string) => void
  onDeleteRunInWorkspace?: (path: string, runId: string) => void
  onExportRunInWorkspace?: (path: string, runId: string) => void
  onCopyRunLinkInWorkspace?: (path: string, runId: string) => void
  onStopRunInWorkspace?: (path: string, runId: string) => void
  onResumeRunInWorkspace?: (path: string, runId: string) => void
  onPauseGoalInWorkspace?: (path: string, runId: string, live: boolean) => void
  onStopLoopInWorkspace?: (path: string, runId: string) => void
  /** `pinnedRunKey` of every pinned task. */
  pinnedRunKeys?: readonly string[]
  onTogglePinnedRun?: (path: string, runId: string) => void
  onLoadOlderRuns?: (path: string) => void
  onSwitchWorkspace?: (path: string) => void
  onCloseWorkspace?: (path: string) => void
  onAddWorkspace?: () => void
  /** Open a workspace file in the Files panel. */
  onOpenWorkspaceFile?: (workspacePath: string, path: string) => void
  /** When true, Escape may stop the active run (after other Esc handlers). */
  running?: boolean
  onChatStop?: () => void
  /** Close the focused task tab (Ctrl/Cmd+W). */
  onCloseChat?: () => void
  /** Insert an empty pane beside the focused one (Ctrl/Cmd+\). */
  onSplitPane?: () => void
  children: ReactNode
  loading?: boolean
}

function placeOf(view: ShellView): NavigatorPlace {
  if (view === 'home') return 'home'
  if (view === 'usage') return 'usage'
  if (view === 'marketplace') return 'extensions'
  if (view === 'settings') return 'settings'
  if (view === 'chat') return 'task'
  return 'other'
}

/**
 * The window: the title band over the navigator and the work panes. Flush —
 * panes meet edge to edge, one hairline under the band and one between panes
 * are the only chrome. There is no status bar: every fact it held has a home
 * in the navigator, the task header or the instruction line.
 */
function AppShellInner(props: AppShellProps) {
  const {
    view,
    workspacePath,
    openWorkspaces = [],
    runsByWorkspacePath = {},
    activeRuns = [],
    activeRunsLoaded = false,
    focusedRun = null,
    children,
    loading,
    onOpenChat,
    onOpenHome,
    onOpenSettings,
    onOpenSettingsSection,
    onNewChat,
    onNewChatInWorkspace,
    onSelectRunInWorkspace,
    onSwitchWorkspace
  } = props
  const isDesktop = useIsDesktop()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [navigatorHidden, setNavigatorHidden] = usePersistedBoolean(SIDEBAR_COLLAPSED_KEY, false)
  const [navigatorWidthPx, setNavigatorWidthPx] = usePersistedNumber(
    SIDEBAR_WIDTH_KEY,
    SIDEBAR_WIDTH_PX,
    clampSidebarWidthPx
  )
  const [scopePath, setScopePath] = useNavigatorScope(openWorkspaces)
  // Settings brings its own index to the navigator's column (see NavigatorSlot).
  const lendsNavigatorColumn = view === 'settings'
  const [navigatorSlot, setNavigatorSlot] = useState<HTMLElement | null>(null)
  const pinnedKeys = useMemo(() => new Set(props.pinnedRunKeys ?? []), [props.pinnedRunKeys])
  const drawerRef = useRef<HTMLDivElement>(null)
  const drawerTriggerRef = useRef<HTMLElement | null>(null)
  const mainRef = useRef<HTMLElement>(null)
  const navigatorOpen = isDesktop ? !navigatorHidden : drawerOpen

  // The task in front of you: the focused pane's, while the task view is showing.
  const visibleRunId = view === 'chat' ? (focusedRun?.runId ?? null) : null
  const notifications = useNotifications({ focusedRunId: visibleRunId })

  const closeDrawer = useCallback((): void => setDrawerOpen(false), [])
  const onToggleNavigator = useCallback((): void => {
    if (isDesktop) {
      setNavigatorHidden((v) => !v)
      setDrawerOpen(false)
      return
    }
    drawerTriggerRef.current = document.activeElement as HTMLElement | null
    setDrawerOpen((v) => !v)
  }, [isDesktop, setNavigatorHidden])

  useEffect(() => {
    if (isDesktop) setDrawerOpen(false)
  }, [isDesktop])

  useEffect(() => {
    const onResize = (): void => setNavigatorWidthPx((w) => clampSidebarWidthPx(w))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [setNavigatorWidthPx])

  useOverlayPanel({
    open: drawerOpen,
    onClose: closeDrawer,
    panelRef: drawerRef,
    inertTargetRef: mainRef,
    restoreFocusRef: drawerTriggerRef
  })

  /** Every task across open workspaces, in navigator order — the palette and Ctrl J read this. */
  const allTasks = useMemo<NavRow[]>(
    () =>
      buildNavigatorSections({
        runsByWorkspacePath,
        openPaths: openWorkspaces,
        activePath: workspacePath,
        activeRuns,
        activeRunsLoaded,
        scopePath: null
      }).flatMap((section) => section.rows),
    [runsByWorkspacePath, openWorkspaces, workspacePath, activeRuns, activeRunsLoaded]
  )

  const openTask = useCallback(
    (path: string, runId: string): void => {
      onSelectRunInWorkspace?.(path, runId)
      onOpenChat()
      if (!isDesktop) setDrawerOpen(false)
    },
    [onSelectRunInWorkspace, onOpenChat, isDesktop]
  )

  useRunToasts({
    items: notifications.items,
    isOnScreen: (path, runId) =>
      view === 'chat' && (runId === visibleRunId || (props.isRunOpenInPane?.(path, runId) ?? false)),
    onOpenTask: openTask,
    onReviewTask: (path, runId) => {
      if (props.onReviewTask) {
        props.onReviewTask(path, runId)
        if (!isDesktop) setDrawerOpen(false)
      } else openTask(path, runId)
    }
  })

  const onNextNeedsYou = useCallback((): void => {
    const waiting = allTasks.filter((row) => row.state === 'needs')
    if (waiting.length === 0) {
      pushToast('Nothing is waiting on you.')
      return
    }
    const at = focusedRun
      ? waiting.findIndex(
          (row) => row.runId === focusedRun.runId && workspacePathsEqual(row.workspacePath, focusedRun.workspacePath)
        )
      : -1
    const next = waiting[(at + 1) % waiting.length]!
    openTask(next.workspacePath, next.runId)
  }, [allTasks, focusedRun, openTask])

  /** Where a new task goes: the workspace the navigator is filtered to, else the active one. */
  const newTaskPath = scopePath ?? workspacePath ?? openWorkspaces[0] ?? null

  const onNewTask = useCallback((): void => {
    if (newTaskPath && onNewChatInWorkspace && (!workspacePath || !workspacePathsEqual(newTaskPath, workspacePath))) {
      onNewChatInWorkspace(newTaskPath)
    } else {
      onNewChat()
    }
    if (!isDesktop) setDrawerOpen(false)
  }, [newTaskPath, workspacePath, onNewChatInWorkspace, onNewChat, isDesktop])

  const switchWorkspaceByIndex = useCallback(
    (index: number): void => {
      const path = openWorkspaces[index]
      if (!path) return
      onSwitchWorkspace?.(path)
      onOpenChat()
    },
    [openWorkspaces, onSwitchWorkspace, onOpenChat]
  )

  const searchFiles = useMemo(() => {
    const path = workspacePath
    if (!path || !window.vyotiq?.workspaceSuggestPaths) return undefined
    return async (query: string, limit: number): Promise<PaletteFile[]> => {
      const res = await window.vyotiq.workspaceSuggestPaths({ workspacePath: path, query, maxResults: limit })
      if (!res.ok) return []
      return res.data.paths.map((p) => ({ workspacePath: path, path: p }))
    }
  }, [workspacePath])

  const update = useUpdaterState()
  const commands = useMemo(
    () => [
      ...paletteUpdateCommands(update),
      ...paletteCommands({ workspaces: openWorkspaces, activePath: workspacePath, canSendFeedback: Boolean(props.onOpenFeedback) })
    ],
    [update, openWorkspaces, workspacePath, props.onOpenFeedback]
  )

  const openSettingsField = useCallback(
    (fieldId: string): void => {
      const entry = SETTINGS_SEARCH_INDEX.find((e) => e.id === fieldId)
      if (entry && onOpenSettingsSection) onOpenSettingsSection(entry.section)
      else onOpenSettings()
      revealSettingsFieldWhenMounted(fieldId)
    },
    [onOpenSettingsSection, onOpenSettings]
  )

  useAppShortcuts({
    onToggleSidebar: onToggleNavigator,
    onOpenSearch: () => setPaletteOpen(true),
    onNextNeedsYou,
    onNewChat: onNewTask,
    onOpenHome,
    onSwitchWorkspaceByIndex: switchWorkspaceByIndex,
    onOpenSettings,
    chatViewActive: view === 'chat',
    running: props.running,
    onStop: props.onChatStop,
    onCloseChat: props.onCloseChat,
    onSplitPane: props.onSplitPane,
    drawerOpen,
    onFindInFiles: () => window.dispatchEvent(new Event('vyotiq:find-in-files'))
  })

  const onOpenNotification = useCallback(
    (item: NotificationItem): void => {
      const action = item.action
      if (!action) return
      switch (action.type) {
        case 'open_run':
          openTask(action.workspacePath, action.runId)
          return
        case 'open_settings':
          if (onOpenSettingsSection) onOpenSettingsSection(action.section)
          else onOpenSettings()
          return
        default: {
          const exhaustive: never = action
          return exhaustive
        }
      }
    },
    [openTask, onOpenSettingsSection, onOpenSettings]
  )

  const navigator = lendsNavigatorColumn ? (
    <div
      ref={setNavigatorSlot}
      data-navigator-slot
      className="app-region-no-drag flex h-full shrink-0 flex-col bg-chrome"
      style={{ width: isDesktop ? navigatorWidthPx : SIDEBAR_WIDTH_PX }}
    />
  ) : (
    <Navigator
      place={placeOf(view)}
      selected={focusedRun}
      isRunOpen={props.isRunOpenInPane}
      openPaths={openWorkspaces}
      activePath={workspacePath}
      runsByWorkspacePath={runsByWorkspacePath}
      activeRuns={activeRuns}
      activeRunsLoaded={activeRunsLoaded}
      scopePath={scopePath}
      onScopeChange={setScopePath}
      onNewTask={onNewTask}
      onOpenHome={() => {
        props.onOpenHome()
        if (!isDesktop) setDrawerOpen(false)
      }}
      onOpenExtensions={() => {
        props.onOpenMarketplace()
        if (!isDesktop) setDrawerOpen(false)
      }}
      onOpenUsage={() => {
        props.onOpenUsage()
        if (!isDesktop) setDrawerOpen(false)
      }}
      onOpenSettings={props.onOpenSettings}
      onOpenShortcuts={() => {
        if (props.onOpenSettingsSection) props.onOpenSettingsSection('shortcuts')
        else props.onOpenSettings()
      }}
      onAddWorkspace={() => props.onAddWorkspace?.()}
      onCloseWorkspace={(path) => {
        if (scopePath && workspacePathsEqual(scopePath, path)) setScopePath(null)
        props.onCloseWorkspace?.(path)
      }}
      onLoadOlderRuns={(path) => props.onLoadOlderRuns?.(path)}
      onDismissRunsError={(path) => props.onDismissRunsError?.(path)}
      rowActions={{
        onSelect: openTask,
        onRename: (path, runId, goal) => props.onRenameRunInWorkspace?.(path, runId, goal),
        onDelete: (path, runId) => props.onDeleteRunInWorkspace?.(path, runId),
        onExport: props.onExportRunInWorkspace,
        onCopyLink: props.onCopyRunLinkInWorkspace,
        onStop: props.onStopRunInWorkspace,
        onResume: props.onResumeRunInWorkspace,
        onPauseGoal: props.onPauseGoalInWorkspace,
        onStopLoop: props.onStopLoopInWorkspace,
        onTogglePin: props.onTogglePinnedRun
      }}
      pinnedKeys={pinnedKeys}
      notifications={{
        items: notifications.items,
        unreadCount: notifications.unreadCount,
        onMarkRead: (req) => void notifications.markRead(req),
        onDismiss: (req) => void notifications.dismiss(req),
        onOpenItem: onOpenNotification,
        onOpenSettings: () => {
          if (props.onOpenSettingsSection) props.onOpenSettingsSection('notifications')
          else props.onOpenSettings()
        }
      }}
      widthPx={isDesktop ? navigatorWidthPx : SIDEBAR_WIDTH_PX}
    />
  )

  const showDesktopNavigator = isDesktop && !navigatorHidden

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-chrome text-fg" data-app-shell>
      <a href="#main-content" className="skip-link" tabIndex={0}>
        Skip to main content
      </a>
      <ErrorBoundary title="Title bar couldn't render">
        <TitleBar
          navigatorOpen={navigatorOpen}
          navigatorWidthPx={navigatorWidthPx}
          onToggleNavigator={onToggleNavigator}
          onOpenSearch={() => setPaletteOpen(true)}
          compact={!isDesktop}
        />
      </ErrorBoundary>

      <div className="relative flex min-h-0 flex-1 border-t border-border">
        {showDesktopNavigator ? (
          <>
            <ErrorBoundary title="Navigator couldn't render" resetKey={openWorkspaces.join('|')}>
              {navigator}
            </ErrorBoundary>
            <PanelResizeHandle
              label="Resize navigator"
              value={navigatorWidthPx}
              min={SIDEBAR_WIDTH_MIN_PX}
              max={SIDEBAR_WIDTH_MAX_PX}
              edge="end"
              onChange={setNavigatorWidthPx}
              // Main's border is the line; the handle lights it up.
              hairline
            />
          </>
        ) : null}

        <main
          id="main-content"
          ref={mainRef}
          className={cn(
            'flex min-h-0 min-w-0 flex-1 flex-col bg-bg outline-none',
            showDesktopNavigator ? 'border-l border-border' : ''
          )}
          tabIndex={-1}
          aria-busy={loading ? true : undefined}
        >
          <NavigatorSlotContext.Provider value={lendsNavigatorColumn ? navigatorSlot : null}>
            {children}
          </NavigatorSlotContext.Provider>
        </main>

        {drawerOpen && !isDesktop ? (
          <div
            ref={drawerRef}
            id="app-nav-drawer"
            className="absolute inset-0 z-drawer flex outline-none"
            role="dialog"
            aria-modal="true"
            aria-label="Navigator"
            tabIndex={-1}
          >
            <div className="absolute inset-0 bg-overlay animate-fade-in" data-overlay-scrim aria-hidden onClick={closeDrawer} />
            <div className="relative z-sticky h-full min-h-0 border-r border-border animate-slide-in-left">
              <ErrorBoundary title="Navigator couldn't render" resetKey={openWorkspaces.join('|')}>
                {navigator}
              </ErrorBoundary>
            </div>
          </div>
        ) : null}
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        tasks={allTasks}
        commands={commands}
        settingsCommands={paletteSettingsCommands}
        searchFiles={searchFiles}
        newTaskIn={newTaskPath ? { name: formatWorkspaceName(newTaskPath) } : null}
        onOpenTask={(row, beside) => {
          if (beside && props.onOpenRunBeside) props.onOpenRunBeside(row.workspacePath, row.runId)
          else openTask(row.workspacePath, row.runId)
        }}
        onOpenFile={(file) => props.onOpenWorkspaceFile?.(file.workspacePath, file.path)}
        onNewTask={(text) => {
          if (newTaskPath && props.onNewTaskWithText) props.onNewTaskWithText(newTaskPath, text)
        }}
        onRunCommand={(id) =>
          runPaletteCommand(id, {
            workspaces: openWorkspaces,
            onOpenSettings: props.onOpenSettings,
            onOpenHome: props.onOpenHome,
            onOpenUsage: props.onOpenUsage,
            onNewTask,
            onToggleNavigator,
            onNextNeedsYou,
            onOpenFeedback: props.onOpenFeedback,
            onStop: props.onChatStop,
            onCloseChat: props.onCloseChat,
            onSplitPane: props.onSplitPane,
            onSwitchWorkspaceByIndex: switchWorkspaceByIndex,
            onNewChatInWorkspace: props.onNewChatInWorkspace,
            onFocusInstructionLine: () => {
              focusComposerMessage()
            },
            onOpenSettingsField: openSettingsField
          })
        }
      />
      <WhatsNewModal />
    </div>
  )
}

export function AppShell(props: AppShellProps): ReactElement {
  return (
    <BreakpointProvider>
      <AppShellInner {...props} />
    </BreakpointProvider>
  )
}
