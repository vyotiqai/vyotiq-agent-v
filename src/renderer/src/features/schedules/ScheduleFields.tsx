import { useId } from 'react'
import {
  SCHEDULE_INTERVAL_MIN_MINUTES,
  TaskScheduleSpecSchema,
  type TaskScheduleSpec
} from '@shared/ipc/schemas/schedules'
import { nextScheduleTime } from '@shared/scheduleTime'
import { Input, Segmented, cn } from '@renderer/lib/ui'

export type ScheduleKind = TaskScheduleSpec['kind']

/** What the fields hold while being edited; only a valid draft becomes a spec. */
export type ScheduleDraft = {
  kind: ScheduleKind
  time: string
  days: number[]
  minutes: string
  expr: string
}

export const DEFAULT_SCHEDULE_DRAFT: ScheduleDraft = {
  kind: 'daily',
  time: '09:00',
  days: [1, 2, 3, 4, 5],
  minutes: '60',
  expr: '0 9 * * 1-5'
}

const KINDS: ReadonlyArray<{ id: ScheduleKind; label: string }> = [
  { id: 'daily', label: 'Daily' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'interval', label: 'Every' },
  { id: 'cron', label: 'Cron' }
]

const DAYS: ReadonlyArray<{ day: number; short: string; long: string }> = [
  { day: 1, short: 'Mon', long: 'Monday' },
  { day: 2, short: 'Tue', long: 'Tuesday' },
  { day: 3, short: 'Wed', long: 'Wednesday' },
  { day: 4, short: 'Thu', long: 'Thursday' },
  { day: 5, short: 'Fri', long: 'Friday' },
  { day: 6, short: 'Sat', long: 'Saturday' },
  { day: 0, short: 'Sun', long: 'Sunday' }
]

export type DraftResult = { ok: true; spec: TaskScheduleSpec } | { ok: false; error: string }

export function draftToSpec(draft: ScheduleDraft): DraftResult {
  const candidate =
    draft.kind === 'daily'
      ? { kind: 'daily', time: draft.time }
      : draft.kind === 'weekly'
        ? { kind: 'weekly', days: draft.days, time: draft.time }
        : draft.kind === 'interval'
          ? { kind: 'interval', minutes: Number(draft.minutes) }
          : { kind: 'cron', expr: draft.expr }
  const parsed = TaskScheduleSpecSchema.safeParse(candidate)
  if (parsed.success) return { ok: true, spec: parsed.data }
  if (draft.kind === 'interval') return { ok: false, error: `At least every ${SCHEDULE_INTERVAL_MIN_MINUTES} minutes` }
  return { ok: false, error: parsed.error.issues[0]?.message ?? 'Not a schedule' }
}

/** A saved schedule back into the fields (Edit); the kinds it isn't keep the defaults. */
export function specToDraft(spec: TaskScheduleSpec): ScheduleDraft {
  const base = DEFAULT_SCHEDULE_DRAFT
  switch (spec.kind) {
    case 'daily':
      return { ...base, kind: 'daily', time: spec.time }
    case 'weekly':
      return { ...base, kind: 'weekly', days: [...spec.days], time: spec.time }
    case 'interval':
      return { ...base, kind: 'interval', minutes: String(spec.minutes) }
    case 'cron':
      return { ...base, kind: 'cron', expr: spec.expr }
  }
}

export function formatRunTime(date: Date): string {
  return date.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/**
 * When a task repeats: Daily / Weekly / Every N minutes / Cron, then the one
 * or two fields that kind needs, then when it would next run — or why it
 * can't. Times are this computer's local time.
 */
export function ScheduleFields({
  draft,
  onChange,
  now = new Date()
}: {
  draft: ScheduleDraft
  onChange: (next: ScheduleDraft) => void
  now?: Date
}) {
  const timeId = useId()
  const minutesId = useId()
  const cronId = useId()
  const result = draftToSpec(draft)
  const next = result.ok ? nextScheduleTime(result.spec, now) : null
  const set = (partial: Partial<ScheduleDraft>): void => onChange({ ...draft, ...partial })

  return (
    <div className="flex flex-col gap-3" data-schedule-fields>
      <Segmented label="Repeat" items={KINDS} value={draft.kind} onChange={(kind) => set({ kind })} />

      {draft.kind === 'weekly' ? (
        <div role="group" aria-label="Days" className="inline-flex w-fit items-center rounded-md bg-surface p-0.5">
          {DAYS.map(({ day, short, long }) => {
            const on = draft.days.includes(day)
            return (
              <button
                key={day}
                type="button"
                aria-pressed={on}
                aria-label={long}
                onClick={() => set({ days: on ? draft.days.filter((d) => d !== day) : [...draft.days, day] })}
                className={cn(
                  'inline-flex h-6 items-center rounded-[calc(var(--vy-radius-md)-2px)] px-2 text-xs font-medium vy-transition focus-visible:vy-focus-ring',
                  on ? 'bg-bg text-fg-strong shadow-[0_0_0_1px_var(--vy-border)]' : 'text-muted hover:text-fg'
                )}
              >
                {short}
              </button>
            )
          })}
        </div>
      ) : null}

      {draft.kind === 'daily' || draft.kind === 'weekly' ? (
        <div className="flex items-center gap-2">
          <label htmlFor={timeId} className="w-16 shrink-0 text-sm text-secondary">
            At
          </label>
          <div className="w-28">
            <Input id={timeId} type="time" size="sm" value={draft.time} onChange={(e) => set({ time: e.target.value })} />
          </div>
        </div>
      ) : null}

      {draft.kind === 'interval' ? (
        <div className="flex items-center gap-2">
          <label htmlFor={minutesId} className="w-16 shrink-0 text-sm text-secondary">
            Every
          </label>
          <div className="w-20">
            <Input
              id={minutesId}
              type="number"
              size="sm"
              mono
              min={SCHEDULE_INTERVAL_MIN_MINUTES}
              step={5}
              value={draft.minutes}
              onChange={(e) => set({ minutes: e.target.value })}
            />
          </div>
          <span className="text-sm text-secondary">minutes</span>
        </div>
      ) : null}

      {draft.kind === 'cron' ? (
        <div className="flex items-center gap-2">
          <label htmlFor={cronId} className="w-16 shrink-0 text-sm text-secondary">
            Cron
          </label>
          <div className="min-w-0 flex-1">
            <Input
              id={cronId}
              size="sm"
              mono
              spellCheck={false}
              placeholder="min hour day month weekday"
              value={draft.expr}
              onChange={(e) => set({ expr: e.target.value })}
            />
          </div>
        </div>
      ) : null}

      <p className="m-0 text-xs" data-schedule-preview aria-live="polite">
        {result.ok ? (
          next ? (
            <span className="text-muted">
              Next run <span className="text-fg">{formatRunTime(next)}</span>
            </span>
          ) : (
            <span className="text-danger">It never runs again</span>
          )
        ) : (
          <span className="text-danger">{result.error}</span>
        )}
      </p>
    </div>
  )
}
