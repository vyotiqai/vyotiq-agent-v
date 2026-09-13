import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefCallback } from 'react'
import type { RunSummary } from '@shared/ipc'
import { Icon } from '@renderer/lib/icons'
import { Button, Tooltip, cn } from '@renderer/lib/ui'
import { useRovingTabIndex } from '@renderer/lib/a11y'
import {
  RUN_LIST_CAP,
  SIDEBAR_INDENT,
  SIDEBAR_PAD_X,
  SIDEBAR_ROW,
  SIDEBAR_ROW_HOVER,
  SIDEBAR_SECTION_LABEL,
  SIDEBAR_WORKSPACE_GROUP,
  SIDEBAR_WORKSPACE_ROW,
  SIDEBAR_WORKSPACE_ROW_ACTIVE,
  SIDEBAR_WORKSPACE_ROW_HOVER
} from '@renderer/lib/utils/layout'
import { workspacePathsEqual } from '@shared/workspacePathMatch'
import { ChatRow } from './ChatRow'
import { InlineConfirmActions } from './InlineConfirmActions'
import { runTitle, uniqueInstanceTitles } from './runTitle'
import type { WorkspaceSidebarGroup } from './types'

function instanceFoldKey(workspacePath: string, parentRunId: string): string {
  return `${workspacePath}:${parentRunId}`
}

/** Expand when a child is open/running or the parent chat is focused; otherwise stay folded. */
function shouldAutoExpandInstances(opts: {
  children: RunSummary[]
  openInstanceRunId: string | null | undefined
  parentFocused: boolean
}): boolean {
  const { children, openInstanceRunId, parentFocused } = opts
  if (children.length === 0) return false
  if (parentFocused) return true
  if (openInstanceRunId && children.some((c) => c.runId === openInstanceRunId)) return true
  return children.some((c) => c.status === 'running')
}

