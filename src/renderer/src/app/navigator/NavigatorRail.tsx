import type { ComponentProps } from 'react'
import type { ActiveRun } from '@shared/ipc'
import { workspacePathsEqual } from '@shared/workspacePathMatch'
import { useWaitingAsks } from '@renderer/features/home/usePendingAsks'
import { IconButton, StatusGlyph, Tooltip, cn } from '@renderer/lib/ui'
import { BORDER_DIVIDER, ROW_HOVER, SELECTED } from '@renderer/lib/utils/layout'
import { shortcutLabel } from '@renderer/lib/shortcuts'
import type { NavigatorPlace } from './Navigator'
import type { NavSection, NavSectionKey } from './navigatorModel'
import { NotificationsRow } from './NotificationsRow'

/** The navigator's width below the desktop breakpoint: one glyph per task. */
export const NAVIGATOR_RAIL_WIDTH_PX = 56

/** The groups the rail keeps: a task that still wants something. Finished work is the drawer's. */
const RAIL_SECTIONS: ReadonlySet<NavSectionKey> = new Set(['needs', 'running', 'review'])

export function railSections(sections: readonly NavSection[]): NavSection[] {
  return sections.filter((section) => RAIL_SECTIONS.has(section.key) && section.rows.length > 0)
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
  // The rail's Inbox answers in place too: Needs you first, with Allow once and Deny.
  const { asks, respond } = useWaitingAsks(activeRuns, openPaths, onRespondApproval)
  return (
    <nav
      aria-label="Tasks"
      className="app-region-no-drag flex h-full min-h-0 shrink-0 flex-col items-center bg-chrome"
      style={{ width: NAVIGATOR_RAIL_WIDTH_PX }}
      data-navigator-rail
    >
      <div className={cn('flex h-10 w-full shrink-0 items-center justify-center border-b', BORDER_DIVIDER)}>
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
            {section.rows.map((row) => {
              const current =
                place === 'task' && selected?.runId === row.runId && workspacePathsEqual(selected.workspacePath, row.workspacePath)
              const doing = row.activity ?? row.stateLabel
              return (
                <li key={`${row.workspacePath}\u0000${row.runId}`}>
                  <Tooltip content={`${row.title} · ${doing}`} side="bottom" describeChild={false}>
                    <button
                      type="button"
                      aria-label={`${row.title}, ${doing}`}
                      aria-current={current ? 'page' : undefined}
                      onClick={() => onSelect(row.workspacePath, row.runId)}
                      className={cn(
                        'grid size-9 place-items-center rounded-md vy-transition focus-visible:vy-focus-ring',
                        current ? SELECTED : ROW_HOVER
                      )}
                      data-rail-task={row.runId}
                    >
                      <StatusGlyph state={row.state} size={16} />
                    </button>
                  </Tooltip>
                </li>
              )
            })}
          </ul>
        ))}
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
