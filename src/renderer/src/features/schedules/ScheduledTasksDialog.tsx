import { useCallback, useEffect, useState } from 'react'
import type { TaskSchedule } from '@shared/ipc/schemas/schedules'
import { describeSchedule } from '@shared/scheduleTime'
import { Dialog } from '@renderer/lib/a11y/Dialog'
import { Button, IconButton, Switch, cn, pushToast } from '@renderer/lib/ui'
import { BORDER_DIVIDER } from '@renderer/lib/utils/layout'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import { relativeTimeAgo } from '@shared/utils/timeFormat'
import { formatRunTime } from './ScheduleFields'
import { ScheduleEditForm, editFromSchedule, editToRequest, type ScheduleEdit } from './ScheduleEditForm'
import { onScheduledTasksRequest } from './scheduleRequests'

/**
 * Every repeating task, every workspace's: what it runs, when, when next, and
 * how its last turn went. On/off, Run now, Edit and Delete sit on the row; the
 * last run opens like any task. Edit swaps the list for the schedule's fields
 * and back. New ones come from Repeat… on a task's menu.
 */
export function ScheduledTasksDialog({
  onOpenTask
}: {
  onOpenTask?: (workspacePath: string, runId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [schedules, setSchedules] = useState<TaskSchedule[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; edit: ScheduleEdit } | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    const res = await window.vyotiq.listSchedules()
    if (res.ok) {
      setSchedules(res.data.schedules)
      setError(null)
    } else {
      setError(res.error)
    }
  }, [])

  useEffect(
    () =>
      onScheduledTasksRequest(() => {
        setOpen(true)
        setEditing(null)
        void load()
      }),
    [load]
  )

  // A run starting or ending moves "last run"; read the list again while it is up.
  useEffect(() => {
    if (!open || !window.vyotiq?.onChatEvent) return
    return window.vyotiq.onChatEvent((event) => {
      if (event.type === 'status') void load()
    })
  }, [open, load])

  const replace = (next: TaskSchedule): void =>
    setSchedules((prev) => (prev ? prev.map((s) => (s.id === next.id ? next : s)) : prev))

  const toggle = async (schedule: TaskSchedule, enabled: boolean): Promise<void> => {
    replace({ ...schedule, enabled })
    const res = await window.vyotiq.toggleSchedule(schedule.id, enabled)
    if (res.ok) replace(res.data)
    else {
      replace(schedule)
      pushToast(res.error, 'error')
    }
  }

  const runNow = async (schedule: TaskSchedule): Promise<void> => {
    const res = await window.vyotiq.runScheduleNow(schedule.id)
    if (!res.ok) {
      pushToast(res.error, 'error')
      return
    }
    replace(res.data)
    const outcome = res.data.lastOutcome
    if (outcome?.kind === 'started' && outcome.runId && onOpenTask) {
      setOpen(false)
      onOpenTask(res.data.workspacePath, outcome.runId)
    } else if (outcome && outcome.kind !== 'started' && outcome.kind !== 'starting') {
      pushToast(outcome.detail ?? 'It did not start', 'error')
    }
  }

  const remove = async (schedule: TaskSchedule): Promise<void> => {
    const res = await window.vyotiq.deleteSchedule(schedule.id)
    if (!res.ok) {
      pushToast(res.error, 'error')
      return
    }
    setSchedules((prev) => (prev ? prev.filter((s) => s.id !== schedule.id) : prev))
  }

  const startEdit = (schedule: TaskSchedule): void => {
    setEditing({ id: schedule.id, edit: editFromSchedule(schedule) })
    setEditError(null)
    setSavingEdit(false)
  }

  const editRequest = editing ? editToRequest(editing.id, editing.edit) : null

  const saveEdit = async (): Promise<void> => {
    if (!editRequest?.ok || savingEdit) return
    setSavingEdit(true)
    setEditError(null)
    const res = await window.vyotiq.updateSchedule(editRequest.request)
    setSavingEdit(false)
    if (!res.ok) {
      setEditError(res.error)
      return
    }
    replace(res.data)
    setEditing(null)
  }

  const manyWorkspaces = new Set((schedules ?? []).map((s) => s.workspacePath)).size > 1

  return (
    <Dialog
      open={open}
      // Closing the edit returns to the list; closing the list closes the dialog.
      onClose={() => (editing ? setEditing(null) : setOpen(false))}
      title={editing ? 'Edit schedule' : 'Scheduled tasks'}
      icon={editing ? 'edit' : 'repeat'}
      padded={editing != null}
      className="vy-menu flex w-[min(40rem,calc(100vw_-_2rem))] flex-col overflow-hidden"
      footer={
        editing ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={!editRequest?.ok || savingEdit} onClick={() => void saveEdit()}>
              {savingEdit ? 'Saving…' : 'Save'}
            </Button>
          </>
        ) : undefined
      }
    >
      {editing ? (
        <ScheduleEditForm
          edit={editing.edit}
          onChange={(edit) => setEditing((prev) => (prev ? { ...prev, edit } : prev))}
          error={editError}
        />
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-scheduled-tasks>
            {error ? (
              <p role="alert" className="m-0 px-4 py-4 text-sm text-danger">
                {error}
              </p>
            ) : schedules == null ? (
              <p className="m-0 px-4 py-4 text-sm text-muted">Loading…</p>
            ) : schedules.length === 0 ? (
              <p className="m-0 px-4 py-6 text-sm text-muted" data-scheduled-empty>
                Nothing repeats yet. Open a task’s menu and choose Repeat…
              </p>
            ) : (
              <ul className="m-0 list-none p-0">
                {schedules.map((schedule, i) => (
                  <ScheduleRow
                    key={schedule.id}
                    schedule={schedule}
                    first={i === 0}
                    showWorkspace={manyWorkspaces}
                    onToggle={(enabled) => void toggle(schedule, enabled)}
                    onRunNow={() => void runNow(schedule)}
                    onEdit={() => startEdit(schedule)}
                    onDelete={() => void remove(schedule)}
                    onOpenRun={
                      onOpenTask
                        ? (runId) => {
                            setOpen(false)
                            onOpenTask(schedule.workspacePath, runId)
                          }
                        : undefined
                    }
                  />
                ))}
              </ul>
            )}
          </div>
          <p className="m-0 border-t border-border px-4 py-2.5 text-xs text-muted">
            Each run is a new task. Schedules run while Agent V is open; a time missed while it was closed runs once when
            it opens.
          </p>
        </>
      )}
    </Dialog>
  )
}