function FoldableInstanceChildren({
  workspacePath,
  parentRunId,
  parentTitle,
  childRuns,
  openInstanceRunId,
  expanded,
  onToggle,
  autoExpand,
  onClearManual,
  onSelectRun,
  onRenameRun,
  onDeleteRun,
  tabIndexFor,
  setOptionRef,
  navIndexOf,
  onNavKeyDown
}: {
  workspacePath: string
  parentRunId: string
  parentTitle: string
  childRuns: RunSummary[]
  openInstanceRunId: string | null | undefined
  expanded: boolean
  onToggle: () => void
  autoExpand: boolean
  onClearManual: () => void
  onSelectRun: (path: string, runId: string) => void
  onRenameRun: (path: string, runId: string, goal: string) => void
  onDeleteRun: (path: string, runId: string) => void
  tabIndexFor: (index: number) => number
  setOptionRef: (index: number) => RefCallback<HTMLElement>
  navIndexOf: (runId: string) => number
  onNavKeyDown: (event: KeyboardEvent<HTMLElement>) => void
}) {
  const prevAuto = useRef(autoExpand)

  useEffect(() => {
    if (prevAuto.current !== autoExpand) {
      onClearManual()
      prevAuto.current = autoExpand
    }
  }, [autoExpand, onClearManual])

  const titles = uniqueInstanceTitles(childRuns)
  const runningCount = childRuns.filter((c) => c.status === 'running').length
  const summary =
    runningCount > 0
      ? `${runningCount} running · ${childRuns.length} instances`
      : `${childRuns.length} instance${childRuns.length === 1 ? '' : 's'}`

  return (
    <div className="ml-2 flex flex-col gap-px border-l border-border/40 pl-1.5">
      <button
        type="button"
        className={cn(
          'app-region-no-drag flex w-full min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-left text-xs text-muted vy-transition',
          SIDEBAR_ROW_HOVER,
          'hover:text-fg'
        )}
        aria-expanded={expanded}
        aria-label={`${summary} — ${parentTitle}`}
        {...(expanded ? { 'aria-controls': `instance-children-${parentRunId}` } : {})}
        onClick={onToggle}
      >
        <Icon
          name={expanded ? 'chevron' : 'chevronRight'}
          size={11}
          className="shrink-0 opacity-80"
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate">{summary}</span>
      </button>
      {expanded ? (
        <div
          id={`instance-children-${parentRunId}`}
          className="flex flex-col gap-px"
          role="group"
          aria-label={`Instances of ${parentTitle}`}
        >
          {childRuns.map((child) => {
            const childSelected = openInstanceRunId === child.runId
            const navIndex = navIndexOf(child.runId)
            return (
              <ChatRow
                key={`${workspacePath}:${child.runId}`}
                run={child}
                workspacePath={workspacePath}
                active={childSelected}
                focused={childSelected}
                nested
                titleOverride={titles.get(child.runId)}
                onSelectRun={onSelectRun}
                onRenameRun={onRenameRun}
                onDeleteRun={onDeleteRun}
                tabIndex={navIndex >= 0 ? tabIndexFor(navIndex) : undefined}
                rowRef={navIndex >= 0 ? setOptionRef(navIndex) : undefined}
                onNavKeyDown={onNavKeyDown}
              />
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function WorkspaceHeader({
  name,
  path,
  active,
  expanded,
  hasActivity,
  onToggle,
  onSelectWorkspace,
  onNewChat,
  onCloseWorkspace
}: {
  name: string
  path: string
  active: boolean
  expanded: boolean
  hasActivity: boolean
  onToggle: () => void
  onSelectWorkspace: () => void
  onNewChat?: () => void
  onCloseWorkspace: () => void
}) {
  const [confirmingClose, setConfirmingClose] = useState(false)

  const closeConfirmLabel = hasActivity
    ? `Stop active runs and close ${name}`
    : `Confirm close ${name}`

  return (
    <div
      className={cn(
        'group flex items-center gap-1',
        SIDEBAR_WORKSPACE_ROW,
        active
          ? SIDEBAR_WORKSPACE_ROW_ACTIVE
          : cn('text-muted', SIDEBAR_WORKSPACE_ROW_HOVER)
      )}
    >
      <button
        type="button"
        className="app-region-no-drag inline-grid size-6 shrink-0 place-items-center rounded-md vy-transition hover:bg-surface/50"
        aria-label={expanded ? `Collapse ${name}` : `Expand ${name}`}
        aria-expanded={expanded}
        onClick={(e) => {
          e.stopPropagation()
          onToggle()
        }}
      >
        <span className="relative inline-flex size-4 items-center justify-center">
          <Icon
            name="folder"
            size={13}
            className="absolute opacity-80 group-hover:opacity-0 vy-transition"
            aria-hidden="true"
          />
          <Icon
            name={expanded ? 'chevron' : 'chevronRight'}
            size={13}
            className="absolute opacity-0 group-hover:opacity-100 vy-transition"
            aria-hidden="true"
          />
        </span>
      </button>
      <Tooltip content={path}>
        <button
          type="button"
          className="app-region-no-drag flex min-w-0 flex-1 items-center gap-1 text-left"
          onClick={onSelectWorkspace}
        >
          <span className="truncate font-medium">{name}</span>
        </button>
      </Tooltip>
      {onNewChat ? (
        <Tooltip content={`New chat in ${name}`}>
          <button
            type="button"
            className="app-region-no-drag inline-grid size-6 place-items-center rounded-md text-muted opacity-0 vy-transition hover:bg-surface/70 hover:text-fg group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
            aria-label={`New chat in ${name}`}
            onClick={(e) => {
              e.stopPropagation()
              onNewChat()
            }}
          >
            <Icon name="plus" size={12} />
          </button>
        </Tooltip>
      ) : null}
      {confirmingClose ? (
        <div className="app-region-no-drag">
          <InlineConfirmActions
            size="sm"
            confirmLabel={closeConfirmLabel}
            cancelLabel={`Cancel close ${name}`}
            onConfirm={() => {
              setConfirmingClose(false)
              onCloseWorkspace()
            }}
            onCancel={() => setConfirmingClose(false)}
          />
        </div>
      ) : (
        <Tooltip content={`Close ${name}`}>
          <button
            type="button"
            className="app-region-no-drag inline-grid size-6 place-items-center rounded-md text-muted opacity-0 vy-transition hover:bg-surface/70 hover:text-danger group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
            aria-label={`Close ${name}`}
            onClick={(e) => {
              e.stopPropagation()
              setConfirmingClose(true)
            }}
          >
            <Icon name="close" size={12} />
          </button>
        </Tooltip>
      )}
    </div>
  )
}

export function ChatList({
  workspaceReady,
  sessionQuery,
  filteredRunsCount,
  workspaceGroups,
  onToggleWorkspace,
  onSwitchWorkspace,
  onCloseWorkspace,
  onAddWorkspace,
  onNewChatInWorkspace,
  activeRuns,
  workspaceHasBackgroundRun,
  onDismissRunsError,
  onSelectRun,
  onRenameRun,
  onDeleteRun,
  onExportRun,
  onLoadOlderRuns,
  isRunOpenInPane,
  isRunFocusedInPane,
  openInstanceRunId = null,
  hideSessionRuns = false
}: {
  workspaceReady: boolean
  sessionQuery: string
  filteredRunsCount: number
  workspaceGroups: WorkspaceSidebarGroup[]
  onToggleWorkspace: (path: string) => void
  onSwitchWorkspace: (path: string) => void
  onCloseWorkspace: (path: string) => void
  onAddWorkspace: () => void
  onNewChatInWorkspace?: (path: string) => void
  activeRuns: { runId: string; workspacePath: string }[]
  workspaceHasBackgroundRun: (path: string) => boolean
  onDismissRunsError?: (path?: string) => void
  onSelectRun: (path: string, runId: string) => void
  onRenameRun: (path: string, runId: string, goal: string) => void
  onDeleteRun: (path: string, runId: string) => void
  onExportRun?: (path: string, runId: string) => void
  onLoadOlderRuns?: (path: string) => void
  isRunOpenInPane?: (path: string, runId: string) => boolean
  isRunFocusedInPane?: (path: string, runId: string) => boolean
  /** Currently viewed inline instance sub-session (sidebar highlight). */
  openInstanceRunId?: string | null
  /** Immersive dock: keep workspace chrome, hide chat rows (tabs own selection). */
  hideSessionRuns?: boolean
}) {
  const [instanceManualExpand, setInstanceManualExpand] = useState<Record<string, boolean>>({})
  const [navIndex, setNavIndex] = useState(0)

  const sessionRows = useMemo(() => {
    const rows: { workspacePath: string; runId: string }[] = []
    if (hideSessionRuns) return rows
    for (const workspace of workspaceGroups) {
      if (!workspace.expanded) continue
      for (const group of workspace.groupedRuns) {
        for (const run of group.runs) {
          rows.push({ workspacePath: workspace.path, runId: run.runId })
          const children = workspace.instanceRuns.filter((child) => child.parentRunId === run.runId)
          if (children.length === 0) continue
          const parentFocused =
            openInstanceRunId == null &&
            (isRunFocusedInPane?.(workspace.path, run.runId) ??
              workspace.activeRunId === run.runId)
          const autoExpand = shouldAutoExpandInstances({
            children,
            openInstanceRunId,
            parentFocused
          })
          const key = instanceFoldKey(workspace.path, run.runId)
          const expanded = instanceManualExpand[key] ?? autoExpand
          if (!expanded) continue
          for (const child of children) {
            rows.push({ workspacePath: workspace.path, runId: child.runId })
          }
        }
      }
    }
    return rows
  }, [
    hideSessionRuns,
    workspaceGroups,
    openInstanceRunId,
    isRunFocusedInPane,
    instanceManualExpand
  ])

  const focusedNavIndex = sessionRows.findIndex((row) => {
    if (openInstanceRunId) return row.runId === openInstanceRunId
    return isRunFocusedInPane?.(row.workspacePath, row.runId) ?? false
  })

  useEffect(() => {
    if (focusedNavIndex >= 0) setNavIndex(focusedNavIndex)
  }, [focusedNavIndex])

  const { tabIndexFor, setOptionRef, onContainerKeyDown } = useRovingTabIndex({
    count: sessionRows.length,
    activeIndex: navIndex,
    onActiveIndexChange: setNavIndex,
    orientation: 'vertical'
  })

  /** O(1) nav lookups — sessionRows scans were quadratic per keystroke/render. */
  const navIndexByKey = useMemo(() => {
    const map = new Map<string, number>()
    sessionRows.forEach((row, index) => {
      map.set(`${row.workspacePath}\u0000${row.runId}`, index)
    })
    return map
  }, [sessionRows])

  const navIndexOf = (workspacePath: string, runId: string): number =>
    navIndexByKey.get(`${workspacePath}\u0000${runId}`) ?? -1

  return (
    <div
      className={cn(SIDEBAR_PAD_X, 'py-2')}
      role="region"
      aria-label="Workspace sessions"
    >
      {!workspaceReady ? (
        <div className="flex flex-col items-center gap-2 px-2 py-6 text-center">
          <p className="m-0 text-sm text-muted">Open a workspace to see chats</p>
          <Button
            variant="subtle"
            className="min-h-8 px-3 text-xs"
            onClick={onAddWorkspace}
          >
            Open workspace
          </Button>
        </div>
      ) : (
        <>
          <div className="mb-2 flex items-center justify-between gap-2 px-1">
            <p className={SIDEBAR_SECTION_LABEL}>Workspaces</p>
            <Tooltip content="Add workspace">
              <button
                type="button"
                className="app-region-no-drag inline-grid size-7 place-items-center rounded-md text-muted vy-transition hover:bg-surface/50 hover:text-fg"
                aria-label="Add workspace"
                onClick={onAddWorkspace}
              >
                <Icon name="folderPlus" size={14} />
              </button>
            </Tooltip>
          </div>

          {filteredRunsCount === 0 && sessionQuery.trim() && !hideSessionRuns ? (
            <p className="m-0 py-4 text-center text-sm text-muted">
              No matching chats
            </p>
          ) : null}

          <div className="flex flex-col gap-2 pb-1">
            {workspaceGroups.map((workspace) => {
              const searchActive = Boolean(sessionQuery.trim())
              const globalSearchEmpty = searchActive && filteredRunsCount === 0

              return (
              <div key={workspace.path} className={SIDEBAR_WORKSPACE_GROUP}>
                <WorkspaceHeader
                  name={workspace.label}
                  path={workspace.path}
                  active={workspace.isActiveWorkspace}
                  expanded={workspace.expanded}
                  hasActivity={
                    workspaceHasBackgroundRun(workspace.path) ||
                    activeRuns.some((r) => workspacePathsEqual(r.workspacePath, workspace.path))
                  }
                  onToggle={() => onToggleWorkspace(workspace.path)}
                  onSelectWorkspace={() => onSwitchWorkspace(workspace.path)}
                  onNewChat={
                    onNewChatInWorkspace
                      ? () => onNewChatInWorkspace(workspace.path)
                      : undefined
                  }
                  onCloseWorkspace={() => onCloseWorkspace(workspace.path)}
                />

                {workspace.runsError ? (
                  <div
                    className={cn(
                      SIDEBAR_INDENT,
                      'mr-1 flex items-start gap-2 rounded-md border border-danger/20 bg-danger/5 px-2 py-1.5'
                    )}
                    role="alert"
                  >
                    <p className="m-0 min-w-0 flex-1 text-xs text-danger">{workspace.runsError}</p>
                    {onDismissRunsError ? (
                      <button
                        type="button"
                        className="shrink-0 text-xs text-muted vy-transition hover:text-fg"
                        onClick={() => onDismissRunsError(workspace.path)}
                      >
                        Dismiss
                      </button>
                    ) : null}
                  </div>
                ) : null}

                {workspace.expanded && !hideSessionRuns ? (
                  workspace.runsLoaded === false && !workspace.runsError ? (
                    <div className={cn(SIDEBAR_INDENT, 'flex flex-col gap-1 py-1')} aria-busy="true" role="status">
                      <span className="sr-only">Loading chats…</span>
                      {[0, 1, 2].map((i) => (
                        <div
                          key={i}
                          className={cn(SIDEBAR_ROW, 'h-7 animate-pulse bg-surface')}
                          style={{ width: `${82 - i * 14}%` }}
                        />
                      ))}
                    </div>
                  ) : workspace.filteredRuns.length === 0 ? (
                    globalSearchEmpty ? null : (
                      <p className={cn(SIDEBAR_INDENT, 'py-1 text-xs text-secondary')}>
                        {searchActive ? 'No matching chats' : 'No chats yet'}
                      </p>
                    )
                  ) : workspace.filteredRuns.length > 0 ? (
                    <div className={cn(SIDEBAR_INDENT, 'flex flex-col gap-2')}>
                      {workspace.groupedRuns.map((group) => (
                        <div key={`${workspace.path}:${group.id}`}>
                          {(workspace.groupedRuns.length > 1 || group.label === 'Results') && (
                            <div className="flex items-center gap-2 px-1 py-1">
                              <p className={cn(SIDEBAR_SECTION_LABEL, 'shrink-0')}>
                                {group.label}
                              </p>
                              <div className="h-px min-w-0 flex-1 bg-border/40" aria-hidden />
                            </div>
                          )}
                          <div className="flex flex-col gap-px" role="list">
                            {group.runs.map((run) => {
                              const children = workspace.instanceRuns.filter(
                                (child) => child.parentRunId === run.runId
                              )
                              const parentOpen =
                                isRunOpenInPane?.(workspace.path, run.runId) ??
                                workspace.activeRunId === run.runId
                              const parentFocused =
                                openInstanceRunId == null &&
                                (isRunFocusedInPane?.(workspace.path, run.runId) ??
                                  workspace.activeRunId === run.runId)
                              const autoExpand = shouldAutoExpandInstances({
                                children,
                                openInstanceRunId,
                                parentFocused
                              })
                              const foldKey = instanceFoldKey(workspace.path, run.runId)
                              const instancesExpanded = instanceManualExpand[foldKey] ?? autoExpand
                              const parentNavIndex = navIndexOf(workspace.path, run.runId)
                              return (
                                <div key={`${workspace.path}:${run.runId}`} className="flex flex-col gap-px">
                                  <ChatRow
                                    run={run}
                                    workspacePath={workspace.path}
                                    active={parentOpen}
                                    focused={parentFocused}
                                    onSelectRun={onSelectRun}
                                    onRenameRun={onRenameRun}
                                    onDeleteRun={onDeleteRun}
                                    onExportRun={onExportRun}
                                    tabIndex={
                                      parentNavIndex >= 0 ? tabIndexFor(parentNavIndex) : undefined
                                    }
                                    rowRef={
                                      parentNavIndex >= 0 ? setOptionRef(parentNavIndex) : undefined
                                    }
                                    onNavKeyDown={onContainerKeyDown}
                                  />
                                  {children.length > 0 ? (
                                    <FoldableInstanceChildren
                                      workspacePath={workspace.path}
                                      parentRunId={run.runId}
                                      parentTitle={runTitle(run)}
                                      childRuns={children}
                                      openInstanceRunId={openInstanceRunId}
                                      expanded={instancesExpanded}
                                      autoExpand={autoExpand}
                                      onToggle={() =>
                                        setInstanceManualExpand((prev) => ({
                                          ...prev,
                                          [foldKey]: !instancesExpanded
                                        }))
                                      }
                                      onClearManual={() =>
                                        setInstanceManualExpand((prev) => {
                                          if (!(foldKey in prev)) return prev
                                          const next = { ...prev }
                                          delete next[foldKey]
                                          return next
                                        })
                                      }
                                      onSelectRun={onSelectRun}
                                      onRenameRun={onRenameRun}
                                      onDeleteRun={onDeleteRun}
                                      tabIndexFor={tabIndexFor}
                                      setOptionRef={setOptionRef}
                                      navIndexOf={(runId) => navIndexOf(workspace.path, runId)}
                                      onNavKeyDown={onContainerKeyDown}
                                    />
                                  ) : null}
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      ))}
                      {workspace.runsCapped && !searchActive ? (
                        onLoadOlderRuns ? (
                          <button
                            type="button"
                            className="app-region-no-drag w-full rounded-md px-1.5 py-1 text-left text-caption text-muted vy-transition hover:bg-surface-hover hover:text-fg"
                            onClick={() => onLoadOlderRuns(workspace.path)}
                          >
                            Show older chats
                          </button>
                        ) : (
                          <p className="px-1 py-1.5 text-caption text-muted">
                            Showing {RUN_LIST_CAP} most recent
                          </p>
                        )
                      ) : null}
                    </div>
                  ) : null
                ) : null}
              </div>
            )})}
          </div>
        </>
      )}
    </div>
  )
}
