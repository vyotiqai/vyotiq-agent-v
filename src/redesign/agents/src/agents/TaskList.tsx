import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { Icon } from '@renderer/lib/icons'
import { Button, DiffStat, IconButton, STATE_LABEL, StatusGlyph, Tooltip, cn, pushToast, type ActionMenuItem, type TaskState } from '@renderer/lib/ui'
import { ROW_HOVER, SELECTED } from '@renderer/lib/utils/layout'
import { INSTANCES, RECENT_FOLDERS, WORKSPACES, type Agent } from './data'
import { Inbox, inboxCount } from './Inbox'
import { PopMenu, StepMeter } from './parts'
import { diffsOf, isSettled, totals, visibleTasks } from './runtime'
import { useActions, useAgents, type Scope } from './store'

/*
  The task list, in the navigator's anatomy: status groups, the title, and a
  second line that says what the task is doing now. A group says its state
  once, on its heading, so its rows don't repeat it; a row wears a glyph only
  when it stands some other way (queued, paused, failed, stopped), and that
  glyph hangs on the right, before the age, in the same column as the
  heading's. Every title, heading and place shares one left edge. Needs you
  is first, and a waiting command can be allowed from the row; a running row
  carries its step count; instances hang under their task.
*/

const GROUPS: { id: string; label: string; states: TaskState[] }[] = [
  { id: 'needs', label: 'Needs you', states: ['needs'] },
  { id: 'running', label: 'In progress', states: ['running', 'queued', 'paused'] },
  { id: 'review', label: 'Ready for review', states: ['review'] }
]

/** Rows under Pinned and the days are history: a plain done row is bare. */
const SETTLED_EXCEPTION: TaskState[] = ['failed', 'stopped']

export const LIST_W = 272
export const LIST_COMPACT_W = 56

type Hover = { id: string; top: number } | null

