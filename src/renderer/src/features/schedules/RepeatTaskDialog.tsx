import { useEffect, useRef, useState } from 'react'
import type { ModelRef } from '@shared/ipc'
import type { TaskScheduleSource } from '@shared/ipc/schemas/schedules'
import { describeSchedule } from '@shared/scheduleTime'
import { Dialog } from '@renderer/lib/a11y/Dialog'
import { Button, pushToast } from '@renderer/lib/ui'
import { DEFAULT_SCHEDULE_DRAFT, ScheduleFields, draftToSpec, type ScheduleDraft } from './ScheduleFields'
import { ScheduleRunFields } from './ScheduleRunFields'
import { onRepeatTaskRequest, requestScheduledTasks, type RepeatTaskRequest } from './scheduleRequests'

/**
 * Repeat… on a task's menu: run that task's brief again on a schedule, as a
 * new task each time. Main reads the brief, its checks and its mode from the
 * task's own record, so what repeats is what was typed, not the title. The
 * model it ran on, and whether it ran in a worktree of its own, start as
 * that task's and can be changed here.
 */
export function RepeatTaskDialog() {
  const [task, setTask] = useState<RepeatTaskRequest | null>(null)
  const [draft, setDraft] = useState<ScheduleDraft>(DEFAULT_SCHEDULE_DRAFT)
  const [source, setSource] = useState<TaskScheduleSource | null>(null)
  const [model, setModel] = useState<ModelRef | null>(null)
  const [worktree, setWorktree] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** The task the open dialog is for; a late answer about an earlier one is dropped. */
  const requestRef = useRef<RepeatTaskRequest | null>(null)

  useEffect(
    () =>
      onRepeatTaskRequest((next) => {
        requestRef.current = next
        setTask(next)
        setDraft(DEFAULT_SCHEDULE_DRAFT)
        setSource(null)
        setModel(null)
        setWorktree(false)
        setError(null)
        setSaving(false)
        const read = window.vyotiq?.scheduleSource
        if (!read) return
        void read(next.workspacePath, next.runId).then((res) => {
          if (requestRef.current !== next) return
          if (!res.ok) {
            setError(res.error)
            return
          }
          setSource(res.data)
          setModel(res.data.provider && res.data.model ? { provider: res.data.provider, model: res.data.model } : null)
          setWorktree(Boolean(res.data.worktreeBranch))
        })
      }),
    []
  )

  const close = (): void => {
    requestRef.current = null
    setTask(null)
  }
  const result = draftToSpec(draft)

  const save = async (): Promise<void> => {
    if (!task || !result.ok || saving) return
    setSaving(true)
    setError(null)
    const res = await window.vyotiq.createSchedule({
      workspacePath: task.workspacePath,
      fromRunId: task.runId,
      schedule: result.spec,
      // Until the task's record is read, main reads the same defaults itself.
      ...(source
        ? {
            provider: model?.provider ?? null,
            model: model?.model ?? null,
            ...(source.canWorktree ? { worktree } : {})
          }
        : {})
    })
    setSaving(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    close()
    pushToast(`Repeats: ${describeSchedule(res.data.schedule)}`, {
      kind: 'success',
      icon: 'repeat',
      action: { label: 'Scheduled tasks', onClick: () => void requestScheduledTasks() }
    })
  }

  return (
    <Dialog
      open={task != null}
      onClose={close}
      title="Repeat task"
      icon="repeat"
      size="md"
      footer={
        <>
          <span className="mr-auto text-xs text-muted">Runs while Agent V is open</span>
          <Button size="sm" variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" disabled={!result.ok || saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Repeat'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4" data-repeat-task>
        <p className="m-0 truncate text-sm text-fg" title={task?.title}>
          {task?.title}
        </p>
        <ScheduleFields draft={draft} onChange={setDraft} />
        {source ? (
          <ScheduleRunFields
            model={model}
            onModelChange={setModel}
            worktree={worktree}
            onWorktreeChange={setWorktree}
            showWorktree={source.canWorktree}
          />
        ) : null}
        {error ? (
          <p role="alert" className="m-0 text-xs text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  )
}
