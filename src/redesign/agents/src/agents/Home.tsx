import { useState } from 'react'
import { Icon } from '@renderer/lib/icons'
import { Button, DiffStat, IconButton, Keys, STATE_LABEL, Segmented, cn, type TaskState } from '@renderer/lib/ui'
import { ROW_HOVER } from '@renderer/lib/utils/layout'
import { WORKSPACES, type Agent } from './data'
import { Glyph, Label, PopMenu, StepMeter } from './parts'
import { isSettled } from './runtime'
import { useActions, useAgents } from './store'

/*
  All tasks, every workspace. One column of rows on a shared grid — glyph,
  task, workspace, progress, age, action — so each column can be read top to
  bottom. Grouped by what it needs from you by default, or by workspace. By
  status, a group says its state once, on its heading, and a row wears a
  glyph only when it stands some other way; by workspace, states mix, so
  every row keeps its own. The task list steps aside while this is open.
*/

const GROUPS: { id: string; label: string; states: TaskState[]; col: string; glyph?: TaskState }[] = [
  { id: 'needs', label: 'Needs you', states: ['needs'], col: 'Progress', glyph: 'needs' },
  { id: 'running', label: 'In progress', states: ['running', 'queued', 'paused'], col: 'Progress', glyph: 'running' },
  { id: 'review', label: 'Ready for review', states: ['review'], col: 'Checks', glyph: 'review' },
  { id: 'settled', label: 'Settled today', states: ['done', 'failed', 'stopped'], col: 'Outcome' }
]

const OUTCOME = { kept: 'Kept', undone: 'Undone', committed: 'Committed' } as const

const GRID = 'grid grid-cols-[16px_minmax(0,1fr)_96px_112px_32px_132px] items-center gap-x-3'

export function Home() {
  const { s, d } = useAgents()
  const [hidden, setHidden] = useState<string[]>([])
  const tasks = s.tasks.filter((t) => !t.archived && (!isSettled(t) || (t.day ?? 'Today') === 'Today'))
  const needs = tasks.filter((t) => t.state === 'needs').length
  const running = tasks.filter((t) => t.state === 'running').length

  const sections =
    s.homeGroup === 'status'
      ? GROUPS.filter((g) => !hidden.includes(g.id)).map((g) => ({ key: g.id, label: g.label, col: g.col, glyph: g.glyph, rows: tasks.filter((t) => g.states.includes(t.state)) }))
      : WORKSPACES.map((w) => ({
          key: w.name,
          label: w.name,
          col: 'Progress',
          glyph: undefined,
          rows: tasks.filter((t) => t.workspace === w.name && !hidden.includes(GROUPS.find((g) => g.states.includes(t.state))?.id ?? ''))
        }))

  return (
    <section aria-label="All tasks" className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-bg">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
        <h1 className="text-sm font-semibold text-fg-strong">All tasks</h1>
        <span className="text-caption text-tertiary">
          {needs} need you · {running} running · 2 workspaces
        </span>
        <span className="flex-1" />
        <Segmented
          label="Group by"
          value={s.homeGroup}
          onChange={(by) => d({ type: 'homeGroup', by })}
          items={[
            { id: 'status', label: 'Status' },
            { id: 'workspace', label: 'Workspace' }
          ]}
        />
        <PopMenu
          label="Show"
          align="end"
          items={GROUPS.map((g) => ({
            id: g.id,
            label: g.label,
            checked: !hidden.includes(g.id),
            keepOpen: true,
            onSelect: () => setHidden(hidden.includes(g.id) ? hidden.filter((x) => x !== g.id) : [...hidden, g.id])
          }))}
          trigger={(t, open) => (
            <span className="relative inline-flex">
              <IconButton
                ref={t.ref}
                icon="filter"
                label={hidden.length ? 'Show, filtered' : 'Show'}
                size="sm"
                tone="muted"
                active={open}
                aria-expanded={t['aria-expanded']}
                aria-controls={t['aria-controls']}
                aria-haspopup={t['aria-haspopup']}
                onClick={t.onClick}
              />
              {hidden.length ? <span className="pointer-events-none absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-accent" /> : null}
            </span>
          )}
        />
      </header>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[900px] px-6 pb-10 pt-6">
          <button
            type="button"
            onClick={() => d({ type: 'view', view: 'new' })}
            className="flex h-11 w-full items-center gap-2.5 rounded-[var(--vy-radius-xl)] border border-border bg-card px-3 text-left text-sm text-tertiary vy-transition hover:border-border-strong focus-visible:vy-focus-ring"
          >
            <Icon name="plus" size={15} />
            <span className="flex-1">Start a task…</span>
            <Keys keys={['Ctrl', 'N']} />
          </button>

          {sections.map((sec) =>
            sec.rows.length ? (
              <section key={sec.key} aria-label={sec.label} className="mt-7">
                <div className={cn(GRID, 'h-7 border-b border-border/60')}>
                  {sec.glyph ? <Glyph state={sec.glyph} /> : <span />}
                  {s.homeGroup === 'workspace' ? (
                    <span className="text-xs font-semibold text-fg-strong">
                      {sec.label} <span className="ml-1 font-mono font-normal tnum text-tertiary">{sec.rows.length}</span>
                    </span>
                  ) : (
                    <Label>
                      {sec.label} <span className="ml-1 font-mono tnum">{sec.rows.length}</span>
                    </Label>
                  )}
                  <Label>{s.homeGroup === 'workspace' ? 'State' : 'Workspace'}</Label>
                  <Label>{sec.col}</Label>
                  <Label className="text-right">Age</Label>
                  <span />
                </div>
                <ul>
                  {sec.rows.map((a) => (
                    <HomeRow key={a.id} a={a} byWorkspace={s.homeGroup === 'workspace'} glyph={s.homeGroup === 'workspace' || a.state !== sec.glyph} />
                  ))}
                </ul>
              </section>
            ) : null
          )}
        </div>
      </div>
    </section>
  )
}

