import type { Ref } from 'react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AgentBrowserPanel } from './components/AgentBrowserPanel'
import type { WorkspaceFileOpenRequest } from './components/FilesPanel'
import { ChangesPanel } from './components/ChangesPanel'
import { ConfirmFileList } from './components/ConfirmFileList'
import { EmptyPanel } from './components/PanelChrome'
import { PlanPanel } from './components/PlanPanel'
import {
  INSPECTOR_DETAIL_MAX,
  INSPECTOR_TABS,
  INSPECTOR_TAB_LABEL,
  Inspector,
  type InspectorTabState
} from '@renderer/features/inspector/Inspector'
import { useAgentFileMarks } from '@renderer/features/inspector/agentFileMarks'
import {
  useAgentFileFocus,
  useAgentLiveActivity,
  useGitRevision
} from './components/ChatStreamLeaves'
import { useGitChrome } from './components/GitChrome'
import type { UiItem } from '@shared/transcript'
import type {
  AgentBrowserState,
  WorkspaceEditorRecoveryLoadResult
} from '@shared/ipc'
import { ErrorBoundary } from '@renderer/lib/ErrorBoundary'
import { Button, PanelResizeHandle, pushToast } from '@renderer/lib/ui'
import { useConfirm } from '@renderer/lib/hooks/useConfirm'
import { usePersistedBoolean } from '@renderer/lib/hooks/usePersistedBoolean'
import { usePersistedNumber } from '@renderer/lib/hooks/usePersistedNumber'
import {
  CHAT_RIGHT_PANEL_IDS,
  DOCK_WIDTH_DEFAULT_PX,
  DOCK_WIDTH_KEY,
  DOCK_WIDTH_MAX_PX,
  DOCK_WIDTH_MIN_PX,
  INSPECTOR_EXPANDED_KEY,
  INSPECTOR_OPEN_KEY,
  RIGHT_PANEL_KEY,
  clampDockWidthPx,
  readSidebarWidthPxForCapacity,
  isChatRightPanelId,
  type ChatRightPanelId
} from '@renderer/lib/utils/layout'
import { PANEL_SHORTCUT } from '@renderer/lib/utils/dockPanels'
import { formatPathLabel, truncateMiddle } from '@shared/utils/displayPath'
import { toWorkspaceRelPath } from '@shared/utils/workspacePath'
import { cn } from '@renderer/lib/ui/cn'
import { focusComposerMessage, matchShortcut, shouldBlockPanelShortcut } from '@renderer/lib/shortcuts'
import { INSPECTOR_TAB_SHORTCUTS } from '@renderer/lib/shortcuts/bindings'
import type { ChatItemsStore } from './chatStores'
import { ChatPaneHost, type PaneRenderOptions } from './ChatPaneHost'
import type { PaneCapacityContext } from '@renderer/lib/hooks/useWorkspaceManager'
import type { ChatPane, PaneDropZone } from '@renderer/lib/chat/chatPaneLayout'
import { consumeWorkspaceFileRequest, useWorkspaceFileRequest } from '@renderer/lib/chat/workspaceFileRequests'
import { workspacePathsEqual } from '@shared/workspacePathMatch'



/** Heavy dock panels are code-split: xterm/CodeMirror/PR tooling parse on first open. */
const FilesPanel = lazy(() =>
  import('./components/FilesPanel').then((m) => ({ default: m.FilesPanel }))
)
const TerminalPanel = lazy(() =>
  import('./components/TerminalPanel').then((m) => ({ default: m.TerminalPanel }))
)
const PrPanel = lazy(() => import('./components/PrPanel').then((m) => ({ default: m.PrPanel })))

function DockPanelSuspenseFallback() {
  return <div className="min-h-0 min-w-0 flex-1 animate-pulse bg-surface" aria-busy="true" />
}

/**
 * The work area before the pane layout exists — the boot frame, or a
 * workspace list that failed to load. Pane-shaped, so the first real pane
 * lands on the same edges.
 */
function PanePlaceholder({ loadError }: { loadError: string | null }) {
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-chat-pane-placeholder
      aria-busy={loadError ? undefined : true}
    >
      <div className="flex h-10 shrink-0 items-center border-b border-border pl-4 pr-2" />
      {loadError ? (
        <div role="alert" className="flex min-h-0 flex-1 flex-col">
          <EmptyPanel centered icon="warning" title="Couldn’t load workspaces" body={loadError} />
        </div>
      ) : (
        <div className="min-h-0 flex-1" />
      )}
    </div>
  )
}

