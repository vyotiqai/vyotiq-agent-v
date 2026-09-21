import { useEffect, useState } from 'react'
import { Button, Input, Textarea, cn, pushToast } from '@renderer/lib/ui'
import { Dialog } from '@renderer/lib/a11y/Dialog'
import { MAX_DELEGATED_TASK_PROMPT_CHARS, type AgentProfile } from '@shared/ipc'
import type { EnqueueTaskOutcome } from '@renderer/lib/hooks/useDelegatedTasks'
import { workspaceLabel } from './teammatePresentation'

/**
 * Hand a teammate a brief, now or at a time you choose.
 *
 * One dialog for every surface that assigns work, so the cap, the counter and
 * the refusal message cannot drift between the pane and the sidebar.
 */

/**
 * `datetime-local` needs a local wall-clock minimum; `toISOString` would be
 * UTC and silently reject valid local times. Computed when the dialog opens,
 * because `Date.now()` is impure and must not run on every render.
 */
function scheduleMinLocal(): string {
  const now = new Date(Date.now() - 60_000)
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}T${two(
    now.getHours()
  )}:${two(now.getMinutes())}`
}

export function AssignTaskDialog({
  profile,
  workspacePath,
  onClose,
  onAssign
}: {
  /** Null closes the dialog; a profile opens it for that teammate. */
  profile: AgentProfile | null
  workspacePath: string | null
  onClose: () => void
  onAssign: (request: {
    profileId: string
    workspacePath: string
    prompt: string
    scheduledAt?: string
  }) => Promise<EnqueueTaskOutcome>
}) {
  const [prompt, setPrompt] = useState('')
  const [schedule, setSchedule] = useState('')
  const [scheduleMin, setScheduleMin] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!profile) return
    setPrompt('')
    setSchedule('')
    setScheduleMin(scheduleMinLocal())
  }, [profile])

  // The same measure the schema applies (trimmed), so the dialog and the IPC
  // validator agree; the counter only appears once a brief nears the cap.
  const length = prompt.trim().length
  const overLimit = length > MAX_DELEGATED_TASK_PROMPT_CHARS
  const showLength = length >= MAX_DELEGATED_TASK_PROMPT_CHARS * 0.8

  const submit = async (): Promise<void> => {
    const brief = prompt.trim()
    if (!profile || !workspacePath || !brief || saving || overLimit) return
    setSaving(true)
    try {
      const parsed = schedule ? Date.parse(schedule) : NaN
      const result = await onAssign({
        profileId: profile.id,
        workspacePath,
        prompt: brief,
        ...(Number.isNaN(parsed) ? {} : { scheduledAt: new Date(parsed).toISOString() })
      })
      if (result.ok) {
        pushToast(`Task assigned to ${profile.name}`)
        onClose()
      } else {
        // Main's reason ("Workspace is not open", a validation message) is the
        // only clue the user gets, and the dialog stays open so the brief the
        // user typed is not thrown away with it.
        pushToast(`Could not assign task — ${result.error}`, 'error')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={profile != null}
      onClose={onClose}
      title={profile ? `Assign task to ${profile.name}` : 'Assign task'}
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Task
          {/* Border on the wrapper — Textarea's own chrome is `border-none`
              and `cn` does not merge Tailwind classes, so a `border` appended
              to it sets a width against a style of none and draws nothing. */}
          <div
            className={cn(
              'rounded-md border border-border bg-surface px-2.5 py-1 vy-transition',
              overLimit ? 'border-danger' : 'focus-within:border-border-strong',
              'focus-within:vy-focus-ring'
            )}
          >
            <Textarea
              value={prompt}
              rows={5}
              className="max-h-60"
              placeholder="Research the top 5 competitor pricing pages and write a comparison into docs/pricing.md."
              aria-invalid={overLimit || undefined}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>
          {showLength ? (
            <span
              data-testid="task-prompt-length"
              aria-live="polite"
              className={cn('self-end text-2xs', overLimit ? 'text-danger' : 'text-muted')}
            >
              {length.toLocaleString()} / {MAX_DELEGATED_TASK_PROMPT_CHARS.toLocaleString()}
              {overLimit ? ' — too long to assign' : ''}
            </span>
          ) : null}
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted">
          Schedule (optional — starts at this time)
          <Input
            type="datetime-local"
            value={schedule}
            min={scheduleMin}
            onChange={(e) => setSchedule(e.target.value)}
          />
        </label>

        <p className="m-0 text-2xs text-muted">
          {workspacePath
            ? `Runs in ${workspaceLabel(workspacePath)} through the normal run path: you can steer it, approve tools, and get notified when it finishes.`
            : 'No workspace is open, so there is nowhere to run this yet.'}
        </p>

        <div className="flex items-center justify-end gap-2">
          <Button variant="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={!prompt.trim() || overLimit || !workspacePath || saving}
          >
            {schedule ? 'Schedule task' : 'Assign task'}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