function ScheduleRow({
  schedule,
  first,
  showWorkspace,
  onToggle,
  onRunNow,
  onEdit,
  onDelete,
  onOpenRun
}: {
  schedule: TaskSchedule
  first: boolean
  showWorkspace: boolean
  onToggle: (enabled: boolean) => void
  onRunNow: () => void
  onEdit: () => void
  onDelete: () => void
  onOpenRun?: (runId: string) => void
}) {
  const brief = schedule.instruction.replace(/\s+/g, ' ').trim()
  const when = describeSchedule(schedule.schedule)
  const next = schedule.enabled && schedule.nextRunAt ? formatRunTime(new Date(schedule.nextRunAt)) : null
  const outcome = schedule.lastOutcome
  return (
    <li
      className={cn('flex items-start gap-3 px-4 py-2.5', first ? null : cn('border-t', BORDER_DIVIDER))}
      data-schedule-row={schedule.id}
    >
      <span className="flex h-5 shrink-0 items-center">
        <Switch
          checked={schedule.enabled}
          onCheckedChange={onToggle}
          label={`${schedule.enabled ? 'Pause' : 'Resume'} ${brief.slice(0, 60)}`}
        />
      </span>
      <div className="min-w-0 flex-1">
        <p className={cn('m-0 truncate text-sm', schedule.enabled ? 'text-fg' : 'text-muted')} title={brief}>
          {brief}
        </p>
        <p className="m-0 truncate text-xs text-muted">
          {when}
          {next ? (
            <>
              <span aria-hidden> · </span>next <span className="text-secondary">{next}</span>
            </>
          ) : schedule.enabled ? null : (
            <>
              <span aria-hidden> · </span>paused
            </>
          )}
          {showWorkspace ? (
            <>
              <span aria-hidden> · </span>
              {formatWorkspaceName(schedule.workspacePath)}
            </>
          ) : null}
        </p>
        {outcome ? (
          <p className="m-0 truncate text-xs" data-schedule-outcome={outcome.kind}>
            {outcome.kind === 'started' && outcome.runId && onOpenRun ? (
              <button
                type="button"
                onClick={() => onOpenRun(outcome.runId!)}
                className="rounded-sm text-secondary underline-offset-2 vy-transition hover:text-fg hover:underline focus-visible:vy-focus-ring"
              >
                Last run {relativeTimeAgo(outcome.at)}
              </button>
            ) : outcome.kind === 'started' ? (
              <span className="text-secondary">Last run {relativeTimeAgo(outcome.at)}</span>
            ) : outcome.kind === 'starting' ? (
              <span className="text-muted">
                Starting {relativeTimeAgo(outcome.at)}{outcome.detail ? `: ${outcome.detail}` : ''}
              </span>
            ) : outcome.kind === 'skipped' ? (
              <span className="text-warning">
                Skipped {relativeTimeAgo(outcome.at)}{outcome.detail ? `: ${outcome.detail}` : ''}
              </span>
            ) : (
              <span className="text-danger">
                Didn’t start {relativeTimeAgo(outcome.at)}{outcome.detail ? `: ${outcome.detail}` : ''}
              </span>
            )}
            {outcome.kind === 'started' && outcome.detail ? (
              <span className="text-muted">
                <span aria-hidden> · </span>
                {outcome.detail}
              </span>
            ) : null}
          </p>
        ) : null}
      </div>
      <span className="flex shrink-0 items-center gap-1">
        <Button size="xs" variant="ghost" icon="play" onClick={onRunNow}>
          Run now
        </Button>
        <IconButton icon="edit" label={`Edit schedule ${brief.slice(0, 60)}`} size="xs" tone="muted" onClick={onEdit} />
        <IconButton icon="trash" label={`Delete schedule ${brief.slice(0, 60)}`} size="xs" tone="muted" onClick={onDelete} />
      </span>
    </li>
  )
}
