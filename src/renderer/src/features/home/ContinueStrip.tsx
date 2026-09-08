import { Icon } from '@renderer/lib/icons'
import { cn } from '@renderer/lib/ui'
import { runTitle } from '@renderer/app/sidebar/runTitle'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import type { RunSummary } from '@shared/ipc'

export const CONTINUE_STRIP_HEADING_ID = 'continue-strip-heading'

export interface ContinueStripEntry {
  workspacePath: string
  run: RunSummary
}

export interface ContinueStripProps {
  entries: ContinueStripEntry[]
  maxCards?: number
  runningRunIds?: ReadonlySet<string>
  onSelect: (workspacePath: string, runId: string) => void
}

export function ContinueStrip({
  entries,
  maxCards = 4,
  runningRunIds,
  onSelect
}: ContinueStripProps) {
  if (entries.length === 0) return null

  const cards = entries.slice(0, Math.max(0, maxCards))

  return (
    <section aria-labelledby={CONTINUE_STRIP_HEADING_ID}>
      <h2
        id={CONTINUE_STRIP_HEADING_ID}
        className="text-xs font-medium uppercase tracking-wider text-muted"
      >
        Continue where you left off
      </h2>
      <div role="list" className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map(({ workspacePath, run }) => {
          const running = runningRunIds?.has(run.runId) || run.status === 'running'
          const title = runTitle(run)
          const workspaceName = formatWorkspaceName(workspacePath)
          const ariaLabel = running
            ? `${title}, ${workspaceName}, running`
            : `${title}, ${workspaceName}`
          return (
            <div role="listitem" key={`${workspacePath}:${run.runId}`}>
              <button
                type="button"
                onClick={() => onSelect(workspacePath, run.runId)}
                aria-label={ariaLabel}
                data-continue-running={running ? '1' : undefined}
                className={cn(
                  'flex min-h-28 w-full flex-col items-start gap-2 rounded-xl border border-border bg-surface/40 p-4 text-left vy-transition',
                  'hover:border-border-strong hover:bg-surface/70 focus-visible:vy-focus-ring'
                )}
              >
                <span className="flex w-full items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-medium text-fg" title={title}>
                    {title}
                  </span>
                  {running ? (
                    <span className="inline-flex shrink-0" title="Running">
                      <Icon name="loader" size={12} className="animate-spin text-fg" />
                    </span>
                  ) : null}
                </span>
                <span className="w-full truncate text-caption text-muted">
                  {workspaceName}
                </span>
              </button>
            </div>
          )
        })}
      </div>
    </section>
  )
}
