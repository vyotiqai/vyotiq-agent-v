import type { ReactNode } from 'react'
import { Icon, type IconName } from '@renderer/lib/icons'
import { Tooltip, cn, type TaskState } from '@renderer/lib/ui'
import { SECTION_LABEL } from '@renderer/lib/utils/layout'
import type { Task } from '../data'

/** One run step as a mark: done recedes, the live one breathes, queued is a stub. */
export const SEG: Record<TaskState, string> = {
  done: 'bg-muted',
  review: 'bg-muted',
  running: 'bg-accent rail-live',
  needs: 'bg-accent',
  queued: 'bg-border-strong',
  failed: 'bg-danger',
  stopped: 'bg-border-strong',
  paused: 'bg-border-strong'
}

/** A live task's run as one short bar per step: where it is, at a glance. */
export function StepDots({ task }: { task: Task }) {
  const states: TaskState[] = task.steps.length > 0 ? task.steps.map((st) => st.state) : ['done', 'running', 'queued']
  const at = states.findIndex((x) => x === 'running' || x === 'needs')
  return (
    <span className="flex shrink-0 items-center gap-[3px]" role="img" aria-label={`Step ${at + 1} of ${states.length}`}>
      {states.map((st, i) => (
        <span key={i} className={cn('h-2.5 w-[3px] rounded-[1px]', SEG[st])} />
      ))}
    </span>
  )
}

export const KEYS: Array<[string[], string]> = [
  [['Ctrl', 'K'], 'Search tasks, sheets and commands'],
  [['Alt', '←'], 'Previous sheet'],
  [['Alt', '→'], 'Next sheet'],
  [['Alt', 'Shift', '← →'], 'Move the sheet'],
  [['Alt', '[', ']'], 'Narrower · wider'],
  [['Alt', 'W'], 'Close the sheet'],
  [['Ctrl', 'L'], 'Focus the lens'],
  [['Alt', 'A'], 'Ask about the selection'],
  [['Ctrl', 'B'], 'Navigator: full or compact'],
  [['↵'], 'Steer: lands between steps'],
  [['Ctrl', '↵'], 'Queue: runs after the task'],
  [['?'], 'Start of a line: ask, change nothing'],
  [['$'], 'Start of a line, on the terminal: run it']
]

/*
  The few shapes every sheet is made of, so all of them share one grid:

  · one gutter — 16px, the same as the 40px header's text edge;
  · sections open with a 32px caps label;
  · list rows are 32px and bleed their hover fill 8px past the gutter
    (-mx-2 px-2), so the text stays on the gutter edge while the fill has room.
*/

export const GUTTER = 'px-4'
export const SCROLL = 'scroll-thin min-h-0 flex-1 overflow-y-auto'
export const ROW = 'flex h-8 items-center gap-2 -mx-2 px-2 rounded-md'

export function Section({
  label,
  count,
  note,
  action,
  children,
  flush = false
}: {
  label: string
  count?: ReactNode
  note?: ReactNode
  action?: ReactNode
  children: ReactNode
  /** No space above: the section opens its column. */
  flush?: boolean
}) {
  return (
    <section aria-label={label} className={flush ? '' : 'mt-6 first:mt-4'}>
      <h3 className={cn('m-0 flex h-8 items-center gap-2', SECTION_LABEL)}>
        <span>{label}</span>
        {count !== undefined ? <span className="font-mono font-normal tnum">{count}</span> : null}
        {note ? <span className="truncate font-normal normal-case tracking-normal">{note}</span> : null}
        {action ? (
          <>
            <span className="flex-1" />
            <span className="font-normal normal-case tracking-normal">{action}</span>
          </>
        ) : null}
      </h3>
      {children}
    </section>
  )
}

export function Empty({ icon, title, children }: { icon: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="grid flex-1 place-items-center px-8 py-10">
      <div className="max-w-[320px] text-center">
        <Icon name={icon} size={20} className="mx-auto text-muted" />
        <div className="mt-2 text-sm font-medium text-fg-strong">{title}</div>
        {children ? <div className="mt-1 text-xs text-secondary">{children}</div> : null}
      </div>
    </div>
  )
}

/** A figure with its caption under it: the stat strip's cell. */
export function Stat({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-caption text-tertiary">{label}</div>
      <div className="mt-0.5 font-mono text-title font-semibold text-fg-strong tnum">{value}</div>
      {note ? <div className="truncate text-caption text-tertiary">{note}</div> : null}
    </div>
  )
}

/**
 * One series of bars by day. Tops round, bottoms sit square on the baseline,
 * 2px apart; a zero day draws a stub. Today is ink, the rest recede. Every
 * bar names its value on hover; only the peak and today carry a label.
 */
export function DayBars({
  days,
  values,
  unit,
  height = 120,
  labelEvery = 1,
  format = (n: number) => String(n)
}: {
  days: readonly string[]
  values: readonly number[]
  unit: string
  height?: number
  /** Thin the day labels on a long range; every bar still names itself on hover. */
  labelEvery?: number
  format?: (n: number) => string
}) {
  const max = Math.max(1, ...values)
  const peak = values.indexOf(Math.max(...values))
  const last = values.length - 1
  const said = days.map((d, i) => `${d} ${format(values[i])} ${unit}`).join(', ')
  return (
    <div role="img" aria-label={said}>
      <div className="flex items-end gap-[2px]" style={{ height }}>
        {values.map((v, i) => {
          const h = v === 0 ? 2 : Math.max(4, Math.round((v / max) * (height - 20)))
          const label = (i === peak && v > 0) || i === last
          return (
            <Tooltip key={days[i]} content={`${days[i]} · ${format(v)} ${unit}`}>
              <button type="button" className="group flex h-full min-w-0 flex-1 cursor-default flex-col items-center justify-end rounded-sm focus-visible:vy-focus-ring" aria-label={`${days[i]} ${format(v)} ${unit}`}>
                {label ? <span className="mb-1 font-mono text-caption text-secondary tnum">{format(v)}</span> : null}
                <span
                  className={cn(
                    'w-full max-w-[56px] vy-transition',
                    v === 0 ? 'bg-border' : i === last ? 'rounded-t-[4px] bg-fg-strong' : 'rounded-t-[4px] bg-border-strong group-hover:bg-muted'
                  )}
                  style={{ height: h }}
                />
              </button>
            </Tooltip>
          )
        })}
      </div>
      <div className="mt-1.5 flex gap-[2px]" aria-hidden>
        {days.map((d, i) => (
          <span key={d} className={cn('min-w-0 flex-1 text-center font-mono text-caption', i === last ? 'text-fg' : 'text-tertiary')}>
            {i % labelEvery === 0 || i === last ? d : ''}
          </span>
        ))}
      </div>
    </div>
  )
}