export function TaskList() {
  const { s, d } = useAgents()
  const nav = useRef<HTMLElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [hover, setHover] = useState<Hover>(null)
  const tasks = visibleTasks(s)
  const scopes: string[] = s.scope === 'all' ? WORKSPACES.map((w) => w.name) : [s.scope]

  // Opening a task from anywhere (Alt ↓, the palette, Home) brings its row into view.
  useEffect(() => {
    scroller.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [s.agent, s.view, s.scope])

  // Any press hides the card: it answers "what is this?", not "what did I just do?".
  useEffect(() => {
    const hide = (): void => {
      if (timer.current) clearTimeout(timer.current)
      setHover(null)
    }
    window.addEventListener('mousedown', hide)
    return () => window.removeEventListener('mousedown', hide)
  }, [])

  const onHover = (id: string | null, el?: HTMLElement): void => {
    if (timer.current) clearTimeout(timer.current)
    if (!id || !el || !nav.current) return setHover(null)
    timer.current = setTimeout(() => {
      const n = nav.current!.getBoundingClientRect()
      const scale = n.height / nav.current!.offsetHeight || 1
      setHover({ id, top: (el.getBoundingClientRect().top - n.top) / scale })
    }, 500)
  }

  return (
    <nav ref={nav} aria-label="Tasks" className="relative flex h-full min-h-0 flex-col bg-chrome" style={{ width: LIST_W }}>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/60 pl-4 pr-2">
        <ScopeMenu />
        <span className="flex-1" />
        <Tooltip content="New task (Ctrl+N)" describeChild={false}>
          <Button size="xs" variant="secondary" icon="plus" onClick={() => d({ type: 'view', view: 'new' })}>
            New task
          </Button>
        </Tooltip>
      </div>

      <div ref={scroller} className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3 [scrollbar-gutter:stable]" onScroll={() => onHover(null)}>
        {scopes.map((ws, i) => {
          const mine = tasks.filter((t) => t.workspace === ws)
          return (
            <div key={ws} className={i ? 'mt-3 border-t border-border/60' : ''}>
              {s.scope === 'all' ? <h2 className="flex h-9 items-end px-2 pb-1 text-xs font-semibold text-fg-strong">{ws}</h2> : null}
              <Groups tasks={mine} onHover={onHover} />
            </div>
          )
        })}
        {tasks.length === 0 ? <div className="px-2 py-8 text-center text-xs text-tertiary">No tasks here yet.</div> : null}
      </div>

      <Places />
      {hover ? <HoverCard id={hover.id} top={hover.top} /> : null}
    </nav>
  )
}

function Groups({ tasks, onHover }: { tasks: Agent[]; onHover: (id: string | null, el?: HTMLElement) => void }) {
  const { s } = useAgents()
  const settled = tasks.filter(isSettled)
  const pinned = settled.filter((t) => t.pinned)
  const days = (['Today', 'Yesterday'] as const).map((day) => ({ day, rows: settled.filter((t) => !t.pinned && (t.day ?? 'Today') === day) }))
  const on = (id: string): boolean => s.view === 'agent' && s.agent === id
  const hoverProps = (id: string) => ({
    onMouseEnter: (e: MouseEvent<HTMLLIElement>) => onHover(id, e.currentTarget),
    onMouseLeave: () => onHover(null)
  })
  return (
    <>
      {GROUPS.map((g) => {
        const rows = tasks.filter((t) => g.states.includes(t.state))
        if (!rows.length) return null
        return (
          <Section key={g.id} label={g.label} count={rows.length} glyph={g.states[0]}>
            {rows.map((a) => (
              <li key={a.id} {...hoverProps(a.id)}>
                <Row a={a} on={on(a.id)} exception={a.state !== g.states[0]} />
              </li>
            ))}
          </Section>
        )
      })}
      {pinned.length ? (
        <Section label="Pinned" count={pinned.length}>
          {pinned.map((a) => (
            <li key={a.id} {...hoverProps(a.id)}>
              <SettledRow a={a} on={on(a.id)} />
            </li>
          ))}
        </Section>
      ) : null}
      {days.map(({ day, rows }) =>
        rows.length ? (
          <Section key={day} label={day} count={rows.length}>
            {rows.map((a) => (
              <li key={a.id} {...hoverProps(a.id)}>
                <SettledRow a={a} on={on(a.id)} />
              </li>
            ))}
          </Section>
        ) : null
      )}
    </>
  )
}

/** A group's heading says its state once: the glyph sits in the rows' glyph column, the count on their age edge. */
function Section({ label, count, glyph, children }: { label: string; count: number; glyph?: TaskState; children: ReactNode }) {
  return (
    <section aria-label={label} className="pt-2">
      <h3 className="flex h-7 items-center gap-2 px-2 text-xs font-medium text-muted">
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {glyph ? <StatusGlyph state={glyph} size={14} /> : null}
        <span className="min-w-[3ch] shrink-0 text-right font-mono text-caption font-normal tnum text-tertiary">{count}</span>
      </h3>
      <ul>{children}</ul>
    </section>
  )
}

function ScopeMenu() {
  const { s, d } = useAgents()
  const items: ActionMenuItem[] = [
    ...WORKSPACES.map((w) => ({ id: w.name, label: w.name, checked: s.scope === w.name, onSelect: () => d({ type: 'scope', scope: w.name as Scope }) })),
    { id: 'all', label: 'All workspaces', checked: s.scope === 'all', onSelect: () => d({ type: 'scope', scope: 'all' }) },
    ...RECENT_FOLDERS.map((f, i) => ({
      id: f.name,
      label: `${f.name} · ${f.path}`,
      heading: i === 0 ? 'Recent' : undefined,
      separatorBefore: i === 0,
      onSelect: () => pushToast(`Opened ${f.name}`, { icon: 'workspace' })
    })),
    { id: 'open', label: 'Open folder…', icon: 'folderOpen', separatorBefore: true, onSelect: () => undefined }
  ]
  return (
    <PopMenu
      label="Workspace"
      items={items}
      trigger={(t, open) => (
        <button
          ref={t.ref}
          type="button"
          aria-expanded={t['aria-expanded']}
          aria-controls={t['aria-controls']}
          aria-haspopup={t['aria-haspopup']}
          onClick={t.onClick}
          className={cn(
            '-ml-1.5 inline-flex h-7 min-w-0 items-center gap-1 rounded-md px-1.5 text-sm font-semibold text-fg-strong vy-transition focus-visible:vy-focus-ring',
            open ? 'bg-surface-2' : 'hover:bg-surface'
          )}
        >
          <span className="truncate">{s.scope === 'all' ? 'All workspaces' : s.scope}</span>
          <Icon name="chevron" size={11} className="text-tertiary" />
        </button>
      )}
    />
  )
}

/** What you can do to a task without opening it; the header's ⋯ offers the same. */
export function useTaskMenu(a: Agent): ActionMenuItem[] {
  const { d } = useAgents()
  const act = useActions()
  const live = a.state === 'running' || a.state === 'needs'
  const items: ActionMenuItem[] = [
    {
      id: 'pin',
      label: a.pinned ? 'Unpin' : 'Pin',
      icon: 'pin',
      disabled: !isSettled(a),
      disabledReason: 'Pin a task once it has settled',
      onSelect: () => d({ type: 'pin', agent: a.id })
    },
    { id: 'fork', label: 'Fork into a new task', icon: 'fork', onSelect: () => (d({ type: 'view', view: 'new' }), d({ type: 'draft', text: `Carry on from “${a.title}”: ` })) }
  ]
  if (live) items.push({ id: 'stop', label: 'Stop', icon: 'stop', onSelect: () => act.stop(a.id) })
  if (a.state === 'stopped') items.push({ id: 'resume', label: 'Resume', icon: 'play', onSelect: () => d({ type: 'resume', agent: a.id }) })
  if (a.state === 'failed') items.push({ id: 'retry', label: 'Retry', icon: 'retry', onSelect: () => d({ type: 'resume', agent: a.id }) })
  items.push({
    id: 'archive',
    label: 'Archive',
    icon: 'archive',
    separatorBefore: true,
    disabled: !isSettled(a),
    disabledReason: 'Stop it or let it finish first',
    onSelect: () => act.archive(a.id)
  })
  return items
}

function RowMenu({ a }: { a: Agent }) {
  const items = useTaskMenu(a)
  return (
    <PopMenu
      label={`${a.title}: actions`}
      items={items}
      align="end"
      trigger={(t, open) => (
        <IconButton
          ref={t.ref}
          icon="more"
          label="Actions"
          size="xs"
          tone="muted"
          active={open}
          aria-expanded={t['aria-expanded']}
          aria-controls={t['aria-controls']}
          aria-haspopup={t['aria-haspopup']}
          onClick={t.onClick}
        />
      )}
    />
  )
}

function Row({ a, on, exception }: { a: Agent; on: boolean; exception: boolean }) {
  const { s, d } = useAgents()
  const act = useActions()
  const waitingCommand = a.state === 'needs' && a.ask?.kind === 'command' && !s.allowed[a.id]
  const instances = a.id === 'audit-auth' && a.state === 'running'
  const [fold, setFold] = useState(true)

  return (
    <div className={cn('group relative rounded-md vy-transition', on ? SELECTED : ROW_HOVER)}>
      <button
        type="button"
        aria-current={on || undefined}
        onClick={() => d({ type: 'open', agent: a.id })}
        className="absolute inset-0 rounded-md focus-visible:vy-focus-ring"
        aria-label={`${a.title}, ${STATE_LABEL[a.state].toLowerCase()}`}
      />
      <div className="pointer-events-none relative flex px-2 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={cn('min-w-0 flex-1 truncate text-sm', a.unread || on ? 'text-fg-strong' : 'text-fg')}>{a.title}</span>
            {a.unread ? <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-label="Unread" /> : null}
            {exception ? <StatusGlyph state={a.state} size={14} /> : null}
            <span className="min-w-[3ch] shrink-0 text-right font-mono text-caption tnum text-tertiary group-hover:invisible group-focus-within:invisible">{a.age}</span>
          </div>

          {a.state === 'running' ? (
            <div className="mt-0.5 flex items-center gap-2">
              {instances ? (
                <button
                  type="button"
                  aria-expanded={fold}
                  onClick={() => setFold(!fold)}
                  className="pointer-events-auto flex min-w-0 flex-1 items-center gap-1 rounded-sm text-left text-xs focus-visible:vy-focus-ring"
                >
                  <span className="vy-text-live min-w-0 truncate">{a.line}</span>
                  <Icon name={fold ? 'chevron' : 'chevronRight'} size={10} className="shrink-0 text-tertiary" />
                </button>
              ) : (
                <span className="vy-text-live min-w-0 flex-1 truncate text-xs">{a.line}</span>
              )}
              {a.step ? (
                <span className="shrink-0 font-mono text-caption tnum text-tertiary">
                  {a.step[0]}/{a.step[1]}
                </span>
              ) : null}
            </div>
          ) : null}

          {a.state === 'needs' && !waitingCommand ? <div className="mt-0.5 truncate text-xs text-accent">{a.line}</div> : null}

          {waitingCommand ? (
            <div className="mt-1 flex min-w-0 items-center gap-1.5 rounded-sm bg-sunken px-1.5 py-0.5 font-mono text-caption text-fg">
              <span className="text-tertiary">$</span>
              <span className="min-w-0 truncate">{a.ask?.text}</span>
            </div>
          ) : null}

          {a.state === 'review' ? (
            <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
              {a.diff ? <DiffStat add={a.diff.add} del={a.diff.del} /> : null}
              {a.checks ? (
                <span className={a.checks[0] < a.checks[1] ? 'text-warning' : 'text-muted'}>
                  <span aria-hidden>· </span>
                  {a.checks[0]}/{a.checks[1]} checks
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <span className="absolute right-1.5 top-1.5 opacity-0 vy-transition group-hover:opacity-100 group-focus-within:opacity-100">
        <RowMenu a={a} />
      </span>

      {waitingCommand ? (
        <div className="relative flex items-center gap-1 pb-2 pl-2 pr-2">
          <Button size="xs" variant="primary" onClick={() => act.decide(a.id, 'allowed')}>
            Allow
          </Button>
          <Button size="xs" variant="ghost" onClick={() => act.decide(a.id, 'denied')}>
            Deny
          </Button>
        </div>
      ) : null}

      {instances ? <Instances open={fold} /> : null}
    </div>
  )
}

/** One line per instance under its task; the task's second line folds them. */
function Instances({ open }: { open: boolean }) {
  const { s, d } = useAgents()
  return (
    <div className="relative pb-1.5 pl-2 pr-2">
      <div className="ag-fold" data-open={open}>
        <ul className="relative ml-[3px] border-l border-border pl-2">
          {INSTANCES.map((i) => (
            <li key={i.id}>
              <button
                type="button"
                aria-current={(s.view === 'agent' && s.instance === i.id) || undefined}
                onClick={() => (d({ type: 'open', agent: 'audit-auth' }), d({ type: 'instance', id: i.id }))}
                className="flex h-6 w-full min-w-0 items-center gap-2 rounded-sm px-1 text-left text-caption vy-transition hover:bg-surface-2 focus-visible:vy-focus-ring"
              >
                <StatusGlyph state={i.state} size={11} />
                <span className={cn('shrink-0 font-mono', s.instance === i.id ? 'text-fg-strong' : 'text-secondary')}>{i.title.split('/').pop()}</span>
                <span className={cn('min-w-0 truncate', i.state === 'running' ? 'vy-text-live' : 'text-tertiary')}>{i.verb}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function SettledRow({ a, on }: { a: Agent; on: boolean }) {
  const { d } = useAgents()
  const exception = SETTLED_EXCEPTION.includes(a.state)
  return (
    <div className={cn('group relative flex h-8 items-center rounded-md vy-transition', on ? SELECTED : ROW_HOVER)}>
      <button
        type="button"
        aria-current={on || undefined}
        onClick={() => d({ type: 'open', agent: a.id })}
        className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left focus-visible:vy-focus-ring"
      >
        <span className={cn('min-w-0 flex-1 truncate text-sm', on ? 'text-fg-strong' : 'text-secondary')}>{a.title}</span>
        {exception ? <StatusGlyph state={a.state} size={14} /> : null}
        <span className="min-w-[3ch] shrink-0 text-right font-mono text-caption tnum text-tertiary group-hover:invisible group-focus-within:invisible">{a.age}</span>
      </button>
      <span className="absolute right-1.5 opacity-0 vy-transition group-hover:opacity-100 group-focus-within:opacity-100">
        <RowMenu a={a} />
      </span>
    </div>
  )
}

/** Beside the list after half a second of hover: the facts a row has no room for. */
function HoverCard({ id, top }: { id: string; top: number }) {
  const { s } = useAgents()
  const a = s.tasks.find((t) => t.id === id)
  if (!a || a.archived) return null
  const diffs = diffsOf(s, id)
  const sum = totals(diffs)
  const rows: [string, ReactNode][] = [
    [
      'State',
      <span key="s" className="inline-flex items-center gap-1.5">
        <StatusGlyph state={a.state} size={12} />
        {STATE_LABEL[a.state]}
      </span>
    ],
    [
      'Where',
      <span key="w" className="font-mono">
        {a.workspace}
        {a.worktree ? ` · ${a.branch}` : ''}
      </span>
    ]
  ]
  if (a.step && !isSettled(a))
    rows.push([
      'Plan',
      <span key="p" className="flex items-center gap-2">
        <StepMeter at={a.step[0]} of={a.step[1]} state={a.state} className="w-16" />
        <span className="font-mono tnum">
          {a.step[0]}/{a.step[1]}
        </span>
      </span>
    ])
  if (diffs.length)
    rows.push([
      'Files',
      <span key="f" className="inline-flex items-center gap-2">
        <span className="font-mono tnum">{diffs.length}</span>
        <DiffStat add={sum.add} del={sum.del} />
      </span>
    ])
  if (a.checks)
    rows.push([
      'Checks',
      <span key="k" className={cn('font-mono tnum', a.checks[0] < a.checks[1] ? 'text-warning' : 'text-fg')}>
        {a.checks[0]}/{a.checks[1]} met
      </span>
    ])
  rows.push(['Spent', <span key="c" className="font-mono tnum">{`${a.cost} · ${a.model}`}</span>])
  rows.push(['Updated', <span key="u" className="font-mono tnum">{a.age === 'now' ? 'just now' : `${a.age} ago`}</span>])
  return (
    <div role="tooltip" className="vy-menu pointer-events-none absolute z-dropdown w-[280px] animate-menu-in p-3" style={{ left: LIST_W + 6, top: Math.max(8, top) }}>
      <div className="mb-2 text-sm font-medium text-fg-strong">{a.title}</div>
      <dl className="grid grid-cols-[64px_1fr] gap-x-3 gap-y-1.5 text-caption">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-tertiary">{k}</dt>
            <dd className="min-w-0 truncate text-fg">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function Places() {
  const { s, d } = useAgents()
  const unread = inboxCount(s)
  return (
    <div role="group" aria-label="Places" className="relative flex h-10 shrink-0 items-center gap-0.5 border-t border-border/60 pl-2.5 pr-2">
      <IconButton icon="home" label="All tasks" size="md" tone="muted" active={s.view === 'home'} onClick={() => d({ type: 'view', view: 'home' })} />
      <span className="relative">
        <IconButton icon="inbox" label={unread ? `Inbox · ${unread} new` : 'Inbox'} size="md" tone="muted" active={s.inbox} data-popover-trigger onClick={() => d({ type: 'inbox', open: !s.inbox })} />
        {unread ? <span className="pointer-events-none absolute right-1 top-1 size-1.5 rounded-full bg-accent" /> : null}
      </span>
      <IconButton icon="extensions" label="Extensions" size="md" tone="muted" active={s.view === 'extensions'} onClick={() => d({ type: 'view', view: 'extensions' })} />
      <IconButton icon="chart" label="Usage" size="md" tone="muted" active={s.view === 'usage'} onClick={() => d({ type: 'view', view: 'usage' })} />
      <span className="flex-1" />
      <IconButton icon="gear" label="Settings (Ctrl+,)" size="md" tone="muted" active={s.view === 'settings'} onClick={() => d({ type: 'view', view: 'settings' })} />
      {s.inbox ? <Inbox anchor="list" /> : null}
    </div>
  )
}

/**
 * Under 1200px: one glyph per active task, same order, same groups. On All
 * tasks the page is the list, so the rail keeps only New task and the places.
 */
export function TaskListCompact({ tasks = true }: { tasks?: boolean }) {
  const { s, d } = useAgents()
  const active = tasks ? visibleTasks(s).filter((a) => !isSettled(a)) : []
  const unread = inboxCount(s)
  return (
    <nav aria-label="Tasks" className="relative flex h-full min-h-0 flex-col items-center bg-chrome" style={{ width: LIST_COMPACT_W }}>
      <div className="flex h-10 w-full shrink-0 items-center justify-center border-b border-border/60">
        <IconButton icon="plus" label="New task (Ctrl+N)" size="md" onClick={() => d({ type: 'view', view: 'new' })} />
      </div>
      <ul className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto py-2">
        {active.map((a, i) => {
          const prev = active[i - 1]
          const gap = prev && GROUPS.findIndex((g) => g.states.includes(prev.state)) !== GROUPS.findIndex((g) => g.states.includes(a.state))
          return (
            <li key={a.id} className={gap ? 'mt-2 border-t border-border/60 pt-3' : ''}>
              <Tooltip content={`${a.title} · ${a.line}`} describeChild={false}>
                <button
                  type="button"
                  aria-label={a.title}
                  aria-current={(s.view === 'agent' && s.agent === a.id) || undefined}
                  onClick={() => d({ type: 'open', agent: a.id })}
                  className={cn('grid size-9 place-items-center rounded-md vy-transition focus-visible:vy-focus-ring', s.agent === a.id && s.view === 'agent' ? SELECTED : ROW_HOVER)}
                >
                  <StatusGlyph state={a.state} size={16} />
                </button>
              </Tooltip>
            </li>
          )
        })}
      </ul>
      <div className="relative flex w-full shrink-0 flex-col items-center gap-0.5 border-t border-border/60 py-1.5">
        {/* The same places, in the same order, as the wide list's foot. */}
        <IconButton icon="home" label="All tasks" size="md" tone="muted" active={s.view === 'home'} onClick={() => d({ type: 'view', view: 'home' })} />
        <span className="relative">
          <IconButton icon="inbox" label={unread ? `Inbox · ${unread} new` : 'Inbox'} size="md" tone="muted" active={s.inbox} data-popover-trigger onClick={() => d({ type: 'inbox', open: !s.inbox })} />
          {unread ? <span className="pointer-events-none absolute right-1 top-1 size-1.5 rounded-full bg-accent" /> : null}
        </span>
        <IconButton icon="extensions" label="Extensions" size="md" tone="muted" active={s.view === 'extensions'} onClick={() => d({ type: 'view', view: 'extensions' })} />
        <IconButton icon="chart" label="Usage" size="md" tone="muted" active={s.view === 'usage'} onClick={() => d({ type: 'view', view: 'usage' })} />
        <IconButton icon="gear" label="Settings (Ctrl+,)" size="md" tone="muted" onClick={() => d({ type: 'view', view: 'settings' })} />
        {s.inbox ? <Inbox anchor="compact" /> : null}
      </div>
    </nav>
  )
}