export function ChatView({
  items,
  itemsStore,
  running,
  invokeId = null,
  pendingRun = false,
  workspacePath,
  writeConflictedPaths,
  activeRunId,
  headingRef,
  taskTitle = null,
  onSend,
  onStop,
  canUndoWrites = false,
  undoBusy = false,
  onUndoWrites,
  writeFileResolutions,
  writeResolvablePaths,
  writeCheckpointFiles,
  onKeepWriteFile,
  onDiscardWriteFile,
  onKeepAllWrites,
  resolveBlockedReason = null,
  multiPane = null,
  loadError = null,
  paneCount: paneCountProp = 1,
  onPaneCapacityChange,
  openChangesRequest = 0,
  openChangesScope = 'uncommitted',
  onOpenChangesRequestHandled
}: {
  items: UiItem[]
  /** When set, the inspector's leaves subscribe so ChatView skips token patches. */
  itemsStore?: ChatItemsStore
  running: boolean
  /** Live chatStart invoke id — PlanPanel uses it to detect stale receipts. */
  invokeId?: number | null
  pendingRun?: boolean
  workspacePath: string | null
  activeRunId: string | null
  headingRef?: Ref<HTMLHeadingElement>
  /** The task on screen, named as the navigator names it — the review's heading. */
  taskTitle?: string | null
  /** A failing PR check or a line in the review, handed to the task as an instruction. */
  onSend: (
    text: string,
    images?: string[],
    files?: import('@shared/ipc').AttachedFile[],
    extras?: import('@shared/ipc').ComposerSendExtras
  ) => boolean | void | Promise<boolean | void>
  onStop: () => void
  canUndoWrites?: boolean
  undoBusy?: boolean
  onUndoWrites?: () => void | Promise<unknown>
  writeFileResolutions?: ReadonlyMap<string, 'kept' | 'discarded' | undefined>
  writeResolvablePaths?: ReadonlySet<string>
  writeConflictedPaths?: ReadonlySet<string> | undefined
  writeCheckpointFiles?: ReadonlyArray<{
    path: string
    action: 'created' | 'modified' | 'deleted'
  }>
  onKeepWriteFile?: (path: string) => void | Promise<unknown>
  onDiscardWriteFile?: (path: string) => void | Promise<unknown>
  onKeepAllWrites?: () => void | Promise<unknown>
  resolveBlockedReason?: string | null
  multiPane?: {
    panes: ChatPane[]
    focusedPaneId: string
    sizes: number[]
    onFocusPane: (paneId: string) => void
    onClosePane: (paneId: string) => void
    onSizesChange: (sizes: number[]) => void
    onSessionDrop: (
      anchorPaneId: string,
      zone: PaneDropZone,
      payload: { workspacePath: string; runId: string }
    ) => boolean
    onSplitPane?: () => void
    getPaneTitle: (pane: ChatPane) => string
    renderPane: (pane: ChatPane, options: PaneRenderOptions) => React.ReactNode
  } | null
  /** Why the pane layout never arrived (the workspace list failed to load). */
  loadError?: string | null
  paneCount?: number
  onPaneCapacityChange?: (ctx: PaneCapacityContext) => void
  openChangesRequest?: number
  /** Which changes that request opens: the workspace's (default) or this task's. */
  openChangesScope?: 'agent' | 'uncommitted'
  /** One-shot consumption ack — the owner resets the request so a remount cannot replay it. */
  onOpenChangesRequestHandled?: () => void
}) {
  const paneCount = paneCountProp ?? multiPane?.panes.length ?? 1
  /**
   * The inspector's tab. It outlives a hide, so Ctrl I brings back the tab you
   * left; whether the inspector is on screen is its own switch.
   */
  const [inspectorTab, setInspectorTab] = useState<ChatRightPanelId>(() => {
    try {
      const raw = localStorage.getItem(RIGHT_PANEL_KEY)
      // Restore the last tab, but never land on Files (explorer + editor) at
      // startup — it opens only when asked for.
      if (isChatRightPanelId(raw) && raw !== 'files') return raw
    } catch {
      /* ignore */
    }
    return 'changes'
  })
  const [inspectorOpen, setInspectorOpen] = usePersistedBoolean(INSPECTOR_OPEN_KEY, true)
  const [inspectorExpandedPref, setInspectorExpanded] = usePersistedBoolean(
    INSPECTOR_EXPANDED_KEY,
    false
  )
  // A new task has no artifacts yet, so its brief has the work area to itself;
  // asking for the inspector (a tab, Ctrl I, Show inspector) brings it anyway,
  // and the saved open/closed choice is left as it was.
  const newTaskOnScreen = !activeRunId && items.length === 0 && !pendingRun && !running
  const [newTaskInspectorAsked, setNewTaskInspectorAsked] = useState(false)
  // Each new task starts unasked — tabs opened on the task before do not count.
  useEffect(() => {
    setNewTaskInspectorAsked(false)
  }, [newTaskOnScreen, workspacePath])
  const inspectorVisible = inspectorOpen && (!newTaskOnScreen || newTaskInspectorAsked)
  /** Expanded, the inspector is the whole work area and the record steps aside. */
  const inspectorExpanded = inspectorVisible && inspectorExpandedPref
  /** The panel on screen, if any. */
  const activeRightPanel: ChatRightPanelId | null = inspectorVisible ? inspectorTab : null
  /** Changes taken to the whole work area is the review, with a header of its own. */
  const reviewing = inspectorExpanded && inspectorTab === 'changes'
  const [requestedFilePath, setRequestedFilePath] =
    useState<WorkspaceFileOpenRequest | null>(null)
  const [pendingFilesRecovery, setPendingFilesRecovery] = useState<{
    workspacePath: string
    data: WorkspaceEditorRecoveryLoadResult
  } | null>(null)
  const handleFilesRecoveryConsumed = useCallback((consumedWorkspacePath: string): void => {
    setPendingFilesRecovery((pending) =>
      pending?.workspacePath === consumedWorkspacePath ? null : pending
    )
  }, [])
  useEffect(() => {
    setPendingFilesRecovery((pending) =>
      pending && pending.workspacePath !== workspacePath ? null : pending
    )
  }, [workspacePath])
  const clampDock = useCallback(
    (width: number) =>
      clampDockWidthPx(width, undefined, {
        paneCount,
        sidebarWidthPx: readSidebarWidthPxForCapacity()
      }),
    [paneCount]
  )
  const [prNumber, setPrNumber] = useState<number | null>(null)
  /** Visited panels stay mounted (hidden) when switching so PTY/browser state survives. */
  const [mountedPanels, setMountedPanels] = useState<ChatRightPanelId[]>(() =>
    activeRightPanel ? [activeRightPanel] : []
  )
  // The tab on screen is always mounted, even one that appeared without a
  // click: a task that loads after the first render turns the inspector on.
  const shownPanels =
    activeRightPanel && !mountedPanels.includes(activeRightPanel) ? [...mountedPanels, activeRightPanel] : mountedPanels
  useEffect(() => {
    if (!activeRightPanel) return
    setMountedPanels((prev) => (prev.includes(activeRightPanel) ? prev : [...prev, activeRightPanel]))
  }, [activeRightPanel])
  const [dockWidthPx, setDockWidthPx] = usePersistedNumber(
    DOCK_WIDTH_KEY,
    DOCK_WIDTH_DEFAULT_PX,
    clampDock
  )
  const dockMaxPx = clampDock(DOCK_WIDTH_MAX_PX)
  const inspectorRef = useRef<HTMLElement | null>(null)
  const [gitRevision, bumpGitRevision] = useGitRevision(
    workspacePath,
    running,
    items,
    itemsStore
  )
  /** Drives the Files panel's follow mode: the file the run is writing now. */
  const agentFileFocus = useAgentFileFocus(running, items, itemsStore)
  /** Drives the inspector tabs' live dots: what the run has in flight. */
  const liveActivity = useAgentLiveActivity(running, items, itemsStore)
  /** What this task edited and read — the Files tab marks them. */
  const agentFileMarks = useAgentFileMarks(items, itemsStore, workspacePath)
  const filesFlushRef = useRef<(() => Promise<boolean>) | null>(null)
  const registerFilesFlush = useCallback(
    (flush: (() => Promise<boolean>) | null): void => {
      filesFlushRef.current = flush
    },
    []
  )
  const flushDirtyFiles = useCallback(async (): Promise<boolean> => {
    return filesFlushRef.current ? filesFlushRef.current() : true
  }, [])
  useEffect(() => {
    const onFlushRequest = window.vyotiq?.onWorkspaceEditorFlushRequest
    const respond = window.vyotiq?.respondWorkspaceEditorFlush
    if (!onFlushRequest || !respond) return undefined
    return onFlushRequest((requestId) => {
      void flushDirtyFiles()
        .then((ok) => respond(requestId, ok))
        .catch(() => respond(requestId, false))
    })
  }, [flushDirtyFiles])
  // Fetch git chrome only while the Changes tab is on screen — never on mount.
  const changesDockVisible = activeRightPanel === 'changes'
  const gitChrome = useGitChrome(
    workspacePath,
    gitRevision,
    Boolean(workspacePath) && changesDockVisible,
    changesDockVisible ? 0 : undefined,
    flushDirtyFiles
  )
  const notifyGitMutated = useCallback(() => {
    gitChrome.refresh()
    bumpGitRevision()
  }, [gitChrome, bumpGitRevision])

  const keepWriteFile = useCallback(
    async (path: string) => {
      const ok = await onKeepWriteFile?.(path)
      if (ok !== false) notifyGitMutated()
    },
    [onKeepWriteFile, notifyGitMutated]
  )
  const discardWriteFile = useCallback(
    async (path: string) => {
      const ok = await onDiscardWriteFile?.(path)
      if (ok !== false) notifyGitMutated()
    },
    [onDiscardWriteFile, notifyGitMutated]
  )
  const keepAllWrites = useCallback(async () => {
    const ok = await onKeepAllWrites?.()
    if (ok !== false) notifyGitMutated()
  }, [onKeepAllWrites, notifyGitMutated])
  const { confirm, dialog: confirmDialog } = useConfirm()

  const discardAllWrites = useCallback(async () => {
    const files = writeCheckpointFiles ?? []
    const ok = await confirm(
      'Undo all agent edits? Every listed file is restored to its state before the agent ran. Files you edited yourself are untouched.',
      {
        title: 'Undo all agent edits',
        confirmLabel: 'Undo all',
        danger: true,
        ...(files.length > 0 ? { details: <ConfirmFileList files={files} /> } : {})
      }
    )
    if (!ok) return
    const okDone = await onUndoWrites?.()
    if (okDone !== false) {
      notifyGitMutated()
      pushToast('All agent edits were undone.', 'success')
    }
  }, [onUndoWrites, notifyGitMutated, confirm, writeCheckpointFiles])

  // Prefer the shared mutating-tool revision (same clock as composer chrome), not
  // a per-done-tool + fileCount formula that over-fetches and races the status cache.
  // The Changes tab opens on what this task changed; git's views are a select away.
  const [changesPreferredScope, setChangesPreferredScope] = useState<'agent' | 'uncommitted'>('agent')
  const [changesScopeToken, setChangesScopeToken] = useState(0)
  const [changesPreferredPath, setChangesPreferredPath] = useState<string | null>(null)

  /** Set when a hide takes focus with it; the instruction line gets it back. */
  const refocusAfterHideRef = useRef(false)
  const hideInspector = useCallback(() => {
    refocusAfterHideRef.current = inspectorRef.current?.contains(document.activeElement) ?? false
    setInspectorOpen(false)
    setInspectorExpanded(false)
  }, [setInspectorExpanded, setInspectorOpen])
  useEffect(() => {
    if (inspectorOpen || !refocusAfterHideRef.current) return
    refocusAfterHideRef.current = false
    focusComposerMessage()
  }, [inspectorOpen])

  const setRightPanel = useCallback(
    (next: ChatRightPanelId | null) => {
      if (next === null) {
        hideInspector()
        return
      }
      setInspectorTab(next)
      setInspectorOpen(true)
      setNewTaskInspectorAsked(true)
      setMountedPanels((prev) => (prev.includes(next) ? prev : [...prev, next]))
      try {
        localStorage.setItem(RIGHT_PANEL_KEY, next)
      } catch {
        /* ignore */
      }
    },
    [hideInspector, setInspectorOpen]
  )

  const openWorkspaceFile = useCallback(
    (
      path: string,
      options?: Pick<WorkspaceFileOpenRequest, 'line' | 'column' | 'mode'>
    ): void => {
      if (!workspacePath) return
      setRequestedFilePath({ workspacePath, path, ...options })
      setRightPanel('files')
    },
    [setRightPanel, workspacePath]
  )
  // A file asked for from outside this view (the palette) opens here once
  // this view is showing that workspace.
  const fileRequest = useWorkspaceFileRequest()
  useEffect(() => {
    if (!fileRequest || !workspacePath) return
    if (!workspacePathsEqual(fileRequest.workspacePath, workspacePath)) return
    consumeWorkspaceFileRequest(fileRequest.seq)
    openWorkspaceFile(fileRequest.path)
  }, [fileRequest, workspacePath, openWorkspaceFile])
  const handleWorkspaceFileOpened = useCallback((request: WorkspaceFileOpenRequest): void => {
    setRequestedFilePath((current) =>
      current &&
      current.workspacePath === request.workspacePath &&
      current.path === request.path
        ? null
        : current
    )
  }, [])

  const openChangesPanel = useCallback(
    (scope: 'agent' | 'uncommitted' = 'uncommitted', path?: string) => {
      setChangesPreferredScope(scope)
      setChangesScopeToken((n) => n + 1)
      setChangesPreferredPath(path ?? null)
      setRightPanel('changes')
    },
    [setRightPanel]
  )

  const onOpenAgentChanges = useCallback(
    (path?: string) => openChangesPanel('agent', path),
    [openChangesPanel]
  )

  const handledOpenChangesRequestRef = useRef(0)
  useEffect(() => {
    // The owner resets the counter to 0 after consuming; clear the handled mark
    // so a later request can reuse the same value (0 -> 1 -> 0 -> 1).
    if (openChangesRequest <= 0) {
      handledOpenChangesRequestRef.current = 0
      return
    }
    if (openChangesRequest === handledOpenChangesRequestRef.current) return
    handledOpenChangesRequestRef.current = openChangesRequest
    openChangesPanel(openChangesScope)
    // Reset the owner's counter: the ref resets on unmount, so without this a
    // later ChatView remount re-consumes the same request and force-opens Changes.
    onOpenChangesRequestHandled?.()
  }, [onOpenChangesRequestHandled, openChangesPanel, openChangesRequest, openChangesScope])

  const toggleRightPanel = useCallback(
    (panel: ChatRightPanelId) => {
      // The chord for the tab on screen hides the inspector; any other shows
      // the inspector on that tab.
      if (activeRightPanel === panel) {
        hideInspector()
        return
      }
      setRightPanel(panel)
    },
    [activeRightPanel, hideInspector, setRightPanel]
  )

  const toggleInspector = useCallback(() => {
    if (inspectorVisible) hideInspector()
    else setRightPanel(inspectorTab)
  }, [hideInspector, inspectorVisible, inspectorTab, setRightPanel])

  const toggleInspectorExpanded = useCallback(() => {
    if (inspectorExpanded) {
      setInspectorExpanded(false)
      return
    }
    setRightPanel(inspectorTab)
    setInspectorExpanded(true)
  }, [inspectorExpanded, inspectorTab, setInspectorExpanded, setRightPanel])

  // Expanding hides the record; focus that was in it moves to the tab strip
  // rather than falling to <body>.
  const wasExpandedRef = useRef(inspectorExpanded)
  useEffect(() => {
    const was = wasExpandedRef.current
    wasExpandedRef.current = inspectorExpanded
    if (!inspectorExpanded || was) return
    const root = inspectorRef.current
    if (!root || root.contains(document.activeElement)) return
    root.querySelector<HTMLElement>('[role="tab"][aria-selected="true"], [data-review-back]')?.focus()
  }, [inspectorExpanded])

  // Every entry point reads the same tables as the tab strip's titles, the
  // Shortcuts settings page and the command palette, so nothing advertises a
  // chord that nothing answers.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Ctrl Shift I reaches the page re-dispatched on window by the main
      // process; judge it by what has focus, like any other chord.
      if (shouldBlockPanelShortcut(e.target === window ? document.activeElement : e.target)) return
      if (matchShortcut(e, 'inspector')) {
        e.preventDefault()
        toggleInspector()
        return
      }
      if (matchShortcut(e, 'inspectorExpand')) {
        e.preventDefault()
        toggleInspectorExpanded()
        return
      }
      const tab = INSPECTOR_TAB_SHORTCUTS.findIndex((id) => matchShortcut(e, id))
      const tabId = tab >= 0 ? INSPECTOR_TABS[tab] : undefined
      if (tabId) {
        e.preventDefault()
        setRightPanel(tabId)
        return
      }
      for (const panel of CHAT_RIGHT_PANEL_IDS) {
        if (!matchShortcut(e, PANEL_SHORTCUT[panel])) continue
        e.preventDefault()
        toggleRightPanel(panel)
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setRightPanel, toggleInspector, toggleInspectorExpanded, toggleRightPanel])

  useEffect(() => {
    const onCommand = (event: Event): void => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id
      if (id === 'inspector') {
        toggleInspector()
        return
      }
      if (id === 'inspectorExpand') {
        toggleInspectorExpanded()
        return
      }
      const panel = CHAT_RIGHT_PANEL_IDS.find((p) => PANEL_SHORTCUT[p] === id)
      if (panel) toggleRightPanel(panel)
    }
    window.addEventListener('vyotiq:command', onCommand)
    return () => window.removeEventListener('vyotiq:command', onCommand)
  }, [toggleInspector, toggleInspectorExpanded, toggleRightPanel])

  // Ctrl Shift F / the palette: open Files with its find-in-files box.
  const [findInFilesNonce, setFindInFilesNonce] = useState(0)
  useEffect(() => {
    const onFindInFiles = (): void => {
      if (!workspacePath) return
      setRightPanel('files')
      setFindInFilesNonce((n) => n + 1)
    }
    window.addEventListener('vyotiq:find-in-files', onFindInFiles)
    return () => window.removeEventListener('vyotiq:find-in-files', onFindInFiles)
  }, [setRightPanel, workspacePath])

  useEffect(() => {
    onPaneCapacityChange?.({
      dockOpen: activeRightPanel != null,
      dockWidthPx: activeRightPanel != null ? dockWidthPx : 0
    })
  }, [activeRightPanel, dockWidthPx, onPaneCapacityChange])

  useEffect(() => {
    setDockWidthPx((w) => clampDock(w))
  }, [clampDock, setDockWidthPx])

  useEffect(() => {
    const onResize = (): void => {
      setDockWidthPx((w) => clampDock(w))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [clampDock, setDockWidthPx])

  useEffect(() => {
    setPrNumber(null)
  }, [workspacePath])

  const handlePrMeta = useCallback((meta: { number: number; title: string } | null) => {
    setPrNumber(meta?.number ?? null)
  }, [])

  // Prefetch recovery once so FilesPanel can hydrate from the same result when
  // it auto-opens, without issuing a second recovery load.
  //
  // Every load hands out a new session token and retires the previous one, so
  // a load whose result is thrown away still takes the lease. Keyed on
  // `mountedPanels`, this re-ran whenever any other tab was first visited; a
  // prefetch still in flight when Files opened then retired the token Files had
  // just been given, and every save and clear after it failed with "Recovery
  // session is stale". `filesShown` flips in the same render FilesPanel mounts,
  // so the timer is gone before Files loads, and any prefetch already sent
  // reaches main ahead of Files' own load and cannot outlive it.
  const filesShown = shownPanels.includes('files')
  useEffect(() => {
    if (
      !workspacePath ||
      filesShown ||
      !window.vyotiq?.workspaceEditorRecoveryLoad
    ) {
      return undefined
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void window.vyotiq?.workspaceEditorRecoveryLoad({ workspacePath }).then((result) => {
        if (cancelled || !result.ok) return
        setPendingFilesRecovery({ workspacePath, data: result.data })
      })
    }, 900)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [filesShown, workspacePath])

  // Live browser state for the watch affordances (banner + tab dot). The push
  // channel updates regardless of whether the browser dock is mounted.
  const [browserLive, setBrowserLive] = useState<AgentBrowserState | null>(null)
  useEffect(() => {
    let cancelled = false
    // Push events always win over a late browserGetState resolve — same guard
    // as AgentBrowserPanel: a stale closed-state resolve must not clobber a
    // push that already arrived.
    let pushSeq = 0
    let getStateSeq = 0
    void window.vyotiq.browserGetState?.().then((res) => {
      if (cancelled) return
      const seq = ++getStateSeq
      void Promise.resolve().then(() => {
        if (cancelled || seq !== getStateSeq || pushSeq > 0) return
        if (res?.ok) setBrowserLive(res.data)
      })
    })
    const unsub = window.vyotiq.onBrowserState?.((next) => {
      if (!cancelled) {
        pushSeq += 1
        getStateSeq += 1
        setBrowserLive(next)
      }
    })
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [])

  const filesRecoveryData =
    pendingFilesRecovery?.workspacePath === workspacePath
      ? pendingFilesRecovery.data
      : undefined

  const visiblePanelId = activeRightPanel

  const browserBusy = Boolean(browserLive?.open && browserLive?.agentBusy)
  const browserWatchUrl = useMemo(() => {
    const url = browserLive?.url?.trim() ?? ''
    if (!url || url === 'about:blank') return ''
    try {
      return new URL(url).host
    } catch {
      return ''
    }
  }, [browserLive?.url])
  const pendingChangeCount = writeCheckpointFiles?.length ?? 0

  /**
   * What each inspector tab says without being opened. A live dot means the
   * run is working there right now; a count means something there waits for
   * the reader. Every value is state this surface already holds, so an
   * unopened tab costs nothing — no panel mounts and no IPC is issued for it.
   */
  const inspectorState = useMemo<Partial<Record<ChatRightPanelId, InspectorTabState>>>(() => {
    const state: Partial<Record<ChatRightPanelId, InspectorTabState>> = {}
    if (pendingChangeCount > 0) {
      state.changes = {
        count: pendingChangeCount,
        detail: `${pendingChangeCount} ${pendingChangeCount === 1 ? 'file' : 'files'} to review`
      }
    }
    const writing = liveActivity.writingPath
    if (writing !== null) {
      // A call whose arguments are still streaming is doing work it cannot
      // name yet; the dot leads, the label catches up.
      const target = writing
        ? formatPathLabel(toWorkspaceRelPath(workspacePath, writing) ?? writing, INSPECTOR_DETAIL_MAX)
        : 'a file'
      state.files = { live: true, detail: `Editing ${target}` }
    }
    const command = liveActivity.command
    if (command !== null) {
      state.terminal = {
        live: true,
        detail: `Running ${command ? truncateMiddle(command, INSPECTOR_DETAIL_MAX) : 'a command'}`
      }
    }
    if (browserBusy) {
      state.browser = {
        live: true,
        detail: browserWatchUrl ? `Browsing ${browserWatchUrl}` : 'Agent is browsing'
      }
    }
    if (prNumber !== null) state.pr = { detail: `Pull request #${prNumber}` }
    if (liveActivity.planning) state.plan = { live: true, detail: 'Writing the plan' }
    return state
  }, [browserBusy, browserWatchUrl, liveActivity, pendingChangeCount, prNumber, workspacePath])

  // The Browser tab's dot says it while the inspector is up; with it hidden,
  // this row is the only sign the agent is driving a page.
  const browserWatchBanner =
    browserBusy && !inspectorVisible ? (
      <div
        className="flex h-8 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2 text-xs"
        data-browser-watch-banner
        role="status"
      >
        <span aria-hidden="true" className="size-1.5 shrink-0 animate-live rounded-full bg-accent" />
        <span className="min-w-0 flex-1 truncate text-muted">
          <span className="text-fg">Agent is browsing</span>
          {browserWatchUrl ? ` · ${browserWatchUrl}` : null}
        </span>
        <Button size="xs" variant="ghost" onClick={() => setRightPanel('browser')}>
          Watch live
        </Button>
      </div>
    ) : null

  /** With the inspector hidden, the rightmost pane's header offers it back. */
  const showInspector = useCallback(() => setRightPanel(inspectorTab), [inspectorTab, setRightPanel])
  const onShowInspector = inspectorVisible ? undefined : showInspector

  const renderMultiPane = useCallback(
    (pane: ChatPane, options: PaneRenderOptions) =>
      multiPane!.renderPane(pane, {
        ...options,
        onOpenChanges: onOpenAgentChanges,
        onOpenWorkspaceFile: openWorkspaceFile
      }),
    [multiPane, onOpenAgentChanges, openWorkspaceFile]
  )

  const agentColumn = (
    <>
      <h1 ref={headingRef} tabIndex={-1} className="sr-only">
        Tasks
      </h1>
      {multiPane && multiPane.panes.length >= 1 ? (
        <ChatPaneHost
          panes={multiPane.panes}
          focusedPaneId={multiPane.focusedPaneId}
          sizes={multiPane.sizes}
          onShowInspector={onShowInspector}
          onFocusPane={multiPane.onFocusPane}
          onClosePane={multiPane.onClosePane}
          onSizesChange={multiPane.onSizesChange}
          onSessionDrop={multiPane.onSessionDrop}
          onSplitPane={multiPane.onSplitPane}
          getPaneTitle={multiPane.getPaneTitle}
          renderPane={renderMultiPane}
        />
      ) : (
        <PanePlaceholder loadError={loadError} />
      )}
    </>
  )

  // A failing PR check becomes an instruction to the task, sent like any other.
  const handToAgent = useCallback(
    (instruction: string) => {
      void onSend(instruction)
    },
    [onSend]
  )

  // A panel that fails to render says so in its own space; opening another
  // task or workspace gives it a fresh start.
  const panelResetKey = `${workspacePath ?? ''}|${activeRunId ?? ''}`

  const panelBodies = (
    <>
      {shownPanels.includes('files') ? (
        <div
          id="dock-panel-files"
          role="tabpanel"
          aria-label="Files"
          className={cn(
            'min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
            visiblePanelId === 'files' ? 'flex' : 'hidden'
          )}
          aria-hidden={visiblePanelId !== 'files'}
          inert={visiblePanelId !== 'files' ? true : undefined}
        >
          <ErrorBoundary panel={INSPECTOR_TAB_LABEL.files} resetKey={panelResetKey}>
            <Suspense fallback={<DockPanelSuspenseFallback />}>
              <FilesPanel
                workspacePath={workspacePath}
                active={visiblePanelId === 'files'}
                gitRevision={gitRevision}
                onGitMutated={notifyGitMutated}
                onFlushReady={registerFilesFlush}
                openPath={requestedFilePath}
                agentFocus={agentFileFocus}
                onOpenPathHandled={handleWorkspaceFileOpened}
                recoveryData={filesRecoveryData}
                onRecoveryDataConsumed={handleFilesRecoveryConsumed}
                findInFilesNonce={findInFilesNonce}
                agentMarks={agentFileMarks}
              />
            </Suspense>
          </ErrorBoundary>
        </div>
      ) : null}
      {shownPanels.includes('browser') ? (
        <div
          id="dock-panel-browser"
          role="tabpanel"
          aria-label="Browser"
          className={cn(
            'min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
            visiblePanelId === 'browser' ? 'flex' : 'hidden'
          )}
          aria-hidden={visiblePanelId !== 'browser'}
          inert={visiblePanelId !== 'browser' ? true : undefined}
        >
          <ErrorBoundary panel={INSPECTOR_TAB_LABEL.browser} resetKey={panelResetKey}>
            <AgentBrowserPanel
              workspacePath={workspacePath}
              activeRunId={activeRunId}
              visible={visiblePanelId === 'browser'}
              agentAction={liveActivity.browsing}
              onPopOut={hideInspector}
            />
          </ErrorBoundary>
        </div>
      ) : null}
      {shownPanels.includes('terminal') ? (
        <div
          id="dock-panel-terminal"
          role="tabpanel"
          aria-label="Terminal"
          className={cn(
            'min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
            visiblePanelId === 'terminal' ? 'flex' : 'hidden'
          )}
          aria-hidden={visiblePanelId !== 'terminal'}
          inert={visiblePanelId !== 'terminal' ? true : undefined}
        >
          <ErrorBoundary panel={INSPECTOR_TAB_LABEL.terminal} resetKey={panelResetKey}>
            <Suspense fallback={<DockPanelSuspenseFallback />}>
              <TerminalPanel
                workspacePath={workspacePath}
                visible={visiblePanelId === 'terminal'}
                agentCommand={liveActivity.command}
                agentCommandAt={liveActivity.commandAt}
              />
            </Suspense>
          </ErrorBoundary>
        </div>
      ) : null}
      {shownPanels.includes('changes') ? (
        <div
          id="dock-panel-changes"
          // Reviewing, the panel is its own region; there is no tab to label it.
          role={reviewing ? undefined : 'tabpanel'}
          aria-label={reviewing ? undefined : 'Changes'}
          className={cn(
            'min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
            visiblePanelId === 'changes' ? 'flex' : 'hidden'
          )}
          aria-hidden={visiblePanelId !== 'changes'}
          inert={visiblePanelId !== 'changes' ? true : undefined}
        >
          <ErrorBoundary panel={INSPECTOR_TAB_LABEL.changes} resetKey={panelResetKey}>
            <ChangesPanel
              items={items}
              itemsStore={itemsStore}
              workspacePath={workspacePath}
              gitRevision={gitRevision}
              chrome={gitChrome}
              onGitMutated={notifyGitMutated}
              onOpenFile={openWorkspaceFile}
              onViewPr={() => setRightPanel('pr')}
              writeFileResolutions={writeFileResolutions}
              resolvablePaths={writeResolvablePaths}
              conflictedPaths={writeConflictedPaths}
              writeCheckpointFiles={writeCheckpointFiles}
              canResolve={canUndoWrites}
              resolveBusy={undoBusy}
              resolveBlockedReason={resolveBlockedReason}
              onKeepWriteFile={keepWriteFile}
              onDiscardWriteFile={discardWriteFile}
              onKeepAllWrites={keepAllWrites}
              onDiscardAllWrites={discardAllWrites}
              active={visiblePanelId === 'changes'}
              running={running}
              onStopRun={onStop}
              preferredScope={changesPreferredScope}
              preferredScopeToken={changesScopeToken}
              preferredSelectedPath={changesPreferredPath}
              preferredSelectedPathToken={changesScopeToken}
              runId={activeRunId}
              variant={reviewing ? 'review' : 'panel'}
              reviewTitle={taskTitle ?? 'Review'}
              onReviewBack={toggleInspectorExpanded}
              onAskAboutLine={handToAgent}
            />
          </ErrorBoundary>
        </div>
      ) : null}
      {shownPanels.includes('pr') ? (
        <div
          id="dock-panel-pr"
          role="tabpanel"
          aria-label="Pull request"
          className={cn(
            'min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
            visiblePanelId === 'pr' ? 'flex' : 'hidden'
          )}
          aria-hidden={visiblePanelId !== 'pr'}
          inert={visiblePanelId !== 'pr' ? true : undefined}
        >
          <ErrorBoundary panel={INSPECTOR_TAB_LABEL.pr} resetKey={panelResetKey}>
            <Suspense fallback={<DockPanelSuspenseFallback />}>
              <PrPanel
                workspacePath={workspacePath}
                gitRevision={gitRevision}
                onOpenFile={openWorkspaceFile}
                onPrMeta={handlePrMeta}
                onUnlink={hideInspector}
                onHandToAgent={handToAgent}
                active={visiblePanelId === 'pr'}
              />
            </Suspense>
          </ErrorBoundary>
        </div>
      ) : null}
      {shownPanels.includes('plan') ? (
        <div
          id="dock-panel-plan"
          role="tabpanel"
          aria-label="Plan"
          className={cn(
            'min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
            visiblePanelId === 'plan' ? 'flex' : 'hidden'
          )}
          aria-hidden={visiblePanelId !== 'plan'}
          inert={visiblePanelId !== 'plan' ? true : undefined}
        >
          <ErrorBoundary panel={INSPECTOR_TAB_LABEL.plan} resetKey={panelResetKey}>
            <PlanPanel
              workspacePath={workspacePath}
              runId={activeRunId}
              running={running}
              invokeId={invokeId}
              active={visiblePanelId === 'plan'}
              onOpenFile={openWorkspaceFile}
            />
          </ErrorBoundary>
        </div>
      ) : null}
    </>
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative flex min-h-0 min-w-0 flex-1" data-chat-surface>
        <div
          className={inspectorExpanded ? 'hidden' : 'flex min-h-0 min-w-0 flex-1 flex-col'}
          aria-hidden={inspectorExpanded || undefined}
          inert={inspectorExpanded ? true : undefined}
          data-agent-column
        >
          {browserWatchBanner}
          {agentColumn}
        </div>
        {inspectorVisible ? (
          <>
            {inspectorExpanded ? null : (
              <PanelResizeHandle
                label="Resize inspector"
                value={dockWidthPx}
                min={DOCK_WIDTH_MIN_PX}
                max={dockMaxPx}
                defaultValue={DOCK_WIDTH_DEFAULT_PX}
                edge="start"
                onChange={(next) => {
                  setDockWidthPx(next)
                }}
                // The inspector's border is the line; the handle lights it up.
                hairline
              />
            )}
            <Inspector
              sectionRef={inspectorRef}
              tab={inspectorTab}
              onSelect={setRightPanel}
              state={inspectorState}
              expanded={inspectorExpanded}
              onToggleExpanded={toggleInspectorExpanded}
              onHide={hideInspector}
              width={dockWidthPx}
              bare={reviewing}
            >
              {panelBodies}
            </Inspector>
          </>
        ) : null}
      </div>
      {confirmDialog}
    </div>
  )
}
