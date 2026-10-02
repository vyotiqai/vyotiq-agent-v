import { useRef, useState } from 'react'
import { Icon } from '@renderer/lib/icons'
import {
  Badge,
  Button,
  Checkbox,
  DiffStat,
  FormGroup,
  FormRow,
  Keys,
  Menu,
  ProgressBar,
  RadioList,
  Segmented,
  StatusGlyph,
  Switch,
  cn
} from '@renderer/lib/ui'
import { SELECTED } from '@renderer/lib/utils/layout'
import { EXTENSIONS, MODEL_MIX, TASKS, TOOL_FAILURES, WEEK, WORKSPACES, type Task } from '../data'
import { Lens } from './Lens'
import { DayBars, Empty, GUTTER, KEYS, ROW, SCROLL, Section, Stat, StepDots } from './parts'
import { SKINS, SNAP_LABEL, useRail, type Skin } from './store'

/*
  Places fill the whole work area: a new task, Home, Usage, Extensions.
  Settings is the one exception — a sheet that opens beside your work.
  Everything sits on the same 16px gutter as the sheets; wide places use a
  container query to go from one column to two instead of stretching.
*/

/* ─── New task ────────────────────────────────────────────────────────────── */

const NEW_TASK: Task = {
  id: 'new',
  title: 'New task',
  state: 'queued',
  group: 'running',
  meta: '',
  elapsed: '',
  brief: '',
  checks: [],
  steps: [],
  files: []
}

const PROPOSED = [
  { text: 'Picking a file or folder from @ inserts a chip', from: 'from your brief' },
  { text: 'Both menus stay inside the window at 800 and 1600px', from: 'from your brief' },
  { text: 'Both menus use only menu primitives and theme tokens', from: 'from CLAUDE.md' },
  { text: 'Tests in tests/renderer/composer pass', from: 'added' }
]

const FACTS = [
  { k: 'Branch', v: 'main', m: '152 changed · 1 ahead', icon: 'branch' as const },
  { k: 'Rules', v: 'CLAUDE.md, .cursorrules', m: '+ 6 rule files', icon: 'rules' as const },
  { k: 'Memory', v: '10 notes', m: 'composer-mention-folder…', icon: 'memory' as const },
  { k: 'Index', v: '866 files', m: 'ready · updated 2m ago', icon: 'database' as const },
  { k: 'Tools', v: '64 built-in', m: '0 MCP servers', icon: 'tool' as const }
]

export function BriefSheetBody() {
  const { d } = useRail()
  const [off, setOff] = useState<Set<number>>(new Set())
  const on = PROPOSED.length - off.size
  return (
    <div className={cn(SCROLL, '@container')}>
      <div className={cn(GUTTER, 'grid max-w-[1180px] gap-x-12 pb-10 pt-6 @4xl:grid-cols-[minmax(0,1fr)_300px]')}>
        <div className="min-w-0">
          <h1 className="m-0 text-title font-semibold text-fg-strong">What should get done?</h1>
          <div className="mt-4">
            <Lens task={NEW_TASK} variant="brief" />
          </div>

          <Section label="Done when" count={on} note="· checked before the run can finish">
            <ul className="m-0 list-none p-0">
              {PROPOSED.map((c, i) => {
                const isOn = !off.has(i)
                return (
                  <li key={c.text} className="flex h-8 items-center gap-3">
                    <Checkbox
                      checked={isOn}
                      aria-label={c.text}
                      onCheckedChange={() => {
                        const n = new Set(off)
                        if (isOn) n.add(i)
                        else n.delete(i)
                        setOff(n)
                      }}
                    />
                    <span className={cn('min-w-0 flex-1 truncate text-sm', isOn ? 'text-fg' : 'text-tertiary line-through')}>{c.text}</span>
                    <span className="shrink-0 text-caption text-tertiary">{c.from}</span>
                  </li>
                )
              })}
            </ul>
            <button type="button" className={cn(ROW, 'mt-0.5 text-sm text-secondary vy-transition hover:bg-surface focus-visible:vy-focus-ring')}>
              <Icon name="plus" size={14} />
              Add a check
            </button>
          </Section>

          <div className="mt-7 flex flex-wrap items-center gap-2">
            <Button variant="primary" size="md" onClick={() => d({ type: 'selectTask', id: 'composer' })}>
              Start task
            </Button>
            <Button variant="ghost" size="md">
              Save as draft
            </Button>
            <span className="flex-1" />
            <span className="flex items-center gap-1.5 text-caption text-tertiary">
              <Icon name="shield" size={13} />
              Runs its tools without asking · asks before anything it can’t undo
              <button type="button" className="rounded-sm font-medium text-fg underline decoration-border-strong underline-offset-2 hover:decoration-fg focus-visible:vy-focus-ring" onClick={() => d({ type: 'open', kind: 'settings' })}>
                Change
              </button>
            </span>
          </div>
        </div>

        <aside className="mt-8 min-w-0 @4xl:mt-[42px]" aria-label="What the agent will see">
          <Section label="What it will see" flush>
            <ul className="m-0 list-none p-0">
              {FACTS.map((f) => (
                <li key={f.k} className="flex gap-3 border-t border-border/60 py-2 first:border-t-0">
                  <Icon name={f.icon} size={14} className="mt-[3px] shrink-0 text-muted" />
                  <div className="min-w-0">
                    <div className="text-caption text-tertiary">{f.k}</div>
                    <div className="truncate text-sm text-fg">{f.v}</div>
                    <div className="truncate font-mono text-caption text-tertiary">{f.m}</div>
                  </div>
                </li>
              ))}
            </ul>
          </Section>
        </aside>
      </div>
    </div>
  )
}

