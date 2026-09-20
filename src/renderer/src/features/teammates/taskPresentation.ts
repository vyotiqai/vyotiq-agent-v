import { formatDisplayTime, formatElapsed, relativeTimeAgo } from '@shared/utils/timeFormat'
import { isTerminalDelegatedTaskStatus, type DelegatedTask, type DelegatedTaskStatus } from '@shared/ipc'

/**
 * How a delegated task reads on screen.
 *
 * The record has always carried when it was scheduled, when it started, when it
 * finished and whether it was a retry of something else. None of that was ever
 * rendered — a scheduled task showed the word "Scheduled" and nothing about
 * when, and a retry was indistinguishable from a fresh assignment.
 */

export const TASK_STATUS_LABEL: Record<DelegatedTaskStatus, string> = {
  queued: 'Queued',
  scheduled: 'Scheduled',
  running: 'Running',
  cancelling: 'Stopping…',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled'
}

/** Semantic tones only — these must stay legible across every skin and theme. */
export const TASK_STATUS_TONE: Record<
  DelegatedTaskStatus,
  'neutral' | 'accent' | 'success' | 'danger' | 'warning'
> = {
  queued: 'neutral',
  scheduled: 'neutral',
  running: 'accent',
  cancelling: 'warning',
  done: 'success',
  failed: 'danger',
  cancelled: 'neutral'
}

/** First line of the brief — the whole thing lives in a title attribute. */
export function taskHeadline(task: DelegatedTask): string {
  return task.prompt.split('\n')[0] ?? task.prompt
}

export function isTaskActive(task: DelegatedTask): boolean {
  return !isTerminalDelegatedTaskStatus(task.status)
}

/** "in 12m", "due now", or null when the instant is not in the future. */
export function startsIn(iso: string, now = Date.now()): string | null {
  const target = Date.parse(iso)
  if (!Number.isFinite(target)) return null
  const remain = target - now
  if (remain <= 0) return 'due now'
  if (remain < 60_000) return 'due now'
  const minutes = Math.round(remain / 60_000)
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.round(remain / 3_600_000)
  if (hours < 48) return `in ${hours}h`
  return `in ${Math.round(remain / 86_400_000)}d`
}

/**
 * The one timing line a row shows, chosen by what the status makes relevant:
 * when a scheduled task fires, how long a finished one took, how long ago work
 * arrived. Computed without a ticking clock — a queue of two hundred rows must
 * not re-render every second to keep a relative label honest.
 */
export function taskTiming(task: DelegatedTask, now = Date.now()): string | null {
  if (task.status === 'scheduled' && task.scheduledAt) {
    const soon = startsIn(task.scheduledAt, now)
    return soon ? `Starts ${formatDisplayTime(task.scheduledAt)} (${soon})` : null
  }
  if (task.status === 'running' || task.status === 'cancelling') {
    return task.startedAt ? `Started ${relativeTimeAgo(task.startedAt)}` : null
  }
  if (isTerminalDelegatedTaskStatus(task.status)) {
    if (task.startedAt && task.finishedAt) {
      const ms = Date.parse(task.finishedAt) - Date.parse(task.startedAt)
      const took = formatElapsed(ms)
      const ago = relativeTimeAgo(task.finishedAt)
      if (took && ago) return `Took ${took}, ${ago}`
      if (ago) return ago
    }
    return task.finishedAt ? relativeTimeAgo(task.finishedAt) : null
  }
  return task.createdAt ? `Queued ${relativeTimeAgo(task.createdAt)}` : null
}

/**
 * Sort for display: work that still needs attention first, then the most
 * recently finished. Within the active group, soonest-to-act comes first.
 */
export function compareTasksForDisplay(a: DelegatedTask, b: DelegatedTask): number {
  const activeA = isTaskActive(a)
  const activeB = isTaskActive(b)
  if (activeA !== activeB) return activeA ? -1 : 1
  if (activeA) return a.createdAt.localeCompare(b.createdAt)
  return (b.finishedAt ?? b.createdAt).localeCompare(a.finishedAt ?? a.createdAt)
}

/** Which controls a row may offer, given what main will actually accept. */
export function taskControls(task: DelegatedTask): { retry: boolean; cancel: boolean } {
  if (isTerminalDelegatedTaskStatus(task.status)) return { retry: true, cancel: false }
  // A stop is already in flight: `cancelTask` refuses a second one, so offering
  // the button would be a control that silently does nothing.
  if (task.status === 'cancelling') return { retry: false, cancel: false }
  return { retry: false, cancel: true }
}
