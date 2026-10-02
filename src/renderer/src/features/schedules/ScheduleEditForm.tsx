import type { AgentInteractionMode, ModelRef } from '@shared/ipc'
import type { TaskSchedule, TaskScheduleUpdateRequest } from '@shared/ipc/schemas/schedules'
import { Segmented, Textarea } from '@renderer/lib/ui'
import { ScheduleFields, draftToSpec, specToDraft, type ScheduleDraft } from './ScheduleFields'
import { ScheduleRunFields } from './ScheduleRunFields'

/** A schedule while Edit has it: every field the row can't change on its own. */
export type ScheduleEdit = {
  instruction: string
  mode: AgentInteractionMode
  model: ModelRef | null
  worktree: boolean
  draft: ScheduleDraft
}

const MODES: ReadonlyArray<{ id: AgentInteractionMode; label: string }> = [
  { id: 'agent', label: 'Agent' },
  { id: 'ask', label: 'Ask' }
]

export function editFromSchedule(schedule: TaskSchedule): ScheduleEdit {
  return {
    instruction: schedule.instruction,
    mode: schedule.mode,
    model: schedule.provider && schedule.model ? { provider: schedule.provider, model: schedule.model } : null,
    worktree: Boolean(schedule.worktree),
    draft: specToDraft(schedule.schedule)
  }
}

/** The update to send, or why there is none yet. */
export function editToRequest(
  id: string,
  edit: ScheduleEdit
): { ok: true; request: TaskScheduleUpdateRequest } | { ok: false; error: string } {
  const instruction = edit.instruction.trim()
  if (!instruction) return { ok: false, error: 'Say what each run should do' }
  const when = draftToSpec(edit.draft)
  if (!when.ok) return when
  return {
    ok: true,
    request: {
      id,
      instruction,
      mode: edit.mode,
      provider: edit.model?.provider ?? null,
      model: edit.model?.model ?? null,
      worktree: edit.worktree,
      schedule: when.spec
    }
  }
}

/**
 * Edit on a scheduled task's row: the brief, Ask or Agent, when it runs, and
 * how each run starts — the same fields Repeat… asks, filled from the schedule.
 */
export function ScheduleEditForm({
  edit,
  onChange,
  error
}: {
  edit: ScheduleEdit
  onChange: (next: ScheduleEdit) => void
  error?: string | null
}) {
  const set = (partial: Partial<ScheduleEdit>): void => onChange({ ...edit, ...partial })
  return (
    <div className="flex flex-col gap-4" data-schedule-edit>
      <Textarea
        aria-label="Instruction"
        size="md"
        rows={4}
        value={edit.instruction}
        onChange={(e) => set({ instruction: e.target.value })}
      />
      <Segmented label="Mode" items={MODES} value={edit.mode} onChange={(mode) => set({ mode })} />
      <ScheduleFields draft={edit.draft} onChange={(draft) => set({ draft })} />
      <ScheduleRunFields
        model={edit.model}
        onModelChange={(model) => set({ model })}
        worktree={edit.worktree}
        onWorktreeChange={(worktree) => set({ worktree })}
        showWorktree
      />
      {error ? (
        <p role="alert" className="m-0 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  )
}