/* ─── Home ────────────────────────────────────────────────────────────────── */

export function HomeSheetBody() {
  const { d } = useRail()
  const needs = TASKS.filter((t) => t.group === 'needs')
  const running = TASKS.filter((t) => t.group === 'running')
  const review = TASKS.filter((t) => t.group === 'review')
  const live = (t: Task): string => {
    const i = t.steps.findIndex((st) => st.state === 'running' || st.state === 'needs')
    return i >= 0 ? t.steps[i].title : 'Reading 50 run logs'
  }
  const open = (id: string) => () => d({ type: 'selectTask', id })
  const rowBtn = cn(ROW, 'w-[calc(100%+16px)] text-left vy-transition hover:bg-surface focus-visible:vy-focus-ring')
  return (
    <div className={cn(SCROLL, '@container')}>
      <div className={cn(GUTTER, 'grid max-w-[1180px] gap-x-12 pb-10 pt-2 @4xl:grid-cols-[minmax(0,1fr)_320px]')}>
        <div className="min-w-0">
          <Section label="Needs you" count={needs.length}>
            <ul className="m-0 list-none p-0">
              {needs.map((t) => (
                <li key={t.id}>
                  <button type="button" onClick={open(t.id)} className={rowBtn}>
                    <StatusGlyph state="needs" size={14} label />
                    <span className="shrink-0 text-sm text-fg-strong">{t.title}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-secondary">{t.gate?.title}</span>
                    <span className="font-mono text-caption text-accent tnum">{t.meta}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Section>

          <Section label="Running" count={running.length}>
            <ul className="m-0 list-none p-0">
              {running.map((t) => (
                <li key={t.id}>
                  <button type="button" onClick={open(t.id)} className={rowBtn}>
                    <StatusGlyph state="running" size={14} label />
                    <span className="shrink-0 text-sm text-fg">{t.title}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-tertiary">{live(t)}</span>
                    <StepDots task={t} />
                  </button>
                </li>
              ))}
            </ul>
          </Section>

          <Section label="Ready for review" count={review.length}>
            <ul className="m-0 list-none p-0">
              {review.map((t) => {
                const [a, b] = t.meta.split(' ')
                return (
                  <li key={t.id}>
                    <button type="button" onClick={open(t.id)} className={rowBtn}>
                      <StatusGlyph state="review" size={14} label />
                      <span className="min-w-0 flex-1 truncate text-sm text-fg">{t.title}</span>
                      <DiffStat add={Number(a.slice(1))} del={Number(b.slice(1))} />
                    </button>
                  </li>
                )
              })}
            </ul>
          </Section>

          <Section label="Workspaces" count={WORKSPACES.length} action={<Button variant="ghost" size="xs" icon="plus">Add</Button>}>
            <ul className="m-0 list-none p-0">
              {WORKSPACES.map((w) => (
                <li key={w.name} className="flex min-h-12 items-center gap-3 border-t border-border/60 py-2 first:border-t-0">
                  <Icon name="folder" size={15} className="shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-fg-strong">{w.name}</div>
                    {w.status === 'ok' ? (
                      <div className="flex items-center gap-2 font-mono text-caption text-tertiary">
                        <span className="text-secondary">{w.branch}</span>
                        <span className="tnum">{w.changed} changed · {w.ahead} ahead</span>
                        <span className="vy-text-live font-sans">{w.note}</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 text-caption text-warning">
                        <Icon name="warningCircle" size={12} />
                        {w.note}
                      </div>
                    )}
                  </div>
                  {w.status === 'error' ? (
                    <Button variant="ghost" size="xs" icon="refresh">
                      Try again
                    </Button>
                  ) : (
                    <Button variant="ghost" size="xs" icon="plus" onClick={() => d({ type: 'place', place: 'new' })}>
                      Task
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </Section>
        </div>

        <aside className="min-w-0" aria-label="This week">
          <Section label="This week" action={<Button variant="ghost" size="xs" trailingIcon="arrowRight" onClick={() => d({ type: 'place', place: 'usage' })}>Usage</Button>}>
            <div className="grid grid-cols-2 gap-x-6 gap-y-4 pt-1">
              <Stat label="Tasks" value={WEEK.totals.tasks} />
              <Stat label="Finished" value={WEEK.totals.finished} note={`${WEEK.totals.stopped} stopped`} />
              <Stat label="Tokens" value={WEEK.totals.tokens} note={`${WEEK.totals.cache} from cache`} />
              <Stat label="Spend" value={WEEK.totals.spend} note="No cost reported" />
            </div>
            <div className="mt-5">
              <DayBars days={WEEK.days} values={WEEK.tasks} unit="tasks" height={84} />
            </div>
          </Section>
        </aside>
      </div>
    </div>
  )
}

/* ─── Usage ───────────────────────────────────────────────────────────────── */

const MONTH_DAYS = Array.from({ length: 30 }, (_, i) => String(i + 1))
const MONTH_TASKS = [0, 2, 3, 0, 0, 5, 4, 6, 2, 0, 0, 3, 8, 5, 4, 2, 0, 0, 6, 9, 3, 4, 1, 0, 0, 0, 0, 1, 7, 1]
const MONTH_TOKENS = MONTH_TASKS.map((n) => Math.round(n * 7.4 * 10) / 10)

export function UsageSheetBody({ range }: { range: '7' | '30' }) {
  const days = range === '7' ? WEEK.days : MONTH_DAYS
  const tasks = range === '7' ? WEEK.tasks : MONTH_TASKS
  const tokens = range === '7' ? WEEK.tokens : MONTH_TOKENS
  const sumTasks = tasks.reduce((a, b) => a + b, 0)
  const active = tasks.filter((n) => n > 0).length
  const failures = [...TOOL_FAILURES].sort((a, b) => b.fails / b.calls - a.fails / a.calls)
  const calls = TOOL_FAILURES.reduce((n, f) => n + f.calls, 0)
  return (
    <div className={cn(SCROLL, '@container')}>
      <div className={cn(GUTTER, 'max-w-[1180px] pb-10')}>
        <div className="mt-4 grid grid-cols-2 border-y border-border @2xl:grid-cols-4">
          {[
            { label: 'Tasks', value: sumTasks, note: `on ${active} of ${days.length} days` },
            { label: 'Tokens', value: range === '7' ? WEEK.totals.tokens : '412M', note: `${WEEK.totals.cache} from cache` },
            { label: 'Spend', value: '—', note: 'No provider reported a cost' },
            { label: 'Finished', value: WEEK.totals.finished, note: `${WEEK.totals.stopped} stopped` }
          ].map((x, i) => (
            <div
              key={x.label}
              className={cn(
                'py-3 pr-4',
                i === 1 || i === 3 ? 'border-l border-border/60 pl-4' : '',
                i === 2 ? 'border-t border-border/60 @2xl:border-l @2xl:border-t-0 @2xl:pl-4' : '',
                i === 3 ? 'border-t border-border/60 @2xl:border-t-0' : ''
              )}
            >
              <Stat label={x.label} value={x.value} note={x.note} />
            </div>
          ))}
        </div>

        <div className="mt-6 grid gap-x-12 gap-y-6 @3xl:grid-cols-2">
          <Section flush label="Tasks per day" note={`· peak ${Math.max(...tasks)}`}>
            <DayBars days={days} values={tasks} unit="tasks" labelEvery={range === '7' ? 1 : 5} />
          </Section>
          <Section flush label="Tokens per day" note={`· total ${range === '7' ? WEEK.totals.tokens : '412M'}`}>
            <DayBars days={days} values={tokens} unit="M tokens" labelEvery={range === '7' ? 1 : 5} format={(n) => (n === 0 ? '0' : `${n}M`)} />
          </Section>
        </div>

        <div className="mt-6 grid gap-x-12 gap-y-6 @5xl:grid-cols-3">
          <Section flush label="Model mix" note="· output tokens">
            <ul className="m-0 list-none p-0">
              {MODEL_MIX.map((m) => (
                <li key={m.id} className="py-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-mono text-fg">{m.id}</span>
                    <span className="font-mono text-tertiary tnum">{Math.round(m.share * 100)}%</span>
                  </div>
                  <ProgressBar value={m.share} className="mt-1.5 w-full" label={`${m.id} share`} />
                </li>
              ))}
            </ul>
          </Section>
          <Section flush label="Tool failures" note={`· of ${calls.toLocaleString()} calls`}>
            <ul className="m-0 list-none p-0">
              {failures.map((f) => (
                <li key={f.tool} className="flex h-8 items-center gap-2">
                  <span className="shrink-0 font-mono text-xs text-fg">{f.tool}</span>
                  <span className="min-w-0 flex-1 truncate text-caption text-tertiary">{f.why}</span>
                  <span className="shrink-0 font-mono text-caption text-secondary tnum">
                    {f.fails} of {f.calls}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
          <Section flush label="Unchecked" note="· edits with no passing check after">
            <div className="flex h-8 items-center gap-2 text-sm">
              <Icon name="warningCircle" size={14} className="shrink-0 text-warning" />
              <span className="min-w-0 flex-1 truncate text-fg">Release waits for CI on the tagged commit</span>
              <span className="font-mono text-caption text-tertiary">1 file</span>
            </div>
            <p className="m-0 mt-1 text-caption text-tertiary">Worth a test run before you commit.</p>
          </Section>
        </div>
      </div>
    </div>
  )
}

/* ─── Extensions ──────────────────────────────────────────────────────────── */

function ExtensionRow({ e, on, setOn }: { e: (typeof EXTENSIONS)[number]; on: boolean; setOn: (v: boolean) => void }) {
  return (
    <li className="flex min-h-12 items-center gap-3 border-t border-border/60 py-2 first:border-t-0">
      <Icon name={e.kind === 'MCP' ? 'mcp' : 'skill'} size={16} className="shrink-0 text-muted" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm text-fg-strong">
          {e.name}
          <Badge tone="outline" size="sm">
            {e.kind}
          </Badge>
        </div>
        <div className="truncate text-caption text-tertiary">{e.note}</div>
      </div>
      {e.id === 'linear' ? (
        <Button variant="secondary" size="xs">
          Sign in
        </Button>
      ) : (
        <Switch checked={on} onCheckedChange={setOn} label={`${e.name} on`} />
      )}
    </li>
  )
}

export function ExtensionsSheetBody() {
  const [on, setOn] = useState<Record<string, boolean>>(() => Object.fromEntries(EXTENSIONS.map((e) => [e.id, e.on])))
  const [q, setQ] = useState('')
  const list = EXTENSIONS.filter((e) => (e.name + e.note).toLowerCase().includes(q.toLowerCase()))
  const setup = list.filter((e) => e.id === 'linear')
  const ready = list.filter((e) => e.id !== 'linear')
  return (
    <div className={SCROLL}>
      <div className={cn(GUTTER, 'max-w-[760px] pb-10 pt-3')}>
        <label className="flex h-8 items-center gap-2 rounded-md border border-border bg-bg px-2.5 vy-transition hover:border-border-strong focus-within:border-border-strong">
          <Icon name="search" size={13} className="text-tertiary" />
          <span className="sr-only">Filter extensions</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter installed" className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-tertiary" />
        </label>
        {ready.length ? (
          <Section label="Installed" count={ready.length}>
            <ul className="m-0 list-none p-0">
              {ready.map((e) => (
                <ExtensionRow key={e.id} e={e} on={on[e.id]} setOn={(v) => setOn({ ...on, [e.id]: v })} />
              ))}
            </ul>
          </Section>
        ) : null}
        {setup.length ? (
          <Section label="Needs setup" count={setup.length}>
            <ul className="m-0 list-none p-0">
              {setup.map((e) => (
                <ExtensionRow key={e.id} e={e} on={on[e.id]} setOn={(v) => setOn({ ...on, [e.id]: v })} />
              ))}
            </ul>
          </Section>
        ) : null}
        {list.length === 0 ? <Empty icon="extensions" title="Nothing installed matches" /> : null}
      </div>
    </div>
  )
}

/* ─── Settings ────────────────────────────────────────────────────────────── */

const SETTINGS_SECTIONS = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'rail', label: 'Sheets and lens' },
  { id: 'agent', label: 'Agent' },
  { id: 'models', label: 'Models' },
  { id: 'keys', label: 'Keys' }
] as const

function SkinCard({ skin, on, theme, onPick }: { skin: Skin; on: boolean; theme: 'light' | 'dark'; onPick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onPick}
      className={cn('group flex flex-col gap-1.5 rounded-lg p-1 text-left vy-transition focus-visible:vy-focus-ring', on ? SELECTED : 'hover:bg-surface')}
    >
      <span data-skin={skin} data-theme={theme} className={cn('block h-[52px] overflow-hidden rounded-md border bg-chrome', on ? 'border-fg-strong' : 'border-border')}>
        <span className="flex h-full">
          <span className="w-1/4 bg-chrome" />
          <span className="flex flex-1 flex-col gap-1 border-l border-border bg-bg p-1.5">
            <span className="h-[3px] w-3/4 rounded-full bg-fg-strong" />
            <span className="h-[3px] w-1/2 rounded-full bg-border-strong" />
            <span className="mt-auto h-[6px] w-6 rounded-sm bg-accent" />
          </span>
        </span>
      </span>
      <span className="px-0.5 text-xs capitalize">{skin}</span>
    </button>
  )
}

export function SettingsSheetBody({ narrow }: { narrow: boolean }) {
  const { s, d } = useRail()
  const body = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState<string>('appearance')
  const [spines, setSpines] = useState(true)
  const [follow, setFollow] = useState(true)
  const [openAt, setOpenAt] = useState<'0' | '1' | '2'>('1')
  const [approval, setApproval] = useState<'auto' | 'edits' | 'all'>('auto')
  const [checks, setChecks] = useState(true)
  const [model, setModel] = useState('space-bunny-free')
  const [effort, setEffort] = useState<'Low' | 'Med' | 'High' | 'XHigh' | 'Max'>('Max')

  const go = (id: string): void => {
    setAt(id)
    const el = body.current?.querySelector(`[data-section="${id}"]`) as HTMLElement | null
    if (el && body.current) body.current.scrollTo({ top: el.offsetTop - 8, behavior: 'smooth' })
  }

  return (
    <div className="flex min-h-0 flex-1">
      {narrow ? null : (
        <nav aria-label="Settings sections" className="w-40 shrink-0 border-r border-border/60 px-2 py-3">
          {SETTINGS_SECTIONS.map((x) => (
            <button
              key={x.id}
              type="button"
              aria-current={at === x.id || undefined}
              onClick={() => go(x.id)}
              className={cn('flex h-7 w-full items-center rounded-md px-2 text-left text-sm vy-transition focus-visible:vy-focus-ring', at === x.id ? SELECTED : 'text-secondary hover:bg-surface')}
            >
              {x.label}
            </button>
          ))}
        </nav>
      )}
      <div ref={body} className={cn(SCROLL, 'relative')}>
        <div className={cn(GUTTER, 'max-w-[640px] pb-12 pl-6')}>
          <div data-section="appearance">
            <FormGroup title="Appearance" description="Every surface repaints, the rail included">
              <FormRow id="skin" title="Skin" wide changed={s.skin !== 'native'} onReset={() => d({ type: 'appearance', skin: 'native' })}>
                <div role="radiogroup" aria-label="Skin" className="mt-2 grid grid-cols-5 gap-1.5">
                  {SKINS.map((k) => (
                    <SkinCard key={k} skin={k} theme={s.theme} on={s.skin === k} onPick={() => d({ type: 'appearance', skin: k })} />
                  ))}
                </div>
              </FormRow>
              <FormRow id="theme" title="Theme" changed={s.theme !== 'dark'} onReset={() => d({ type: 'appearance', theme: 'dark' })}>
                <Segmented label="Theme" value={s.theme} onChange={(t) => d({ type: 'appearance', theme: t })} items={[{ id: 'light', label: 'Light', icon: 'sun' }, { id: 'dark', label: 'Dark', icon: 'moon' }]} />
              </FormRow>
            </FormGroup>
          </div>

          <div data-section="rail">
            <FormGroup title="Sheets and lens">
              <FormRow id="spines" title="Fold sheets that don’t fit into spines" hint="Off: the rail scrolls sideways instead" changed={!spines} onReset={() => setSpines(true)}>
                <Switch checked={spines} onCheckedChange={setSpines} label="Fold into spines" />
              </FormRow>
              <FormRow id="follow" title="The lens follows the sheet you’re in" hint="Off: it stays under the record" changed={!follow} onReset={() => setFollow(true)}>
                <Switch checked={follow} onCheckedChange={setFollow} label="Lens follows focus" />
              </FormRow>
              <FormRow id="openat" title="New sheets open at" changed={openAt !== '1'} onReset={() => setOpenAt('1')}>
                <Segmented label="New sheet width" value={openAt} onChange={setOpenAt} items={[0, 1, 2].map((i) => ({ id: String(i) as '0' | '1' | '2', label: SNAP_LABEL[i] }))} />
              </FormRow>
            </FormGroup>
          </div>

          <div data-section="agent">
            <FormGroup title="Agent" description="For every task in this workspace">
              <FormRow id="approvals" title="Asks before" wide changed={approval !== 'auto'} onReset={() => setApproval('auto')}>
                <RadioList
                  label="Asks before"
                  value={approval}
                  onChange={setApproval}
                  className="mt-2"
                  choices={[
                    { value: 'auto', label: 'Anything it can’t undo', description: 'Runs its tools without asking. MCP tools ask first.' },
                    { value: 'edits', label: 'Edits and commands', description: 'Reads freely; asks before it writes or runs.' },
                    { value: 'all', label: 'Every tool call', description: 'Slowest; you see each step before it happens.' }
                  ]}
                />
              </FormRow>
              <FormRow id="checks" title="Check done-when before finishing" hint="A run can’t finish while a check is unmet" changed={!checks} onReset={() => setChecks(true)}>
                <Switch checked={checks} onCheckedChange={setChecks} label="Check done-when" />
              </FormRow>
            </FormGroup>
          </div>

          <div data-section="models">
            <FormGroup title="Models" description="New tasks start with these; the lens changes them per task">
              <FormRow id="model" title="Model" changed={model !== 'space-bunny-free'} onReset={() => setModel('space-bunny-free')}>
                <Menu
                  aria-label="Model"
                  value={model}
                  onChange={setModel}
                  mono
                  placement="down"
                  options={[
                    { value: 'space-bunny-free', label: 'space-bunny-free', group: 'OpenCode Go' },
                    { value: 'deepseek-v4-pro', label: 'deepseek-v4-pro', group: 'OpenCode Go' },
                    { value: 'glm-5.3', label: 'glm-5.3', group: 'OpenCode Go' },
                    { value: 'qwen3-coder', label: 'qwen3-coder', group: 'Ollama · local' }
                  ]}
                />
              </FormRow>
              <FormRow id="effort" title="Effort" changed={effort !== 'Max'} onReset={() => setEffort('Max')}>
                <Segmented label="Effort" value={effort} onChange={setEffort} items={(['Low', 'Med', 'High', 'XHigh', 'Max'] as const).map((x) => ({ id: x, label: x }))} />
              </FormRow>
            </FormGroup>
          </div>

          <div data-section="keys">
            <FormGroup title="Keys" plain>
              <ul className="m-0 list-none p-0">
                {KEYS.map(([k, what]) => (
                  <li key={what} className="flex h-8 items-center gap-2 border-t border-border/60 text-sm first:border-t-0">
                    <span className="min-w-0 flex-1 truncate text-fg">{what}</span>
                    <Keys keys={k} />
                  </li>
                ))}
              </ul>
            </FormGroup>
          </div>
        </div>
      </div>
    </div>
  )
}

