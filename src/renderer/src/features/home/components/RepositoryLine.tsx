import { relativeTimeAgo } from '@shared/timeFormat'
import { Icon } from '@renderer/lib/icons'
import { Button, cn } from '@renderer/lib/ui'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import type { WorkspaceGitSummary } from '../useWorkspaceGitSummaries'

/**
 * Repository state for one open workspace. Session counts are deliberately
 * absent — the sidebar owns the session list; this row answers "what is the
 * state of the code here, and what would I do about it".
 */
export function RepositoryLine({
  path,
  summary,
  loading,
  error,
  running,
  lastActivityAt,
  onOpen,
  onNewChat,
  onReviewChanges,
  onRevealFile,
  onRetryStatus
}: {
  path: string
  summary?: WorkspaceGitSummary
  loading: boolean
  error?: string
  running: boolean
  lastActivityAt?: string
  onOpen: () => void
  onNewChat: () => void
  onReviewChanges?: () => void
  onRevealFile: (file: string) => void
  onRetryStatus: () => void
}) {
  const name = formatWorkspaceName(path)
  const age = lastActivityAt ? relativeTimeAgo(lastActivityAt) : ''
  const changed = summary?.changedFiles ?? 0
  /** Files beyond the three preview chips — one click opens the full panel. */
  const hiddenFiles = changed - (summary?.topFiles?.length ?? 0)
  const repoState = error
    ? { text: 'Status unavailable', tone: 'text-danger' }
    : loading && !summary
      ? { text: 'Checking…', tone: undefined }
      : !summary
        ? { text: 'Not a repository', tone: undefined }
        : changed > 0
          ? { text: `${changed} changed`, tone: 'text-warning' }
          : { text: 'Clean', tone: undefined }

  return (
    <div
      role="listitem"
      className="grid min-w-0 gap-2 px-3 py-3 @lg:grid-cols-[minmax(0,1fr)_auto] @lg:items-center"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <span
          className="mt-px inline-flex size-4 shrink-0 items-center justify-center text-muted"
          aria-hidden="true"
        >
          <Icon name="folder" size={13} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              className="min-w-0 truncate text-left text-sm text-fg vy-transition hover:text-fg-strong focus-visible:vy-focus-ring"
              title={path}
              onClick={onOpen}
            >
              {name}
            </button>
            {running ? (
              <span className="inline-flex shrink-0 items-center gap-1 text-2xs text-accent">
                <Icon name="loader" size={10} className="animate-spin" aria-hidden="true" />
                Running
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-muted">
            {summary?.branch ? (
              <span className="inline-flex min-w-0 items-center gap-1">
                <Icon name="branch" size={10} aria-hidden="true" />
                <span className="truncate">{summary.branch}</span>
              </span>
            ) : null}
            <span className={repoState.tone}>{repoState.text}</span>
            {summary?.ahead != null && summary.behind != null && (summary.ahead > 0 || summary.behind > 0) ? (
              <span className="tabular-nums" title={`${summary.ahead} ahead, ${summary.behind} behind`}>
                ↑{summary.ahead} ↓{summary.behind}
              </span>
            ) : null}
            {age ? <span>{age}</span> : null}
          </div>
          {summary?.topFiles?.length ? (
            <div className="mt-1.5 flex min-w-0 flex-wrap gap-x-2.5 gap-y-1">
              {summary.topFiles.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  className="max-w-full truncate text-left text-3xs text-tertiary vy-transition hover:text-fg focus-visible:vy-focus-ring"
                  title={`Reveal ${file.path} — ${file.lines} changed ${file.lines === 1 ? 'line' : 'lines'}`}
                  onClick={() => onRevealFile(file.path)}
                >
                  {file.path}
                </button>
              ))}
              {hiddenFiles > 0 && onReviewChanges ? (
                <button
                  type="button"
                  className="max-w-full truncate text-left text-3xs text-tertiary vy-transition hover:text-fg focus-visible:vy-focus-ring"
                  title={`Review all ${changed} changed files`}
                  onClick={onReviewChanges}
                >
                  +{hiddenFiles} more
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className={cn('flex flex-wrap items-center justify-end gap-1.5 pl-7 @lg:pl-0')}>
        {error ? (
          <Button variant="ghost" className="min-h-7 px-2 text-2xs" onClick={onRetryStatus}>
            Retry
          </Button>
        ) : null}
        {onReviewChanges && changed > 0 ? (
          <Button variant="subtle" className="min-h-7 px-2 text-2xs" onClick={onReviewChanges}>
            Review changes
          </Button>
        ) : null}
        <Button variant="ghost" className="min-h-7 px-2 text-2xs" onClick={onNewChat}>
          <Icon name="plus" size={11} aria-hidden="true" /> New chat
        </Button>
      </div>
    </div>
  )
}