function HomeRow({ a, byWorkspace, glyph }: { a: Agent; byWorkspace: boolean; glyph: boolean }) {
  const { s, d } = useAgents()
  const act = useActions()
  const waiting = a.state === 'needs' && a.ask?.kind === 'command' && !s.allowed[a.id]
  return (
    <li className={cn(GRID, 'group -mx-2 min-h-12 rounded-md px-2 py-2 vy-transition', ROW_HOVER)}>
      {glyph && !(a.state === 'done' && !byWorkspace) ? <Glyph state={a.state} /> : <span />}
      <button type="button" onClick={() => d({ type: 'open', agent: a.id })} className="min-w-0 rounded-sm text-left focus-visible:vy-focus-ring">
        <div className="truncate text-sm text-fg-strong">{a.title}</div>
        {waiting ? (
          <div className="truncate font-mono text-caption text-fg">
            <span className="text-tertiary">$ </span>
            {a.ask?.text}
          </div>
        ) : (
          <div className={cn('truncate text-xs', a.state === 'running' ? 'vy-text-live' : a.state === 'needs' ? 'text-accent' : a.state === 'failed' ? 'text-danger' : 'text-muted')}>{a.line}</div>
        )}
      </button>
      {byWorkspace ? <span className="truncate text-caption text-secondary">{STATE_LABEL[a.state]}</span> : <span className="truncate font-mono text-caption text-secondary">{a.workspace}</span>}
      <span className="flex items-center gap-2">
        {a.step && !isSettled(a) ? (
          <>
            <StepMeter at={a.step[0]} of={a.step[1]} state={a.state} className="w-14" />
            <span className="font-mono text-caption tnum text-tertiary">
              {a.step[0]}/{a.step[1]}
            </span>
          </>
        ) : null}
        {a.state === 'review' && a.checks ? (
          <span className="flex items-center gap-2 text-caption">
            {a.diff ? <DiffStat add={a.diff.add} del={a.diff.del} /> : null}
            <span className={cn('font-mono tnum', a.checks[0] < a.checks[1] ? 'text-warning' : 'text-tertiary')}>
              {a.checks[0]}/{a.checks[1]}
            </span>
          </span>
        ) : null}
        {isSettled(a) ? <span className="truncate text-caption text-tertiary">{a.outcome ? OUTCOME[a.outcome.kind] : STATE_LABEL[a.state]}</span> : null}
      </span>
      <span className="text-right font-mono text-caption tnum text-tertiary">{a.age}</span>
      <span className="flex justify-end gap-1">
        {waiting ? (
          <>
            <Button size="xs" variant="ghost" onClick={() => act.decide(a.id, 'denied')}>
              Deny
            </Button>
            <Button size="xs" variant="primary" onClick={() => act.decide(a.id, 'allowed')}>
              Allow
            </Button>
          </>
        ) : a.state === 'needs' ? (
          <Button size="xs" variant="primary" onClick={() => d({ type: 'open', agent: a.id })}>
            Answer
          </Button>
        ) : a.state === 'review' ? (
          <Button size="xs" variant="secondary" onClick={() => d({ type: 'open', agent: a.id })}>
            Review
          </Button>
        ) : a.state === 'failed' ? (
          <Button size="xs" variant="secondary" icon="retry" onClick={() => d({ type: 'resume', agent: a.id })}>
            Retry
          </Button>
        ) : a.state === 'running' ? (
          <span className="opacity-0 vy-transition group-hover:opacity-100 group-focus-within:opacity-100">
            <IconButton icon="stop" label={`Stop ${a.title}`} size="sm" tone="muted" onClick={() => act.stop(a.id)} />
          </span>
        ) : null}
      </span>
    </li>
  )
}
