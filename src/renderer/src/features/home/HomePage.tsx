import { useEffect, useMemo, useRef, useState } from 'react'
import type { RunSummary } from '@shared/ipc'
import { Icon } from '@renderer/lib/icons'
import { ActionMenu, AlertBlock, Button, IconButton, PageHeader, cn } from '@renderer/lib/ui'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import { groupRunsByRecency } from '@renderer/lib/utils/groupRunsByRecency'
import { runTitle } from '@renderer/app/sidebar/runTitle'
import { InlineConfirmActions } from '@renderer/app/sidebar/InlineConfirmActions'
import type { WorkspaceSidebarRuns } from '@renderer/app/sidebar/types'
import { filterRecentEntries } from './sessionFilter'
import { pinnedRunKey } from './pinnedRuns'
import { useRunStats } from './useRunStats'
import { useWorkspaceGitSummaries, type WorkspaceGitSummary } from './useWorkspaceGitSummaries'
import {
  attentionHomeEntries,
  flattenHomeEntries,
  homeEntryKey,
  runningHomeEntries,
  stateOfHomeEntry,
  type HomeEntry,
  type HomeEntryState
} from './homeEntries'

const RECENT_RUN_CAP = 24
const SECTION_LABEL = 'text-xs font-medium uppercase tracking-wider text-muted'

