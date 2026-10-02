import { useRef, useState, type ReactNode } from 'react'
import { Icon, type IconName } from '@renderer/lib/icons'
import { DiffStat, IconButton, STATE_LABEL, StatusGlyph, cn } from '@renderer/lib/ui'
import { SECTION_LABEL, SELECTED, SIDEBAR_WIDTH_PX } from '@renderer/lib/utils/layout'
import { GROUPS, TASKS, type Task } from '../data'
import { StepDots } from './parts'
import { relRect, useRail, type Place } from './store'

/*
  The navigator keeps its status groups. A running task shows its run as one
  short bar per step, so progress reads without opening anything, and resting
  on a row peeks at the task (brief, where it is, checks) without leaving the
  one you are on.

  Below 1200px it folds to a 56px column of status glyphs — same order, same
  peek — so the rail keeps its width. Ctrl+B switches between the two.
*/

export const NAV_COMPACT_PX = 56

function Meta({ task }: { task: Task }) {
  if (task.group === 'running') return <StepDots task={task} />
  if (task.group === 'review' && task.meta.startsWith('+')) {
    const [a, b] = task.meta.split(' ')
    return <DiffStat add={Number(a.slice(1))} del={Number(b.slice(1))} />
  }
  return <span className={cn('font-mono text-caption tnum', task.group === 'needs' ? 'text-accent' : 'text-tertiary')}>{task.meta}</span>
}

type PeekAt = { task: Task; top: number; left: number }

