import { useEffect, useState } from 'react'
import type { TaskSchedule } from '@shared/ipc/schemas/schedules'
import { describeSchedule } from '@shared/scheduleTime'
import { workspacePathsEqual } from '@shared/workspacePathMatch'
import { Icon } from '@renderer/lib/icons'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import { requestScheduledTasks } from '@renderer/features/schedules/scheduleRequests'
import { formatRunTime } from '@renderer/features/schedules/ScheduleFields'
import { HomeLink, HomeRow, HomeSection } from './HomeBlocks'

/** Scheduled runs listed before the rest are left to the Scheduled tasks list. */
const SHOWN = 3

/** The next enabled schedules of the open workspaces, soonest first. */
export function upcomingSchedules(schedules: readonly TaskSchedule[], openWorkspaces: readonly string[]): TaskSchedule[] {
  return schedules
    .filter(
      (s) => s.enabled && s.nextRunAt && openWorkspaces.some((path) => workspacePathsEqual(path, s.workspacePath))
    )
    .sort((a, b) => Date.parse(a.nextRunAt!) - Date.parse(b.nextRunAt!))
}

/**
 * What runs next on its own: the soonest scheduled tasks, with when and how
 * often. Nothing shows without one; the list itself is a click away.
 */
export function ComingUpSection({
  openWorkspaces,
  refreshVersion = 0
}: {
  openWorkspaces: readonly string[]
  refreshVersion?: number
}) {
  const [schedules, setSchedules] = useState<TaskSchedule[]>([])
  useEffect(() => {
    let cancelled = false
    void window.vyotiq?.listSchedules?.().then((res) => {
      if (!cancelled && res?.ok) setSchedules(res.data.schedules)
    })
    return () => {
      cancelled = true
    }
  }, [refreshVersion])

  const upcoming = upcomingSchedules(schedules, openWorkspaces)
  if (upcoming.length === 0) return null
  const many = new Set(upcoming.map((s) => s.workspacePath)).size > 1
  return (
    <HomeSection
      id="home-coming-up"
      label="Coming up"
      className="mt-10"
      trailing={<HomeLink onClick={() => void requestScheduledTasks()}>Scheduled tasks</HomeLink>}
    >
      {upcoming.slice(0, SHOWN).map((schedule) => (
        <HomeRow key={schedule.id}>
          <Icon name="repeat" size={14} className="shrink-0 text-tertiary" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-fg" title={schedule.instruction}>
              {schedule.instruction.split('\n')[0]}
            </span>
            <span className="block truncate text-caption text-tertiary">
              {describeSchedule(schedule.schedule)}
              {many ? ` · ${formatWorkspaceName(schedule.workspacePath)}` : ''}
            </span>
          </span>
          <span className="shrink-0 font-mono text-caption text-muted tnum" data-coming-up-at>
            {formatRunTime(new Date(schedule.nextRunAt!))}
          </span>
        </HomeRow>
      ))}
    </HomeSection>
  )
}
