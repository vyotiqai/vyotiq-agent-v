import { useState } from 'react'
import { Icon } from '@renderer/lib/icons'
import { Button, Segmented, Switch, Tooltip, cn, pushToast } from '@renderer/lib/ui'
import { ROW_HOVER } from '@renderer/lib/utils/layout'
import { EXTENSIONS, MODEL_MIX, TOOL_FAILURES, USAGE_DAYS, type Extension } from './data'
import { Label } from './parts'

/*
  Usage and Extensions: the two places behind the list's foot icons. Same
  frame as All tasks — a 40px header, one centred column, rows on a grid.
*/

type Metric = 'cost' | 'tokens' | 'tasks'

/** September so far: the sample's last nine days, and a quieter three weeks before them. */
const MONTH: typeof USAGE_DAYS = [
  ...[2, 4, 1, 0, 3, 5, 2, 0, 0, 3, 4, 2, 1, 0, 2, 3, 6, 1, 0, 2, 4].map((tasks, i) => ({
    day: `Sep ${i + 1}`,
    tasks,
    tokens: tasks * 150 + (i % 3) * 20,
    cost: Math.round((tasks * 0.29 + (i % 3) * 0.04) * 100) / 100
  })),
  ...USAGE_DAYS
]

const fmt = (m: Metric, v: number): string => (m === 'cost' ? `$${v.toFixed(2)}` : m === 'tokens' ? `${(v / 1000).toFixed(2)}M` : String(v))