function Peek({ at }: { at: PeekAt }) {
  const t = at.task
  const live = t.steps.findIndex((st) => st.state === 'running' || st.state === 'needs')
  const met = t.checks.filter((c) => c.met).length
  return (
    <div className="vy-menu pointer-events-none absolute z-dropdown w-[320px] animate-menu-in p-3" style={{ top: at.top, left: at.left }} role="tooltip">
      <div className="flex items-center gap-2">
        <StatusGlyph state={t.state} size={14} />
        <span className="text-caption text-secondary">{STATE_LABEL[t.state]}</span>
        <span className="flex-1" />
        <span className="font-mono text-caption text-tertiary tnum">{t.elapsed}</span>
      </div>
      <div className="mt-1.5 text-sm font-medium text-fg-strong">{t.title}</div>
      <p className="m-0 mt-1 line-clamp-2 text-xs text-secondary">{t.brief}</p>
      {t.steps.length > 0 ? (
        <div className="mt-2.5 space-y-0.5 border-t border-border/60 pt-2 text-xs">
          {live >= 0 ? (
            <div className="flex gap-2">
              <span className="w-12 shrink-0 text-tertiary">Now</span>
              <span className="min-w-0 flex-1 truncate text-fg">
                {live + 1}/{t.steps.length} · {t.steps[live].title}
              </span>
            </div>
          ) : null}
          {t.checks.length > 0 ? (
            <div className="flex gap-2">
              <span className="w-12 shrink-0 text-tertiary">Checks</span>
              <span className="font-mono text-fg tnum">
                {met}/{t.checks.length}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

const PLACES: Array<{ place: Exclude<Place, 'task' | 'new'>; icon: IconName; label: string }> = [
  { place: 'home', icon: 'home', label: 'Home' },
  { place: 'extensions', icon: 'extensions', label: 'Extensions' },
  { place: 'usage', icon: 'chart', label: 'Usage' }
]

export function Navigator() {
  const { s, d, root, wideNav } = useRail()
  const [peek, setPeek] = useState<PeekAt | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const width = wideNav ? SIDEBAR_WIDTH_PX : NAV_COMPACT_PX

  function enter(el: HTMLElement, task: Task): void {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const frame = root()
      if (!frame) return
      const r = relRect(el.getBoundingClientRect(), frame)
      setPeek({ task, top: Math.max(44, Math.min(r.top - 6, frame.offsetHeight - 200)), left: width + 8 })
    }, 450)
  }
  function leave(): void {
    window.clearTimeout(timer.current)
    setPeek(null)
  }

  const settingsOpen = s.sheets.some((x) => x.kind === 'settings')
  const foot = (place: (typeof PLACES)[number]): ReactNode => (
    <IconButton key={place.place} icon={place.icon} label={place.label} size="md" tone="muted" active={s.place === place.place} onClick={() => d({ type: 'place', place: place.place })} />
  )
  const gear = <IconButton icon="gear" label="Settings" size="md" tone="muted" active={settingsOpen} onClick={() => d({ type: 'open', kind: 'settings' })} />

  if (!wideNav) {
    return (
      <nav aria-label="Tasks" className="flex h-full shrink-0 flex-col items-center bg-chrome" style={{ width }}>
        <div className="flex h-10 w-full shrink-0 items-center justify-center border-b border-border">
          <IconButton icon="plus" label="New task" size="md" active={s.place === 'new'} onClick={() => d({ type: 'place', place: 'new' })} />
        </div>
        <div className="scroll-thin flex min-h-0 w-full flex-1 flex-col items-center overflow-y-auto pb-2" onPointerLeave={leave}>
          {GROUPS.map((g) => {
            const rows = TASKS.filter((t) => t.group === g.id)
            return (
              <div key={g.id} className="mt-2 flex w-full flex-col items-center gap-0.5 border-t border-border/60 pt-2 first:border-t-0" role="group" aria-label={g.label}>
                {rows.map((t) => {
                  const on = s.place === 'task' && t.id === s.taskId
                  return (
                    <button
                      key={t.id}
                      type="button"
                      aria-label={`${t.title}, ${STATE_LABEL[t.state]}`}
                      aria-current={on || undefined}
                      onClick={() => (leave(), d({ type: 'selectTask', id: t.id }))}
                      onPointerEnter={(e) => enter(e.currentTarget, t)}
                      onFocus={(e) => enter(e.currentTarget, t)}
                      onBlur={leave}
                      className={cn('relative grid size-8 place-items-center rounded-md vy-transition focus-visible:vy-focus-ring', on ? SELECTED : 'hover:bg-surface')}
                    >
                      <StatusGlyph state={t.state} size={14} />
                      {on ? <span className="absolute -left-3 top-2 h-4 w-0.5 rounded-full bg-accent" aria-hidden /> : null}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
        <div className="flex shrink-0 flex-col items-center gap-0.5 border-t border-border py-2">
          {PLACES.map(foot)}
          {gear}
        </div>
        {peek ? <Peek at={peek} /> : null}
      </nav>
    )
  }

  return (
    <nav aria-label="Tasks" className="flex h-full shrink-0 flex-col bg-chrome" style={{ width }}>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        <button type="button" className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-sm font-medium text-fg-strong vy-transition hover:bg-surface focus-visible:vy-focus-ring">
          <Icon name="workspace" size={15} className="text-muted" />
          <span className="min-w-0 truncate">VYOTIQ – AGENT V</span>
          <Icon name="chevron" size={11} className="shrink-0 text-tertiary" />
        </button>
        <IconButton icon="plus" label="New task" size="md" active={s.place === 'new'} onClick={() => d({ type: 'place', place: 'new' })} />
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2" onPointerLeave={leave}>
        {GROUPS.map((g) => {
          const rows = TASKS.filter((t) => t.group === g.id)
          return (
            <section key={g.id} className="mt-3">
              <h3 className={cn('m-0 flex h-6 items-center gap-1.5 px-2', SECTION_LABEL)}>
                {g.label}
                <span className="font-mono font-normal tnum">{rows.length}</span>
              </h3>
              <ul className="m-0 list-none space-y-px p-0">
                {rows.map((t) => {
                  const on = s.place === 'task' && t.id === s.taskId
                  return (
                    <li key={t.id}>
                      <button
                        type="button"
                        aria-current={on || undefined}
                        onClick={() => (leave(), d({ type: 'selectTask', id: t.id }))}
                        onPointerEnter={(e) => enter(e.currentTarget, t)}
                        onFocus={(e) => enter(e.currentTarget, t)}
                        onBlur={leave}
                        className={cn('flex h-8 w-full items-center gap-2 rounded-md px-2 text-left vy-transition focus-visible:vy-focus-ring', on ? SELECTED : 'hover:bg-surface')}
                      >
                        <StatusGlyph state={t.state} size={14} label />
                        <span className={cn('min-w-0 flex-1 truncate text-sm', on ? 'text-fg-strong' : t.group === 'done' ? 'text-secondary' : 'text-fg')}>{t.title}</span>
                        <Meta task={t} />
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}
      </div>
      <div className="flex h-10 shrink-0 items-center gap-0.5 border-t border-border px-2">
        {PLACES.map(foot)}
        <span className="flex-1" />
        {gear}
      </div>
      {peek ? <Peek at={peek} /> : null}
    </nav>
  )
}
