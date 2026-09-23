import type { RunStat } from '@shared/ipc'
import { runCostDisplay } from '@shared/utils/costDisplay'
import { relativeTimeAgo } from '@shared/timeFormat'
import { Icon } from '@renderer/lib/icons'
import { Button, IconButton, cn } from '@renderer/lib/ui'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import { runTitle, runTooltip } from '@renderer/app/sidebar/runTitle'
import type { HomeEntry, HomeEntryState } from '../homeEntries'
import { STATE_PRESENTATION } from '../statePresentation'
import { nextTickLabel } from '../homeTime'

export type SessionLineAction = {
  label: string
  onClick: () => void
  pending?: boolean
  variant?: 'subtle' | 'danger' | 'ghost'
  /** Overrides the default `<label> <session title>` accessible name. */
  title?: string
}

/**
 * The single row shape used by every session-shaped list on Home. The title
 * opens the session; the meta line carries only markers that are present in
 * the run's own persisted state, so an absent marker means absent data.
 */
export function SessionLine({
  entry,
  state,
  stat,
  showWorkspace,
  showState = true,
  pinned,
  open,
  focused,
  actions,
  onOpen,
  onTogglePin
}: {
  entry: HomeEntry
  state: HomeEntryState
  stat?: RunStat
  showWorkspace: boolean
  /** False inside an attention lane whose header already names the state. */
  showState?: boolean
  pinned: boolean
  open: boolean
  focused: boolean
  /**
   * Buttons in row order. A row can carry more than one because a single run
   * can be running, pursuing a goal and holding an armed loop at the same
   * time, and each of those is stopped separately.
   */
  actions?: readonly SessionLineAction[]
  onOpen: () => void
  onTogglePin: () => void
}) {
  const title = runTitle(entry.run)
  const presentation = state === 'done' ? null : STATE_PRESENTATION[state]
  const age = relativeTimeAgo(entry.run.updatedAt)
  // Receipt stats are the fuller source; the run summary's own cost covers
  // sessions whose stats have not arrived (or were never written).
  const cost = runCostDisplay(stat) ?? runCostDisplay(entry.run)
  const goalStatus = entry.run.goalStatus
  const goalLabel =
    goalStatus === 'active' || goalStatus === 'paused'
      ? `${goalStatus === 'paused' ? 'Goal paused' : 'Goal'}${entry.run.goalContinueCount ? ` ×${entry.run.goalContinueCount}` : ''}`
      : null
  const loopLabel = entry.run.loopArmed
    ? entry.run.loopNextAt
      ? `Loop ${nextTickLabel(entry.run.loopNextAt) ?? 'armed'}`
      : 'Loop armed'
    : null

  return (
    <div
      role="listitem"
      className={cn(
        'group grid min-w-0 gap-2 px-3 py-2.5 @md:grid-cols-[minmax(0,1fr)_auto] @md:items-center',
        focused ? 'bg-surface-2/70' : open ? 'bg-surface/50' : 'hover:bg-surface/30'
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        {presentation && showState ? (
          <span
            className={cn('mt-px inline-flex size-4 shrink-0 items-center justify-center', presentation.tone)}
            aria-hidden="true"
          >
            <Icon
              name={presentation.icon}
              size={13}
              className={presentation.spin ? 'animate-spin' : undefined}
            />
          </span>
        ) : presentation ? (
          // Empty gutter of the same width: inside a lane the icon is the
          // header's, but the title has to stay on the header's text edge.
          <span className="size-4 shrink-0" aria-hidden="true" />
        ) : null}
        <div className="min-w-0 flex-1">
          <button
            type="button"
            className="block max-w-full truncate text-left text-sm text-fg vy-transition hover:text-fg-strong focus-visible:vy-focus-ring"
            title={runTooltip(entry.run)}
            aria-label={`Open ${title}${presentation ? `, ${presentation.label}` : ''}${showWorkspace ? `, ${formatWorkspaceName(entry.workspacePath)}` : ''}`}
            onClick={onOpen}
          >
            {title}
          </button>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-muted">
            {presentation && showState ? (
              <span className={presentation.tone}>{presentation.label}</span>
            ) : null}
            {showWorkspace ? (
              <span className="truncate" title={entry.workspacePath}>
                {formatWorkspaceName(entry.workspacePath)}
              </span>
            ) : null}
            {goalLabel ? (
              <span
                className="inline-flex items-center gap-1 text-accent"
                title={
                  entry.run.goalContinueCount
                    ? `Long-lived goal — continued ${entry.run.goalContinueCount} times`
                    : 'Long-lived goal'
                }
              >
                <Icon name="flag" size={10} aria-hidden="true" />
                {goalLabel}
              </span>
            ) : null}
            {loopLabel ? (
              <span
                className="inline-flex items-center gap-1 text-accent"
                title={
                  entry.run.loopNextAt
                    ? `Next loop tick at ${new Date(entry.run.loopNextAt).toLocaleString()}`
                    : 'Prompt loop is armed'
                }
              >
                <Icon name="refresh" size={10} aria-hidden="true" />
                {loopLabel}
              </span>
            ) : null}
            {entry.run.worktreeBranch ? (
              <span className="inline-flex min-w-0 items-center gap-1" title={entry.run.worktreePath}>
                <Icon name="branch" size={10} aria-hidden="true" />
                <span className="truncate">{entry.run.worktreeBranch}</span>
              </span>
            ) : null}
            {age ? <span>{age}</span> : null}
            {cost ? (
              <span className="tabular-nums" title={cost.title}>
                {cost.text}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-1">
        {(actions ?? []).map((action) => (
          <Button size="xs"
            key={action.label}
            variant={action.variant ?? 'subtle'}
            pending={action.pending}
            // Several rows can carry the same action, so the accessible name
            // has to name the session it acts on.
            aria-label={action.title ?? `${action.label} ${title}`}
            onClick={action.onClick}
          >
            {action.label}
          </Button>
        ))}
        <IconButton
          icon="star"
          label={pinned ? `Unpin ${title}` : `Pin ${title}`}
          size="sm"
          variant="bare"
          className={cn(
            'shrink-0 vy-transition',
            pinned
              ? 'text-warning'
              : 'text-muted opacity-0 hover:text-fg group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100'
          )}
          onClick={onTogglePin}
        />
      </div>
    </div>
  )
}