function relativeAge(iso: string | undefined, now = new Date()): string | null {
  if (!iso) return null
  const ms = now.getTime() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function statePresentation(state: HomeEntryState): {
  icon: 'loader' | 'close' | 'warning' | 'check'
  label: string
  className: string
} {
  if (state === 'running') return { icon: 'loader', label: 'Running', className: 'text-fg' }
  if (state === 'failed') return { icon: 'close', label: 'Failed', className: 'text-danger' }
  if (state === 'interrupted') {
    return { icon: 'warning', label: 'Interrupted', className: 'text-warning' }
  }
  if (state === 'unverified') {
    return { icon: 'warning', label: 'Needs review', className: 'text-warning' }
  }
  return { icon: 'check', label: 'Completed', className: 'text-muted' }
}

function SessionRow({
  entry,
  state,
  pinned,
  showWorkspace,
  active,
  focused,
  stopping,
  onOpen,
  onStop,
  onReviewChanges,
  onTogglePinned,
  onRename,
  onDelete,
  onExport
}: {
  entry: HomeEntry
  state: HomeEntryState
  pinned: boolean
  showWorkspace: boolean
  active: boolean
  focused: boolean
  stopping: boolean
  onOpen: () => void
  onStop?: () => void
  onReviewChanges?: () => void
  onTogglePinned: () => void
  onRename?: (goal: string) => void
  onDelete?: () => void
  onExport?: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [draft, setDraft] = useState(entry.run.goal ?? '')
  const renameInputRef = useRef<HTMLInputElement>(null)
  const title = runTitle(entry.run)
  const presentation = statePresentation(state)
  const age = relativeAge(entry.run.updatedAt)

  useEffect(() => {
    if (!renaming) return
    const timer = window.setTimeout(() => renameInputRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [renaming])

  const commitRename = (): void => {
    const goal = draft.trim()
    setRenaming(false)
    if (goal && goal !== (entry.run.goal ?? '').trim()) onRename?.(goal)
  }

  return (
    <div
      role="listitem"
      className={cn(
        'group grid min-w-0 gap-3 border-b border-border/35 px-3 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center',
        focused ? 'bg-surface-2' : active ? 'bg-surface/70' : 'hover:bg-surface/45'
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        {state !== 'done' ? (
          <span className={cn('mt-0.5 inline-flex size-5 shrink-0 items-center justify-center', presentation.className)}>
            <Icon
              name={presentation.icon}
              size={14}
              className={state === 'running' ? 'animate-spin' : undefined}
              aria-hidden="true"
            />
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          {renaming ? (
            <input
              ref={renameInputRef}
              type="text"
              aria-label={`Rename ${title}`}
              value={draft}
              data-vy-text-entry
              className="w-full rounded-md border border-border bg-surface px-2 py-1 text-sm text-fg outline-none focus-visible:vy-focus-ring"
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commitRename}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitRename()
                if (event.key === 'Escape') {
                  setDraft(entry.run.goal ?? '')
                  setRenaming(false)
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="block max-w-full truncate text-left text-sm font-medium text-fg hover:underline focus-visible:vy-focus-ring"
              title={title}
              aria-label={`Open ${title}${state !== 'done' ? `, ${presentation.label}` : ''}${showWorkspace ? `, ${formatWorkspaceName(entry.workspacePath)}` : ''}`}
              onClick={onOpen}
            >
              {title}
            </button>
          )}
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            {state !== 'done' ? <span className={presentation.className}>{presentation.label}</span> : null}
            {showWorkspace ? <span className="truncate">{formatWorkspaceName(entry.workspacePath)}</span> : null}
            {age ? <span>{age}</span> : null}
            {pinned ? (
              <span className="inline-flex items-center gap-1 text-warning">
                <Icon name="star" size={11} aria-hidden="true" /> Pinned
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 sm:pl-0">
        {confirmingDelete && onDelete ? (
          <InlineConfirmActions
            confirmLabel={`Confirm delete ${title}`}
            cancelLabel={`Cancel delete ${title}`}
            onConfirm={() => {
              setConfirmingDelete(false)
              onDelete()
            }}
            onCancel={() => setConfirmingDelete(false)}
          />
        ) : null}
        {!confirmingDelete && onStop ? (
          <Button
            variant="danger"
            className="min-h-8 px-2 text-xs"
            pending={stopping}
            onClick={onStop}
          >
            Stop
          </Button>
        ) : null}
        {!confirmingDelete ? <ActionMenu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          placement="down"
          align="end"
          aria-label={`Actions for ${title}`}
          items={[
            {
              id: 'pin',
              label: pinned ? 'Unpin' : 'Pin',
              icon: 'star',
              onSelect: onTogglePinned
            },
            ...(onRename
              ? [{ id: 'rename', label: 'Rename', icon: 'edit' as const, onSelect: () => setRenaming(true) }]
              : []),
            ...(onReviewChanges
              ? [{ id: 'review', label: 'Review changes', icon: 'doc' as const, onSelect: onReviewChanges }]
              : []),
            ...(onExport
              ? [{ id: 'export', label: 'Export', icon: 'download' as const, onSelect: onExport }]
              : []),
            ...(onDelete
              ? [{ id: 'delete', label: 'Delete', icon: 'trash' as const, onSelect: () => setConfirmingDelete(true) }]
              : [])
          ]}
          trigger={(props) => (
            <IconButton
              ref={props.ref}
              icon="menu"
              label={`More actions for ${title}`}
              size="sm"
              variant="bare"
              aria-expanded={props['aria-expanded']}
              aria-controls={props['aria-controls']}
              aria-haspopup={props['aria-haspopup']}
              onClick={props.onClick}
            />
          )}
        /> : null}
      </div>
    </div>
  )
}

function WorkspaceRow({
  path,
  sessionCount,
  running,
  summary,
  loading,
  error,
  lastActivityAt,
  onOpen,
  onNewChat,
  onReviewChanges,
  onRevealFile,
  onRefresh
}: {
  path: string
  sessionCount: number
  running: boolean
  summary?: WorkspaceGitSummary
  loading: boolean
  error?: string
  lastActivityAt?: string
  onOpen: () => void
  onNewChat: () => void
  onReviewChanges?: () => void
  onRevealFile: (path: string) => void
  onRefresh: () => void
}) {
  const name = formatWorkspaceName(path)
  const age = relativeAge(lastActivityAt)
  const repositoryState = error
    ? 'Repository status unavailable'
    : loading && !summary
      ? 'Checking repository…'
      : summary
        ? summary.changedFiles > 0
          ? `${summary.changedFiles} changed`
          : 'Clean'
        : 'Not a repository'

  return (
    <div role="listitem" className="grid min-w-0 gap-3 border-b border-border/35 px-3 py-4 last:border-b-0 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
      <div className="flex min-w-0 items-start gap-3">
        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-surface text-muted">
          <Icon name="folder" size={15} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <button
            type="button"
            className="block max-w-full truncate text-left text-sm font-medium text-fg hover:underline focus-visible:vy-focus-ring"
            title={path}
            onClick={onOpen}
          >
            {name}
          </button>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            {running ? <span className="text-fg">Running</span> : null}
            <span>{sessionCount} {sessionCount === 1 ? 'session' : 'sessions'}</span>
            {summary?.branch ? <span>{summary.branch}</span> : null}
            <span className={error ? 'text-danger' : summary?.changedFiles ? 'text-warning' : undefined}>
              {repositoryState}
            </span>
            {summary?.ahead != null && summary.behind != null ? (
              <span>↑{summary.ahead} ↓{summary.behind}</span>
            ) : null}
            {age ? <span>{age}</span> : null}
          </div>
          {summary?.topFiles?.length ? (
            <div className="mt-2 flex min-w-0 flex-wrap gap-x-3 gap-y-1">
              {summary.topFiles.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  className="max-w-full truncate text-left text-[11px] text-muted hover:text-fg hover:underline focus-visible:vy-focus-ring"
                  title={`Reveal ${file.path}, ${file.lines} changed lines`}
                  onClick={() => onRevealFile(file.path)}
                >
                  {file.path}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 pl-11 lg:pl-0">
        {error ? (
          <Button variant="ghost" className="min-h-8 px-2 text-xs" onClick={onRefresh}>
            Retry status
          </Button>
        ) : null}
        {onReviewChanges && (summary?.changedFiles ?? 0) > 0 ? (
          <Button variant="ghost" className="min-h-8 px-2 text-xs" onClick={onReviewChanges}>
            Review changes
          </Button>
        ) : null}
        <Button variant="subtle" className="min-h-8 px-2 text-xs" onClick={onNewChat}>
          <Icon name="plus" size={12} aria-hidden="true" /> New chat
        </Button>
      </div>
    </div>
  )
}

export function HomePage({
  openWorkspaces,
  runsByWorkspacePath,
  activeRuns,
  workspaceHasBackgroundRun,
  onNewSessionInWorkspace,
  onSelectRunInWorkspace,
  onSwitchWorkspace,
  onAddWorkspace,
  onRenameRunInWorkspace,
  onDeleteRunInWorkspace,
  onExportRunInWorkspace,
  onStopRunInWorkspace,
  onReviewChangesInWorkspace,
  onRefreshWorkspaceRuns,
  isRunOpenInPane,
  isRunFocusedInPane,
  pinnedRunKeys,
  onTogglePinnedRun,
  refreshVersion = 0
}: {
  openWorkspaces: string[]
  runsByWorkspacePath: Record<string, WorkspaceSidebarRuns>
  activeRuns?: { runId: string; workspacePath: string }[]
  workspaceHasBackgroundRun?: (path: string) => boolean
  onNewSessionInWorkspace: (path: string, goal: string) => void
  onSelectRunInWorkspace: (path: string, runId: string) => void
  onSwitchWorkspace: (path: string) => void
  onAddWorkspace: () => void
  onRenameRunInWorkspace?: (path: string, runId: string, goal: string) => void
  onDeleteRunInWorkspace?: (path: string, runId: string) => void
  onExportRunInWorkspace?: (path: string, runId: string) => void
  onStopRunInWorkspace?: (path: string, runId: string) => Promise<void> | void
  onReviewChangesInWorkspace?: (path: string, runId?: string) => void
  onRefreshWorkspaceRuns?: (path: string) => Promise<void> | void
  isRunOpenInPane?: (path: string, runId: string) => boolean
  isRunFocusedInPane?: (path: string, runId: string) => boolean
  pinnedRunKeys: string[]
  onTogglePinnedRun: (key: string) => void
  refreshVersion?: number
}) {
  const [query, setQuery] = useState('')
  const [stoppingKeys, setStoppingKeys] = useState<Set<string>>(new Set())
  const [reviewFilter, setReviewFilter] = useState<'all' | 'attention'>('all')
  const [refreshing, setRefreshing] = useState(false)
  const [statusMessage, setStatusMessage] = useState('')
  const hasWorkspaces = openWorkspaces.length > 0
  const entries = useMemo(
    () => flattenHomeEntries(openWorkspaces, runsByWorkspacePath),
    [openWorkspaces, runsByWorkspacePath]
  )
  const activeKeys = useMemo(
    () => new Set((activeRuns ?? []).map((run) => pinnedRunKey(run.workspacePath, run.runId))),
    [activeRuns]
  )
  const stats = useRunStats(openWorkspaces, runsByWorkspacePath, refreshVersion)
  const git = useWorkspaceGitSummaries(openWorkspaces, hasWorkspaces, refreshVersion)
  const attentionEntries = useMemo(
    () => attentionHomeEntries(entries, stats.data, activeKeys),
    [activeKeys, entries, stats.data]
  )
  const runningEntries = useMemo(
    () => runningHomeEntries(entries, activeKeys),
    [activeKeys, entries]
  )
  const runningKeys = useMemo(() => new Set(runningEntries.map(homeEntryKey)), [runningEntries])
  const sessionEntries = useMemo(
    () => entries.filter((entry) => !runningKeys.has(homeEntryKey(entry))),
    [entries, runningKeys]
  )
  const attentionKeys = useMemo(
    () => new Set(attentionEntries.map(homeEntryKey)),
    [attentionEntries]
  )
  const filteredRecent = useMemo(() => {
    const searched = filterRecentEntries(sessionEntries, query)
    const scoped = reviewFilter === 'attention'
      ? searched.filter((entry) => attentionKeys.has(homeEntryKey(entry)))
      : searched
    return scoped.slice(0, RECENT_RUN_CAP)
  }, [attentionKeys, query, reviewFilter, sessionEntries])
  const recentGroups = useMemo(() => {
    const groups = groupRunsByRecency(filteredRecent.map((entry) => entry.run))
    return groups.map((group) => ({
      ...group,
      entries: group.runs
        .map((run) => filteredRecent.find((entry) => entry.run === run))
        .filter((entry): entry is HomeEntry => Boolean(entry))
    }))
  }, [filteredRecent])
  const lastActivityByPath = useMemo(() => {
    const result: Record<string, string | undefined> = {}
    for (const path of openWorkspaces) {
      result[path] = runsByWorkspacePath[path]?.runs[0]?.updatedAt
    }
    return result
  }, [openWorkspaces, runsByWorkspacePath])

  const refreshAll = async (): Promise<void> => {
    if (refreshing) return
    setRefreshing(true)
    setStatusMessage('Updating Home')
    try {
      await Promise.all(openWorkspaces.map((path) => onRefreshWorkspaceRuns?.(path)))
      stats.refresh()
      git.refresh()
      setStatusMessage('Home updated')
    } finally {
      setRefreshing(false)
    }
  }

  const stopRun = async (entry: HomeEntry): Promise<void> => {
    const key = homeEntryKey(entry)
    setStoppingKeys((current) => new Set(current).add(key))
    try {
      await onStopRunInWorkspace?.(entry.workspacePath, entry.run.runId)
      stats.refresh()
      git.refresh()
    } finally {
      setStoppingKeys((current) => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
    }
  }

  if (!hasWorkspaces) {
    return (
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-5 py-10">
          <section aria-labelledby="home-empty-heading" className="border-y border-border/50 py-20 text-center">
            <Icon name="folderPlus" size={28} className="mx-auto text-muted" aria-hidden="true" />
            <h1 id="home-empty-heading" className="mt-4 text-xl font-semibold text-fg">Open a workspace</h1>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted">Add a project folder to start sessions and track active work.</p>
            <Button className="mt-5" onClick={onAddWorkspace}>Add workspace</Button>
          </section>
        </div>
      </main>
    )
  }

  const renderSession = (entry: HomeEntry, state?: HomeEntryState) => {
    const key = homeEntryKey(entry)
    const resolvedState = state ?? stateOfHomeEntry(entry, stats.data[key], activeKeys)
    const hasChanges = (git.data[entry.workspacePath]?.changedFiles ?? 0) > 0
    return (
      <SessionRow
        key={key}
        entry={entry}
        state={resolvedState}
        pinned={pinnedRunKeys.includes(key)}
        showWorkspace={openWorkspaces.length > 1}
        active={isRunOpenInPane?.(entry.workspacePath, entry.run.runId) ?? false}
        focused={isRunFocusedInPane?.(entry.workspacePath, entry.run.runId) ?? false}
        stopping={stoppingKeys.has(key)}
        onOpen={() => onSelectRunInWorkspace(entry.workspacePath, entry.run.runId)}
        onStop={resolvedState === 'running' && onStopRunInWorkspace ? () => void stopRun(entry) : undefined}
        onReviewChanges={hasChanges && onReviewChangesInWorkspace ? () => onReviewChangesInWorkspace(entry.workspacePath, entry.run.runId) : undefined}
        onTogglePinned={() => onTogglePinnedRun(key)}
        onRename={onRenameRunInWorkspace ? (goal) => onRenameRunInWorkspace(entry.workspacePath, entry.run.runId, goal) : undefined}
        onDelete={onDeleteRunInWorkspace ? () => onDeleteRunInWorkspace(entry.workspacePath, entry.run.runId) : undefined}
        onExport={onExportRunInWorkspace ? () => onExportRunInWorkspace(entry.workspacePath, entry.run.runId) : undefined}
      />
    )
  }

  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-4 pb-16 pt-8 sm:px-6 sm:pt-10">
        <PageHeader
          title="Home"
          description={[
            `${openWorkspaces.length} ${openWorkspaces.length === 1 ? 'workspace' : 'workspaces'}`,
            runningEntries.length > 0 ? `${runningEntries.length} running` : null,
            attentionEntries.length > 0 ? `${attentionEntries.length} need review` : null
          ]
            .filter((part): part is string => part != null)
            .join(' · ')}
          trailing={(
            <Button variant="subtle" pending={refreshing} onClick={() => void refreshAll()}>
              <Icon name="refresh" size={14} aria-hidden="true" /> Refresh
            </Button>
          )}
        />
        <div role="status" className="sr-only">{statusMessage}</div>

        {stats.error ? (
          <AlertBlock className="mt-4 flex items-center justify-between gap-3">
            <span>Session details are unavailable. Existing sessions can still be opened.</span>
            <button className="shrink-0 underline focus-visible:vy-focus-ring" onClick={stats.refresh}>Retry</button>
          </AlertBlock>
        ) : null}

        {runningEntries.length > 0 ? (
          <section aria-labelledby="home-running-heading" className="mt-9">
            <div className="flex items-center justify-between gap-3">
              <h2 id="home-running-heading" className={SECTION_LABEL}>Running now</h2>
              <span className="text-xs text-muted">Live</span>
            </div>
            <div role="list" className="mt-2 border-y border-border/55">
              {runningEntries.map((entry) => renderSession(entry, 'running'))}
            </div>
          </section>
        ) : null}

        <section aria-labelledby="home-workspaces-heading" className="mt-10">
          <div className="flex items-center justify-between gap-3">
            <h2 id="home-workspaces-heading" className={SECTION_LABEL}>Workspaces</h2>
            <Button variant="ghost" className="min-h-8 px-2 text-xs" onClick={onAddWorkspace}>
              <Icon name="plus" size={12} aria-hidden="true" /> Add workspace
            </Button>
          </div>
          <div role="list" className="mt-2 border-y border-border/55">
            {openWorkspaces.map((path) => (
              <WorkspaceRow
                key={path}
                path={path}
                sessionCount={runsByWorkspacePath[path]?.runs.length ?? 0}
                running={workspaceHasBackgroundRun?.(path) ?? false}
                summary={git.data[path]}
                loading={git.loading}
                error={git.errors[path]}
                lastActivityAt={lastActivityByPath[path]}
                onOpen={() => onSwitchWorkspace(path)}
                onNewChat={() => onNewSessionInWorkspace(path, '')}
                onReviewChanges={onReviewChangesInWorkspace ? () => onReviewChangesInWorkspace(path) : undefined}
                onRevealFile={(file) => void window.vyotiq?.workspaceFileReveal({ workspacePath: path, path: file })}
                onRefresh={git.refresh}
              />
            ))}
          </div>
        </section>

        <section aria-labelledby="home-recent-heading" className="mt-10">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <h2 id="home-recent-heading" className={SECTION_LABEL}>Sessions</h2>
              <div
                role="group"
                aria-label="Session filter"
                className="flex items-center gap-0.5 rounded-md border border-border/60 p-0.5"
              >
                <button
                  type="button"
                  aria-pressed={reviewFilter === 'all'}
                  className={cn(
                    'rounded px-1.5 py-0.5 text-[10px] font-medium vy-transition focus-visible:vy-focus-ring',
                    reviewFilter === 'all' ? 'bg-surface text-fg' : 'text-muted hover:text-fg'
                  )}
                  onClick={() => setReviewFilter('all')}
                >
                  All
                </button>
                <button
                  type="button"
                  aria-pressed={reviewFilter === 'attention'}
                  className={cn(
                    'rounded px-1.5 py-0.5 text-[10px] font-medium vy-transition focus-visible:vy-focus-ring',
                    reviewFilter === 'attention' ? 'bg-surface text-fg' : 'text-muted hover:text-fg'
                  )}
                  onClick={() => setReviewFilter('attention')}
                >
                  Needs review{attentionEntries.length > 0 ? ` · ${attentionEntries.length}` : ''}
                </button>
              </div>
            </div>
            {sessionEntries.length > 0 ? (
              <label className="w-full sm:w-72">
                <span className="sr-only">Filter sessions</span>
                <input
                  type="search"
                  value={query}
                  placeholder="Filter sessions"
                  data-vy-text-entry
                  className="w-full rounded-md border border-border bg-surface/50 px-3 py-2 text-sm text-fg outline-none placeholder:text-muted focus-visible:vy-focus-ring"
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setQuery('')
                  }}
                />
              </label>
            ) : null}
          </div>
          {filteredRecent.length > 0 ? (
            <div role="list" className="mt-3 border-y border-border/55">
              {recentGroups.map((group) => (
                <div key={group.id}>
                  <p className="border-b border-border/35 bg-surface/25 px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-muted">{group.label}</p>
                  {group.entries.map((entry) => renderSession(entry))}
                </div>
              ))}
            </div>
          ) : sessionEntries.length === 0 ? (
            <p className="mt-3 border-y border-border/50 py-8 text-sm text-muted">No sessions yet. Start from a workspace above.</p>
          ) : reviewFilter === 'attention' && attentionEntries.length === 0 ? (
            <p role="status" className="mt-3 border-y border-border/50 py-8 text-sm text-muted">Nothing needs review right now.</p>
          ) : (
            <p role="status" className="mt-3 border-y border-border/50 py-8 text-sm text-muted">No sessions match this filter.</p>
          )}
        </section>
      </div>
    </main>
  )
}
