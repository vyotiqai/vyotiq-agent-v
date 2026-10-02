import type { ComponentProps } from 'react'
import type { ActiveRun } from '@shared/ipc'
import { workspacePathsEqual } from '@shared/workspacePathMatch'
import { useWaitingAsks } from '@renderer/features/home/usePendingAsks'
import { IconButton, StatusGlyph, Tooltip, cn } from '@renderer/lib/ui'
import { BORDER_DIVIDER, CONTROL_HOVER, SELECTED } from '@renderer/lib/utils/layout'
import { shortcutLabel } from '@renderer/lib/shortcuts'
import type { NavigatorPlace } from './Navigator'
import type { NavRow, NavSection, NavSectionKey } from './navigatorModel'
import { NotificationsRow } from './NotificationsRow'

/** The navigator's width below the desktop breakpoint: one glyph per task. */
export const NAVIGATOR_RAIL_WIDTH_PX = 56

/** The groups the rail keeps: a task that still wants something. Finished work is the drawer's. */
const RAIL_SECTIONS: ReadonlySet<NavSectionKey> = new Set(['needs', 'running', 'review'])

export function railSections(sections: readonly NavSection[]): NavSection[] {
  return sections.filter((section) => RAIL_SECTIONS.has(section.key) && section.rows.length > 0)
}

/**
 * The task you are on when its group is not one the rail keeps (a done or
 * pinned task): the rail still shows where you are, after the live groups.
 */
export function railOpenRow(
  sections: readonly NavSection[],
  selected: { workspacePath: string; runId: string } | null
): NavRow | null {
  if (!selected) return null
  for (const section of sections) {
    const row = section.rows.find(
      (r) => r.runId === selected.runId && workspacePathsEqual(r.workspacePath, selected.workspacePath)
    )
    if (row) return RAIL_SECTIONS.has(section.key) ? null : row
  }
  return null
}

/** Words an initial would waste: "Update the docs" is UD, not UT. */
const FILLER = new Set(['a', 'an', 'and', 'for', 'in', 'of', 'on', 'the', 'to', 'with'])

/**
 * One or two initials that tell same-state tasks apart at a glance: the first
 * letters of the title's first two words that carry meaning ("Hey What can we
 * do?" → HW), or one initial for a one-word title.
 */
