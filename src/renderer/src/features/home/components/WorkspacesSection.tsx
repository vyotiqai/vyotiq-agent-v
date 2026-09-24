import { Icon } from '@renderer/lib/icons'
import { IconButton, StatusGlyph } from '@renderer/lib/ui'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import type { WorkspaceGitSummary } from '../useWorkspaceGitSummaries'
import { HomeLink, HomeRow, HomeSection } from './HomeBlocks'

/**
 * The open workspaces as git sees them: branch, what changed, how far from
 * its upstream, whether the index is being built, and how many tasks run
 * there now. Tasks themselves stay in the navigator.
 */
export function WorkspacesSection({
  paths,
  git,
  gitLoading,
  gitErrors,
  runningByPath,
  indexingPath,
  onAdd,
  onNewTask,
  onOpenWorkspace,
  onReviewChanges,
  onRetryStatus
}: {
  paths: readonly string[]
  git: Readonly<Record<string, WorkspaceGitSummary>>
  gitLoading: boolean
  gitErrors: Readonly<Record<string, string>>
  runningByPath: Readonly<Record<string, number>>
  /** The workspace main is indexing right now — the index follows the active one. */
  indexingPath: string | null
  onAdd: () => void
  onNewTask: (path: string) => void
  onOpenWorkspace: (path: string) => void
  onReviewChanges?: (path: string) => void
  onRetryStatus: () => void
}) {
  return (
    <HomeSection id="home-workspaces" label="Workspaces" trailing={<HomeLink icon="plus" onClick={onAdd}>Add</HomeLink>}>
      {paths.map((path) => (
        <WorkspaceRow
          key={path}
          path={path}
          summary={git[path]}
          loading={gitLoading}
          error={gitErrors[path]}
          running={runningByPath[path] ?? 0}
          indexing={indexingPath === path}
          onNewTask={() => onNewTask(path)}
          onOpen={() => onOpenWorkspace(path)}
          onReviewChanges={onReviewChanges ? () => onReviewChanges(path) : undefined}
          onRetryStatus={onRetryStatus}
        />
      ))}
    </HomeSection>
  )
}

function WorkspaceRow({
  path,
  summary,
  loading,
  error,
  running,
  indexing,
  onNewTask,
  onOpen,
  onReviewChanges,
  onRetryStatus
}: {
  path: string
  summary?: WorkspaceGitSummary
  loading: boolean
  error?: string
  running: number
  indexing: boolean
  onNewTask: () => void
  onOpen: () => void
  onReviewChanges?: () => void
  onRetryStatus: () => void
}) {
  const name = formatWorkspaceName(path)
  const changed = summary?.changedFiles ?? 0
  const drift = summary
    ? [summary.ahead ? `${summary.ahead} ahead` : '', summary.behind ? `${summary.behind} behind` : '']
        .filter(Boolean)
        .join(' · ')
    : ''
  return (
    <HomeRow>
      <Icon name="workspace" size={15} className="shrink-0 text-muted" />
      <span className="min-w-0 flex-1">
        <button
          type="button"
          title={`Show the tasks in ${path}`}
          className="block max-w-full truncate rounded-sm text-left text-sm text-fg vy-transition hover:text-fg-strong focus-visible:vy-focus-ring"
          onClick={onOpen}
        >
          {name}
        </button>
        <span className="flex min-w-0 items-center gap-2 text-caption text-muted">
          {error ? (
            <>
              <span className="truncate text-danger" title={error}>
                Status unavailable
              </span>
              <button
                type="button"
                className="shrink-0 rounded-sm text-muted underline-offset-2 vy-transition hover:text-fg hover:underline focus-visible:vy-focus-ring"
                onClick={onRetryStatus}
              >
                Retry
              </button>
            </>
          ) : !summary ? (
            <span className="text-tertiary">{loading ? 'Checking…' : 'Not a repository'}</span>
          ) : (
            <>
              {summary.branch ? <span className="truncate font-mono">{summary.branch}</span> : null}
              {changed > 0 ? (
                onReviewChanges ? (
                  <button
                    type="button"
                    title="Review the uncommitted changes"
                    className="shrink-0 rounded-sm text-secondary underline-offset-2 vy-transition hover:text-fg hover:underline focus-visible:vy-focus-ring"
                    onClick={onReviewChanges}
                  >
                    {changed} changed
                  </button>
                ) : (
                  <span className="shrink-0 text-secondary">{changed} changed</span>
                )
              ) : (
                <span className="shrink-0 text-tertiary">clean</span>
              )}
              {drift ? <span className="shrink-0 text-tertiary">{drift}</span> : null}
            </>
          )}
          {indexing ? <span className="shrink-0 text-tertiary">· indexing</span> : null}
        </span>
      </span>
      {running > 0 ? (
        <span
          className="inline-flex shrink-0 items-center gap-1 font-mono text-caption text-muted tnum"
          title={`${running} running`}
        >
          <StatusGlyph state="running" size={11} />
          {running}
        </span>
      ) : null}
      <IconButton icon="plus" label={`New task in ${name}`} size="sm" tone="muted" onClick={onNewTask} />
    </HomeRow>
  )
}
