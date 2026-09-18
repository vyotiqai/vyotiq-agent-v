import { useEffect, useRef, useState } from 'react'
import { Icon } from '@renderer/lib/icons'
import { Dialog } from '@renderer/lib/a11y/Dialog'
import { Tooltip } from '@renderer/lib/ui/Tooltip'
import { pushToast } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/ui/cn'
import { SIDEBAR_INDENT, SIDEBAR_SECTION_LABEL } from '@renderer/lib/utils/layout'
import { useAgentProfiles } from '@renderer/lib/hooks/useAgentProfiles'
import { useDelegatedTasks } from '@renderer/lib/hooks/useDelegatedTasks'
import type { AgentProfile, DelegatedTask, DelegatedTaskStatus } from '@shared/ipc'

/**
 * Sidebar "Teammates" roster: persistent agent profiles. Rows start a new chat
 * bound to the teammate; inline create/edit dialogs manage identities.
 */

const ICON_BUTTON =
  'app-region-no-drag inline-grid size-6 place-items-center rounded text-muted vy-transition hover:bg-surface/50 hover:text-fg'

function ProfileFields({
  name,
  onNameChange,
  persona,
  onPersonaChange,
  identity,
  onIdentityChange,
  tone,
  onToneChange,
  autoResume,
  onAutoResumeChange,
  nameRef
}: {
  name: string
  onNameChange: (v: string) => void
  persona: string
  onPersonaChange: (v: string) => void
  identity: string
  onIdentityChange: (v: string) => void
  tone: string
  onToneChange: (v: string) => void
  autoResume: boolean
  onAutoResumeChange: (v: boolean) => void
  nameRef: React.RefObject<HTMLInputElement | null>
}) {
  return (
    <div className="flex min-w-80 flex-col gap-3 p-1">
      <label className="flex flex-col gap-1 text-xs text-muted">
        Name
        <input
          ref={nameRef}
          className="min-h-8 rounded-md border border-border bg-surface px-2 text-sm text-fg outline-none focus:border-accent"
          value={name}
          placeholder="Frontend Fixer"
          onChange={(e) => onNameChange(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Persona (what this teammate is)
        <textarea
          className="min-h-16 resize-y rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg outline-none focus:border-accent"
          value={persona}
          placeholder="A terse senior frontend engineer who never touches backend files."
          onChange={(e) => onPersonaChange(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Identity (long-term context it should remember)
        <textarea
          className="min-h-16 resize-y rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg outline-none focus:border-accent"
          value={identity}
          placeholder="Owns the design system. Prefers pnpm. Runs vitest before claiming done."
          onChange={(e) => onIdentityChange(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Tone (how it responds)
        <input
          className="min-h-8 rounded-md border border-border bg-surface px-2 text-sm text-fg outline-none focus:border-accent"
          value={tone}
          placeholder="Direct, no filler, code first."
          onChange={(e) => onToneChange(e.target.value)}
        />
      </label>
      <label className="flex items-center gap-2 text-xs text-fg">
        <input
          type="checkbox"
          checked={autoResume}
          onChange={(e) => onAutoResumeChange(e.target.checked)}
          className="size-3.5 accent-[var(--vy-accent)]"
        />
        Auto-resume interrupted runs at app launch
      </label>
    </div>
  )
}

const TASK_STATUS_LABEL: Record<DelegatedTaskStatus, string> = {
  queued: 'Queued',
  scheduled: 'Scheduled',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled'
}

const TASK_STATUS_COLOR: Record<DelegatedTaskStatus, string> = {
  queued: 'text-muted',
  scheduled: 'text-muted',
  running: 'text-accent',
  done: 'text-green-500',
  failed: 'text-danger',
  cancelled: 'text-muted'
}

/** Terminal tasks stop being interesting once newer ones exist. */
function visibleTasksForProfile(
  tasks: DelegatedTask[],
  profileId: string,
  workspacePath: string | null
): DelegatedTask[] {
  // Tasks are per-workspace on disk; the sidebar shows the active workspace's
  // queue — other workspaces' tasks belong to their own sidebar context.
  const own = tasks.filter(
    (t) => t.profileId === profileId && (!workspacePath || t.workspacePath === workspacePath)
  )
  const active = own.filter((t) => !isTerminalStatus(t.status))
  const finished = own
    .filter((t) => isTerminalStatus(t.status))
    .sort((a, b) => (b.finishedAt ?? b.createdAt).localeCompare(a.finishedAt ?? a.createdAt))
    .slice(0, 2)
  return [...active, ...finished].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

function isTerminalStatus(status: DelegatedTaskStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled'
}

export function TeammatesSection({
  onStartTeammateChat,
  onOpenTaskRun,
  activeWorkspacePath = null
}: {
  /** Start a new chat in the active workspace bound to this teammate. */
  onStartTeammateChat?: (profileId: string) => void
  /** Workspace new delegated tasks run against (the active one). */
  activeWorkspacePath?: string | null
  /** Open a task's session (run transcript) — the row is clickable when set. */
  onOpenTaskRun?: (workspacePath: string, runId: string) => void
}) {
  const { profiles, ready, createProfile, updateProfile, deleteProfile } = useAgentProfiles()
  const { tasks, enqueueTask, cancelTask } = useDelegatedTasks()
  const [taskDialog, setTaskDialog] = useState<{ profile: AgentProfile } | null>(null)
  const [taskPrompt, setTaskPrompt] = useState('')
  const [taskSchedule, setTaskSchedule] = useState('')
  const [taskScheduleMin, setTaskScheduleMin] = useState('')
  const [taskSaving, setTaskSaving] = useState(false)
  const [dialog, setDialog] = useState<{ mode: 'create' } | { mode: 'edit'; profile: AgentProfile } | null>(null)
  const [name, setName] = useState('')
  const [persona, setPersona] = useState('')
  const [identity, setIdentity] = useState('')
  const [tone, setTone] = useState('')
  const [autoResume, setAutoResume] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (dialog) nameInputRef.current?.focus()
  }, [dialog])

  // An armed delete confirmation disarms itself so a stale click can't fire later.
  useEffect(() => {
    if (!confirmDeleteId) return
    const timer = setTimeout(() => setConfirmDeleteId(null), 4_000)
    return () => clearTimeout(timer)
  }, [confirmDeleteId])

  const openCreate = (): void => {
    setName('')
    setPersona('')
    setIdentity('')
    setTone('')
    setAutoResume(false)
    setDialog({ mode: 'create' })
  }

  const openEdit = (profile: AgentProfile): void => {
    setName(profile.name)
    setPersona(profile.persona ?? '')
    setIdentity(profile.identity ?? '')
    setTone(profile.tone ?? '')
    setAutoResume(profile.autoResumeOnLaunch ?? false)
    setDialog({ mode: 'edit', profile })
  }

  const closeDialog = (): void => setDialog(null)

  const openTaskDialog = (profile: AgentProfile): void => {
    setTaskPrompt('')
    setTaskSchedule('')
    setTaskScheduleMin(computeScheduleMinLocal())
    setTaskDialog({ profile })
  }

  // datetime-local min in LOCAL wall-clock form (toISOString would be UTC).
  // Computed on dialog open — Date.now() is impure and must not run per render.
  function computeScheduleMinLocal(): string {
    const now = new Date(Date.now() - 60_000)
    const two = (n: number): string => String(n).padStart(2, '0')
    return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}T${two(
      now.getHours()
    )}:${two(now.getMinutes())}`
  }

  const submitTask = async (): Promise<void> => {
    const prompt = taskPrompt.trim()
    if (!taskDialog || !activeWorkspacePath || !prompt || taskSaving) return
    setTaskSaving(true)
    try {
      const parsed = taskSchedule ? Date.parse(taskSchedule) : NaN
      const created = await enqueueTask({
        profileId: taskDialog.profile.id,
        workspacePath: activeWorkspacePath,
        prompt,
        ...(Number.isNaN(parsed) ? {} : { scheduledAt: new Date(parsed).toISOString() })
      })
      if (created) {
        pushToast(`Task assigned to ${taskDialog.profile.name}`)
        setTaskDialog(null)
      } else {
        pushToast('Could not assign task')
      }
    } finally {
      setTaskSaving(false)
    }
  }

  const submit = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed || saving || !dialog) return
    setSaving(true)
    try {
      if (dialog.mode === 'create') {
        const created = await createProfile({
          name: trimmed,
          scope: 'global',
          ...(persona.trim() ? { persona: persona.trim() } : {}),
          ...(identity.trim() ? { identity: identity.trim() } : {}),
          ...(tone.trim() ? { tone: tone.trim() } : {}),
          ...(autoResume ? { autoResumeOnLaunch: true } : {})
        })
        if (created) {
          pushToast(`Teammate "${created.name}" created`)
          closeDialog()
        } else {
          pushToast('Could not create teammate')
        }
      } else {
        const updated = await updateProfile({
          id: dialog.profile.id,
          patch: {
            name: trimmed,
            autoResumeOnLaunch: autoResume,
            ...(persona.trim() ? { persona: persona.trim() } : { persona: undefined }),
            ...(identity.trim() ? { identity: identity.trim() } : { identity: undefined }),
            ...(tone.trim() ? { tone: tone.trim() } : { tone: undefined })
          }
        })
        if (updated) {
          pushToast(`Teammate "${updated.name}" updated`)
          closeDialog()
        } else {
          pushToast('Could not update teammate')
        }
      }
    } finally {
      setSaving(false)
    }
  }

  const remove = async (profile: AgentProfile): Promise<void> => {
    const ok = await deleteProfile(profile.id)
    setConfirmDeleteId(null)
    pushToast(ok ? `Teammate "${profile.name}" deleted` : 'Could not delete teammate')
  }

  return (
    <div className="mt-1" data-teammates-section>
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <p className={SIDEBAR_SECTION_LABEL}>Teammates</p>
        <Tooltip content="New teammate">
          <button type="button" className={ICON_BUTTON} aria-label="New teammate" onClick={openCreate}>
            <Icon name="plus" size={14} />
          </button>
        </Tooltip>
      </div>

      {profiles.length === 0 ? (
        <p className={cn(SIDEBAR_INDENT, 'm-0 pb-2 text-xs text-muted')}>
          {ready
            ? 'No teammates yet — persistent agents with their own memory.'
            : 'Loading teammates…'}
        </p>
      ) : (
        <div className="flex flex-col gap-0.5 pb-2">
          {profiles.map((profile) => {
            const ownTasks = visibleTasksForProfile(tasks, profile.id, activeWorkspacePath)
            return (
            <div key={profile.id}>
            <div
              className={cn(SIDEBAR_INDENT, 'group flex items-center gap-1.5 rounded-md pr-1 vy-transition hover:bg-surface/50')}
            >
              <button
                type="button"
                className="app-region-no-drag flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 text-left"
                onClick={() => onStartTeammateChat?.(profile.id)}
                title={onStartTeammateChat ? `New chat with ${profile.name}` : profile.name}
              >
                <span
                  className="grid size-5 shrink-0 place-items-center rounded bg-accent/15 text-2xs font-semibold text-accent"
                  aria-hidden
                >
                  {profile.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-fg">{profile.name}</span>
              </button>
              <span className="flex shrink-0 items-center gap-0.5 opacity-0 vy-transition group-hover:opacity-100">
                <Tooltip content={`Assign task to ${profile.name}`}>
                  <button
                    type="button"
                    className={ICON_BUTTON}
                    aria-label={`Assign task to ${profile.name}`}
                    disabled={!activeWorkspacePath}
                    onClick={() => openTaskDialog(profile)}
                  >
                    <Icon name="plus" size={12} />
                  </button>
                </Tooltip>
                <Tooltip content={`Edit ${profile.name}`}>
                  <button type="button" className={ICON_BUTTON} aria-label={`Edit ${profile.name}`} onClick={() => openEdit(profile)}>
                    <Icon name="edit" size={12} />
                  </button>
                </Tooltip>
                <Tooltip content={confirmDeleteId === profile.id ? 'Click again to confirm' : `Delete ${profile.name}`}>
                  <button
                    type="button"
                    className={cn(ICON_BUTTON, 'hover:!text-danger', confirmDeleteId === profile.id && '!text-danger')}
                    aria-label={confirmDeleteId === profile.id ? `Confirm delete ${profile.name}` : `Delete ${profile.name}`}
                    onClick={() => {
                      if (confirmDeleteId === profile.id) void remove(profile)
                      else setConfirmDeleteId(profile.id)
                    }}
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </Tooltip>
              </span>
            </div>
            {ownTasks.map((task) => (
              <div
                key={task.id}
                className={cn(SIDEBAR_INDENT, 'flex items-center gap-1.5 rounded-md py-0.5 pr-1')}
                data-delegated-task={task.status}
              >
                <span className={cn('shrink-0 text-2xs font-medium', TASK_STATUS_COLOR[task.status])}>
                  {TASK_STATUS_LABEL[task.status]}
                </span>
                {task.runId && onOpenTaskRun ? (
                  <button
                    type="button"
                    className="app-region-no-drag min-w-0 flex-1 truncate rounded text-left text-xs text-muted vy-transition hover:text-fg"
                    title={`Open session — ${task.prompt}`}
                    data-delegated-task-open
                    onClick={() => onOpenTaskRun(task.workspacePath, task.runId!)}
                  >
                    {task.prompt.split('\n')[0]}
                  </button>
                ) : (
                  <span className="min-w-0 flex-1 truncate text-xs text-muted" title={task.prompt}>
                    {task.prompt.split('\n')[0]}
                  </span>
                )}
                {!isTerminalStatus(task.status) ? (
                  <button
                    type="button"
                    className={ICON_BUTTON}
                    aria-label="Cancel task"
                    onClick={() => void cancelTask(task.id)}
                  >
                    <Icon name="close" size={12} />
                  </button>
                ) : null}
              </div>
            ))}
            </div>
            )
          })}
        </div>
      )}

      <Dialog
        open={taskDialog != null}
        onClose={() => setTaskDialog(null)}
        title={taskDialog ? `Assign task to ${taskDialog.profile.name}` : 'Assign task'}
      >
        <div className="flex min-w-80 flex-col gap-3 p-1">
          <label className="flex flex-col gap-1 text-xs text-muted">
            Task
            <textarea
              className="min-h-24 resize-y rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg outline-none focus:border-accent"
              value={taskPrompt}
              placeholder="Research the top 5 competitor pricing pages and write a comparison into docs/pricing.md."
              onChange={(e) => setTaskPrompt(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Schedule (optional — starts at this time)
            <input
              type="datetime-local"
              className="min-h-8 rounded-md border border-border bg-surface px-2 text-sm text-fg outline-none focus:border-accent"
              value={taskSchedule}
              min={taskScheduleMin}
              onChange={(e) => setTaskSchedule(e.target.value)}
            />
          </label>
          <p className="m-0 text-2xs text-muted">
            The task runs in {activeWorkspacePath ? 'the active workspace' : '— no active workspace'} through
            the normal run path: you can steer it, approve tools, and get notified when it finishes.
          </p>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              className="min-h-8 rounded-md border border-border px-3 text-xs text-fg vy-transition hover:bg-surface-2"
              onClick={() => setTaskDialog(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="min-h-8 rounded-md bg-accent px-3 text-xs font-medium text-fg vy-transition hover:opacity-90 disabled:opacity-50"
              disabled={!taskPrompt.trim() || !activeWorkspacePath || taskSaving}
              onClick={() => void submitTask()}
            >
              {taskSchedule ? 'Schedule task' : 'Assign task'}
            </button>
          </div>
        </div>
      </Dialog>
      <Dialog
        open={dialog != null}
        onClose={closeDialog}
        title={dialog?.mode === 'edit' ? `Edit ${dialog.profile.name}` : 'New teammate'}
      >
        <div className="flex flex-col gap-3">
          <ProfileFields
            name={name}
            onNameChange={setName}
            persona={persona}
            onPersonaChange={setPersona}
            identity={identity}
            onIdentityChange={setIdentity}
            tone={tone}
            onToneChange={setTone}
            autoResume={autoResume}
            onAutoResumeChange={setAutoResume}
            nameRef={nameInputRef}
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              className="min-h-8 rounded-md border border-border px-3 text-xs text-fg vy-transition hover:bg-surface-2"
              onClick={closeDialog}
            >
              Cancel
            </button>
            <button
              type="button"
              className="min-h-8 rounded-md bg-accent px-3 text-xs font-medium text-fg vy-transition hover:opacity-90 disabled:opacity-50"
              disabled={!name.trim() || saving}
              onClick={() => void submit()}
            >
              {dialog?.mode === 'edit' ? 'Save changes' : 'Create teammate'}
            </button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