export function railInitials(title: string): string {
  const words = title.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w))
  const kept = words.filter((w, i) => i === 0 || !FILLER.has(w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')))
  const initial = (w: string): string => (w.match(/[\p{L}\p{N}]/u)?.[0] ?? '').toLocaleUpperCase()
  return kept
    .slice(0, 2)
    .map(initial)
    .join('')
}

/**
 * The navigator below the desktop breakpoint, where the full list is a
 * drawer: New task on top, then one glyph per task still in play, in the
 * list's groups and order with a hairline between groups, then the same
 * places, in the same order, as the list's foot.
 */
export function NavigatorRail({
  sections,
  place,
  selected,
  onSelect,
  onNewTask,
  onOpenHome,
  onOpenExtensions,
  onOpenUsage,
  onOpenSettings,
  notifications,
  activeRuns,
  openPaths,
  onRespondApproval
}: {
  /** The list's sections; the rail keeps the live ones. */
  sections: readonly NavSection[]
  place: NavigatorPlace
  selected: { workspacePath: string; runId: string } | null
  onSelect: (workspacePath: string, runId: string) => void
  onNewTask: () => void
  onOpenHome: () => void
  onOpenExtensions: () => void
  onOpenUsage: () => void
  onOpenSettings: () => void
  notifications: ComponentProps<typeof NotificationsRow>
  /** Live tasks and the open workspaces: what the Inbox's asks are read from, as the list's are. */
  activeRuns: readonly ActiveRun[]
  openPaths: readonly string[]
  onRespondApproval?: ComponentProps<typeof NotificationsRow>['onRespondApproval']
}) {
  const groups = railSections(sections)
  const openRow = place === 'task' ? railOpenRow(sections, selected) : null
  // The rail's Inbox answers in place too: Needs you first, with Allow once and Deny.
  const { asks, respond } = useWaitingAsks(activeRuns, openPaths, onRespondApproval)
  const isCurrent = (row: NavRow): boolean =>
    place === 'task' && selected?.runId === row.runId && workspacePathsEqual(selected.workspacePath, row.workspacePath)
  return (
    <nav
      aria-label="Tasks"
      className="app-region-no-drag flex h-full min-h-0 shrink-0 flex-col items-center bg-chrome"
      style={{ width: NAVIGATOR_RAIL_WIDTH_PX }}
      data-navigator-rail
    >
      <div className="flex h-10 w-full shrink-0 items-center justify-center border-b border-border">
        <IconButton icon="plus" label={`New task (${shortcutLabel('newChat')})`} size="md" onClick={onNewTask} />
      </div>
      <div className="flex min-h-0 w-full flex-1 flex-col items-center overflow-y-auto py-2">
        {groups.map((section, i) => (
          <ul
            key={section.key}
            aria-label={section.label}
            className={cn('flex flex-col items-center gap-1', i > 0 ? cn('mt-2 border-t pt-2', BORDER_DIVIDER) : null)}
            data-rail-section={section.key}
          >
            {section.rows.map((row) => (
              <RailTask key={`${row.workspacePath}\u0000${row.runId}`} row={row} current={isCurrent(row)} onSelect={onSelect} />
            ))}
          </ul>
        ))}
        {openRow ? (
          <ul
            aria-label="Open task"
            className={cn('flex flex-col items-center gap-1', groups.length > 0 ? cn('mt-2 border-t pt-2', BORDER_DIVIDER) : null)}
            data-rail-section="open"
          >
            <RailTask row={openRow} current onSelect={onSelect} />
          </ul>
        ) : null}
      </div>
      <div
        className={cn('flex w-full shrink-0 flex-col items-center gap-0.5 border-t py-1.5', BORDER_DIVIDER)}
        role="group"
        aria-label="Places"
      >
        <RailPlace icon="home" label="Home" active={place === 'home'} onClick={onOpenHome} />
        <NotificationsRow {...notifications} asks={asks} onRespondApproval={respond} />
        <RailPlace icon="extensions" label="Extensions" active={place === 'extensions'} onClick={onOpenExtensions} />
        <RailPlace icon="chart" label="Usage" active={place === 'usage'} onClick={onOpenUsage} />
        <RailPlace
          icon="gear"
          label={`Settings (${shortcutLabel('settings')})`}
          active={place === 'settings'}
          onClick={onOpenSettings}
        />
      </div>
    </nav>
  )
}

/**
 * One task: its initials, so tasks in the same state are still told apart,
 * with its state glyph as a badge on the corner. Initials stay muted until the
 * task is the one you are on or has finished unseen; the badge carries the hue.
 */
function RailTask({
  row,
  current,
  onSelect
}: {
  row: NavRow
  current: boolean
  onSelect: (workspacePath: string, runId: string) => void
}) {
  const doing = row.activity ?? row.stateLabel
  const initials = railInitials(row.title)
  return (
    <li>
      <Tooltip content={`${row.title}\n${doing}`} side="right" describeChild={false}>
        <button
          type="button"
          aria-label={`${row.title}, ${doing}`}
          aria-current={current ? 'page' : undefined}
          onClick={() => onSelect(row.workspacePath, row.runId)}
          className={cn(
            'group relative grid size-9 place-items-center rounded-md vy-transition focus-visible:vy-focus-ring',
            current ? SELECTED : CONTROL_HOVER
          )}
          data-rail-task={row.runId}
        >
          {initials ? (
            // Nudged up and left by the badge's overlap, so the pair sits centred.
            <span
              aria-hidden
              className={cn(
                'pb-1.5 pr-1.5 text-xs font-semibold leading-none tracking-[var(--vy-tracking-tight)]',
                current || row.unread ? 'text-fg-strong' : 'text-muted'
              )}
              data-rail-initials
            >
              {initials}
            </span>
          ) : null}
          <span
            aria-hidden
            className={cn(
              'absolute grid place-items-center rounded-full vy-transition',
              initials ? 'bottom-0.5 right-0.5 p-px' : 'inset-0',
              // The badge's disc is cut from the button's own fill, so it reads
              // as one piece at rest, on hover and when selected.
              !initials ? null : current ? 'bg-surface-2' : 'bg-chrome group-hover:bg-surface'
            )}
          >
            <StatusGlyph state={row.state} size={initials ? 12 : 16} />
          </span>
        </button>
      </Tooltip>
    </li>
  )
}

function RailPlace({
  icon,
  label,
  active,
  onClick
}: {
  icon: 'home' | 'extensions' | 'chart' | 'gear'
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <IconButton
      icon={icon}
      label={label}
      size="md"
      active={active}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    />
  )
}