export function Usage() {
  const [range, setRange] = useState<'7' | '30'>('7')
  const [metric, setMetric] = useState<Metric>('cost')
  const days = range === '7' ? USAGE_DAYS.slice(-7) : MONTH
  const values = days.map((d) => d[metric])
  const max = Math.max(...values, 1)
  const peak = values.indexOf(max)
  const sum = (k: Metric): number => days.reduce((n, d) => n + d[k], 0)
  return (
    <section aria-label="Usage" className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-bg">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
        <h1 className="text-sm font-semibold text-fg-strong">Usage</h1>
        <span className="text-caption text-tertiary">All workspaces</span>
        <span className="flex-1" />
        <Segmented
          label="Range"
          value={range}
          onChange={setRange}
          items={[
            { id: '7', label: '7 days' },
            { id: '30', label: '30 days' }
          ]}
        />
      </header>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[900px] px-6 pb-10 pt-6">
          <dl className="grid grid-cols-4 border-y border-border/60">
            {[
              ['Tasks', String(sum('tasks')), `${Math.round(sum('tasks') / days.length)} a day`],
              ['Tokens', fmt('tokens', sum('tokens')), '41% served from cache'],
              ['Spent', fmt('cost', sum('cost')), `$${(sum('cost') / Math.max(1, sum('tasks'))).toFixed(2)} a task`],
              ['Kept', '82%', 'of changes kept, not undone']
            ].map(([k, v, sub], i) => (
              <div key={k} className={cn('py-3', i ? 'border-l border-border/60 pl-4' : '')}>
                <dt className="text-caption text-tertiary">{k}</dt>
                <dd className="mt-0.5 font-mono text-title tnum text-fg-strong">{v}</dd>
                <dd className="text-caption text-tertiary">{sub}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-7 flex items-center">
            <Label className="flex-1">By day</Label>
            <Segmented
              label="Measure"
              value={metric}
              onChange={setMetric}
              items={[
                { id: 'cost', label: 'Spend' },
                { id: 'tokens', label: 'Tokens' },
                { id: 'tasks', label: 'Tasks' }
              ]}
            />
          </div>
          <div className={cn('mt-3 flex h-44 items-end border-b border-border', days.length > 10 ? 'gap-1' : 'gap-2')} role="group" aria-label={`${metric} by day, peak ${fmt(metric, max)} on ${days[peak].day}`}>
            {days.map((d, i) => {
              const v = values[i]
              const today = i === days.length - 1
              const labelled = i === peak || today
              return (
                <Tooltip key={d.day} content={`${d.day} · ${d.tasks} tasks · ${fmt('tokens', d.tokens)} tokens · ${fmt('cost', d.cost)}`}>
                  <div className="flex h-full min-w-0 flex-1 items-end justify-center pt-6" role="img" aria-label={`${d.day}: ${fmt(metric, v)}`}>
                    <div
                      className={cn('relative w-full max-w-[44px] rounded-t-[4px]', v === 0 ? 'bg-border' : today ? 'bg-accent' : 'bg-border-strong')}
                      style={{ height: v === 0 ? 2 : `${Math.max(3, (v / max) * 100)}%` }}
                    >
                      {labelled && v ? (
                        <span className="absolute bottom-full left-1/2 mb-1 -translate-x-1/2 whitespace-nowrap font-mono text-caption tnum text-fg">{fmt(metric, v)}</span>
                      ) : null}
                    </div>
                  </div>
                </Tooltip>
              )
            })}
          </div>
          <div className={cn('mt-1.5 flex', days.length > 10 ? 'gap-1' : 'gap-2')}>
            {days.map((d, i) => {
              const every = days.length > 10 ? 5 : 1
              const show = i % every === 0 || i === days.length - 1
              return (
                <span key={d.day} className={cn('min-w-0 flex-1 whitespace-nowrap text-center font-mono text-caption tnum', i === days.length - 1 ? 'text-fg' : 'text-tertiary')}>
                  {show ? (days.length > 10 ? (i === days.length - 1 ? 'Today' : `${i + 1}`) : d.day.split(' ')[0]) : ''}
                </span>
              )
            })}
          </div>

          <div className="mt-9 grid grid-cols-2 gap-10">
            <div>
              <Label className="mb-2">Models</Label>
              <ul className="flex flex-col gap-2">
                {MODEL_MIX.map((m) => (
                  <li key={m.name} className="grid grid-cols-[112px_1fr_40px] items-center gap-3 text-xs">
                    <span className="truncate text-fg">{m.name}</span>
                    <span className="h-1.5 rounded-full bg-border">
                      <span className="block h-full rounded-full bg-muted" style={{ width: `${m.share * 100}%` }} />
                    </span>
                    <span className="text-right font-mono tnum text-tertiary">{Math.round(m.share * 100)}%</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <Label className="mb-2">What failed most</Label>
              <ul className="flex flex-col">
                {TOOL_FAILURES.map((f) => (
                  <li key={f.why} className="flex h-7 items-center gap-2.5 text-xs">
                    <span className="w-16 shrink-0 font-mono text-secondary">{f.tool}</span>
                    <span className="min-w-0 flex-1 truncate text-fg">{f.why}</span>
                    <span className="font-mono tnum text-tertiary">{f.n}×</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

const KIND_LABEL: Record<Extension['kind'], string> = { mcp: 'MCP servers', skill: 'Skills', rule: 'Rules' }

export function Extensions() {
  const [on, setOn] = useState<Record<string, boolean>>(() => Object.fromEntries(EXTENSIONS.map((e) => [e.id, e.state === 'on'])))
  const [q, setQ] = useState('')
  const shown = EXTENSIONS.filter((e) => `${e.name} ${e.what}`.toLowerCase().includes(q.toLowerCase()))
  return (
    <section aria-label="Extensions" className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-bg">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
        <h1 className="text-sm font-semibold text-fg-strong">Extensions</h1>
        <span className="text-caption text-tertiary">What every task in acme can use</span>
        <span className="flex-1" />
        <label className="flex h-7 w-56 items-center gap-1.5 rounded-md bg-surface px-2 text-xs">
          <Icon name="search" size={13} className="text-tertiary" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search extensions" aria-label="Search extensions" className="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-tertiary" />
        </label>
        <Button size="xs" variant="secondary" icon="plus">
          Add MCP server
        </Button>
      </header>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[760px] px-6 pb-10 pt-4">
          {(['mcp', 'skill', 'rule'] as const).map((kind) => {
            const rows = shown.filter((e) => e.kind === kind)
            if (!rows.length) return null
            return (
              <section key={kind} aria-label={KIND_LABEL[kind]} className="mt-4">
                <Label className="flex h-8 items-center">
                  {KIND_LABEL[kind]} <span className="ml-2 font-mono tnum">{rows.length}</span>
                </Label>
                <ul className="border-t border-border/60">
                  {rows.map((e) => (
                    <li key={e.id} className={cn('-mx-2 flex min-h-12 items-center gap-3 rounded-md px-2 py-2', ROW_HOVER)}>
                      <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-card text-xs font-semibold text-secondary">
                        {kind === 'rule' ? <Icon name="rules" size={15} className="text-tertiary" /> : kind === 'skill' ? <Icon name="skill" size={15} className="text-tertiary" /> : e.name.slice(0, 2)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className={cn('truncate text-sm', on[e.id] || e.state === 'signin' ? 'text-fg-strong' : 'text-muted')}>{e.name}</div>
                        <div className="truncate text-xs text-tertiary">
                          {e.what}
                          <span aria-hidden> · </span>
                          <span className={kind === 'rule' ? 'font-mono' : ''}>{e.meta}</span>
                        </div>
                      </div>
                      {e.state === 'signin' ? (
                        <Button size="xs" variant="primary" onClick={() => pushToast('Opened sign-in for Sentry in your browser', { icon: 'key' })}>
                          Sign in
                        </Button>
                      ) : (
                        <Switch checked={on[e.id]} onCheckedChange={(v) => setOn({ ...on, [e.id]: v })} label={`${e.name} ${on[e.id] ? 'on' : 'off'}`} />
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
          {!shown.length ? <div className="py-10 text-center text-xs text-tertiary">Nothing matches “{q}”.</div> : null}
          <div className="mt-8 flex items-center gap-2 border-t border-border/60 pt-4 text-xs text-tertiary">
            <Icon name="marketplace" size={14} />
            <span className="flex-1">124 more in the catalog: MCP servers, skills and plugins.</span>
            <Button size="xs" variant="ghost" trailingIcon="arrowRight">
              Browse the catalog
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}
