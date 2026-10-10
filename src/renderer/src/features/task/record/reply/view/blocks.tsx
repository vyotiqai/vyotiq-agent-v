import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '@renderer/lib/icons'
import { Button, cn, Input, RadioList, StatusGlyph, Switch } from '@renderer/lib/ui'
import { formatDisplayTime } from '@shared/utils/timeFormat'
import { ChartBlock } from '@renderer/lib/ui/ChartBlock'
import { BORDER_DIVIDER, ROW_HOVER, SECTION_LABEL } from '@renderer/lib/utils/layout'
import { useRunSession } from '@renderer/features/chat/RunSessionContext'
import type { ViewBlock, ViewBlockOf, ViewDo } from '@shared/viewSpec'
import { clickOf, clickTitle, linkHost } from './act'
import { useLiveSource } from './live'
import { Changed, keyed, MotionProvider, Presence, usePresence } from './motion'

/*
  The blocks a ```view may hold, drawn with the app's own primitives.

  One left edge: every block's text starts where the card head's label
  starts. Hover fills reach 8px past it on each side (-mx-2 px-2) so the
  text never moves to make room for them.
*/

export type ViewActions = {
  /** Send text to the agent as your next message; absent where this record can't take one. */
  say?: (text: string) => void
  open?: (path: string) => void
  /** Whether this place can carry out an app action (VIEW_DO). */
  can?: (d: ViewDo) => boolean
  /** `seen`: the control shows a link's site, so opening it need not ask. */
  run?: (d: ViewDo, seen?: boolean) => void
}

type Props<T extends ViewBlock['type']> = { block: ViewBlockOf<T>; was: ViewBlockOf<T> | null; act: ViewActions }

export function Block({ block, was, act }: { block: ViewBlock; was: ViewBlock | null; act: ViewActions }) {
  // A block that changed type under the same key starts fresh.
  const prev = was && was.type === block.type ? was : null
  switch (block.type) {
    case 'stats':
      return <Stats block={block} was={prev as ViewBlockOf<'stats'> | null} act={act} />
    case 'rows':
      return <Rows block={block} was={prev as ViewBlockOf<'rows'> | null} act={act} />
    case 'table':
      return <Table block={block} was={prev as ViewBlockOf<'table'> | null} act={act} />
    case 'chart':
      return <Chart block={block} />
    case 'checks':
      return <Checks block={block} />
    case 'note':
      return <Note block={block} was={prev as ViewBlockOf<'note'> | null} />
    case 'actions':
      return <Actions block={block} act={act} />
    case 'form':
      return <Form block={block} act={act} />
    case 'live':
      return <LiveBlock block={block} act={act} />
  }
}

function Title({ children, count }: { children: ReactNode; count?: string }) {
  return (
    <div className="mb-1.5 flex h-5 items-center gap-2">
      <span className={SECTION_LABEL}>{children}</span>
      {count ? <span className="font-mono text-caption text-tertiary tnum">{count}</span> : null}
    </div>
  )
}

const unavailable = 'Open the task to act on this view'

/* ─── stats ─── */

const VALUE_TONE = { neutral: 'text-fg-strong', success: 'text-success', danger: 'text-danger', accent: 'text-accent' } as const

function Stats({ block, was, act }: Props<'stats'>) {
  const before = new Map((was?.items ?? []).map((s) => [s.id ?? s.label, s.value]))
  // At most `per` to a row (four, or three when that balances five or six
  // better), and fewer in a narrow pane: a number is never cut to fit.
  const per = Math.min(block.items.length, block.items.length > 4 ? 3 : 4)
  return (
    <div className="grid gap-x-4 gap-y-3" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(max(7rem, calc((100% - ${per - 1}rem) / ${per})), 1fr))` }}>
      {block.items.map((s, i) => {
        const body = (
          <>
            <span className="block truncate text-xs text-muted">{s.label}</span>
            <Changed value={s.value} from={before.get(s.id ?? s.label)} className={cn('block truncate font-mono text-title tnum', VALUE_TONE[s.tone ?? 'neutral'])} />
            {s.hint ? <span className="block truncate text-caption text-tertiary">{s.hint}</span> : null}
          </>
        )
        // Where nothing here can carry out its click, a stat is only a stat.
        const click = clickOf(s, act)
        return click ? (
          <button
            key={s.id ?? `${s.label}${i}`}
            type="button"
            title={clickTitle(s, act)}
            onClick={click}
            className={cn('-mx-2 min-w-0 self-start rounded-md px-2 py-1 text-left vy-transition focus-visible:vy-focus-ring', ROW_HOVER)}
          >
            {body}
          </button>
        ) : (
          <div key={s.id ?? `${s.label}${i}`} className="min-w-0 py-1">
            {body}
          </div>
        )
      })}
    </div>
  )
}

/* ─── rows ─── */

function Rows({ block, was, act }: Props<'rows'>) {
  const rowKey = (r: ViewBlockOf<'rows'>['items'][number]): string | undefined => r.id ?? r.path ?? r.title
  const list = keyed(block.items, rowKey, 'r')
  const baseline = was ? keyed(was.items, rowKey, 'r') : null
  const rows = usePresence(list, baseline)
  const before = new Map((baseline ?? []).map((b) => [b.key, b.item.value]))
  const has = {
    glyph: block.items.some((r) => r.state || r.path),
    share: block.items.some((r) => r.share !== undefined),
    diff: block.items.some((r) => r.diff),
    value: block.items.some((r) => r.value)
  }
  // One column template for every row, each column as wide as its widest
  // entry in this block (mono digits, so ch is exact): bars, signs and values
  // share their edges from the first row to the last.
  const widest = (f: (r: ViewBlockOf<'rows'>['items'][number]) => string): string =>
    `${Math.max(1, ...block.items.map((r) => f(r).length))}ch`
  const cols = [
    has.glyph && '14px',
    'minmax(0,1fr)',
    has.share && '72px',
    has.diff && widest((r) => (r.diff && r.diff.add > 0 ? `+${r.diff.add}` : '')),
    has.diff && widest((r) => (r.diff && r.diff.del > 0 ? `−${r.diff.del}` : '')),
    has.value && widest((r) => r.value ?? '')
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <div>
      {block.title ? <Title count={String(Math.max(block.total ?? 0, rows.filter((p) => !p.leaving).length))}>{block.title}</Title> : null}
      <div className="-mx-2 flex flex-col">
        {rows.map((p) => {
          const r = p.item
          const click = clickOf(r, act)
          const inner = (
            <span className="grid min-h-8 items-center gap-x-3 px-2 py-1" style={{ gridTemplateColumns: cols }}>
              {has.glyph ? (
                r.state ? (
                  <StatusGlyph state={r.state} size={14} label />
                ) : r.path ? (
                  <Icon name="file" size={14} className="text-tertiary" />
                ) : (
                  <span />
                )
              ) : null}
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="min-w-0 truncate text-sm">
                  {r.lead ? <span className="text-muted">{r.lead}</span> : null}
                  <span className="text-fg">{r.title}</span>
                </span>
                {r.meta ? <span className="min-w-0 shrink truncate text-xs text-muted">{r.meta}</span> : null}
              </span>
              {has.share ? (
                r.share !== undefined ? (
                  <span className="h-1 overflow-hidden rounded-full bg-border" aria-hidden>
                    <span className="block h-full rounded-full bg-tertiary" style={{ width: `${Math.max(4, r.share * 100)}%` }} />
                  </span>
                ) : (
                  <span />
                )
              ) : null}
              {has.diff ? (
                <>
                  <span className="text-right font-mono text-caption text-success tnum">{r.diff && r.diff.add > 0 ? `+${r.diff.add}` : ''}</span>
                  <span className="text-right font-mono text-caption text-danger tnum">{r.diff && r.diff.del > 0 ? `−${r.diff.del}` : ''}</span>
                </>
              ) : null}
              {has.value ? <Changed value={r.value ?? ''} from={before.get(p.key)} className="text-right font-mono text-xs text-secondary tnum" /> : null}
            </span>
          )
          return (
            <Presence key={p.key} p={p}>
              {click ? (
                <button type="button" onClick={click} title={clickTitle(r, act)} className={cn('block w-full rounded-md text-left vy-transition focus-visible:vy-focus-ring', ROW_HOVER)}>
                  {inner}
                </button>
              ) : (
                inner
              )}
            </Presence>
          )
        })}
      </div>
      {block.more ? <p className={cn('m-0 mt-1 text-xs text-tertiary', has.glyph && 'pl-[26px]')}>{block.more}</p> : null}
    </div>
  )
}

/* ─── table ─── */

/** "48", "+5,567", "−126", "$0.44", "89%", "31 min": a number, with its sign and unit. */
const NUMERIC = /^\s*[+\-−$€£]?\s*\d[\d,.]*\s*(%|[kKMB]|ms|s|min|h)?\s*$/

function Table({ block, was, act }: Props<'table'>) {
  const rowKey = (r: ViewBlockOf<'table'>['rows'][number]): string | undefined => r.id ?? r.cells[block.columns[0]!.id]
  const list = keyed(block.rows, rowKey, 't')
  const baseline = was ? keyed(was.rows, rowKey, 't') : null
  const rows = usePresence(list, baseline)
  const before = new Map((baseline ?? []).map((b) => [b.key, b.item.cells]))
  const anyLead = block.rows.some((r) => r.lead)
  // A column the model left unaligned but filled with numbers lines its digits up on the right.
  const end = new Set(block.columns.filter((c) => c.align === 'end' || (c.align === undefined && block.rows.length > 0 && block.rows.every((r) => NUMERIC.test(r.cells[c.id] ?? '')))).map((c) => c.id))
  return (
    <div>
      {block.title ? <Title>{block.title}</Title> : null}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className={cn('border-b', BORDER_DIVIDER)}>
              {block.columns.map((c) => (
                <th key={c.id} scope="col" className={cn('h-8 px-2 text-xs font-normal text-tertiary first:pl-0 last:pr-0', end.has(c.id) ? 'text-right' : 'text-left')}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const r = p.item
              const click = p.leaving ? null : clickOf(r, act)
              return (
                <tr
                  key={p.key}
                  inert={p.leaving || undefined}
                  title={click ? clickTitle(r, act) : undefined}
                  className={cn('border-b', BORDER_DIVIDER, p.leaving ? 'vy-view-fade-out' : p.enters && 'vy-view-rise', click && cn('cursor-pointer', ROW_HOVER))}
                  onClick={click ?? undefined}
                >
                  {block.columns.map((c, i) => {
                    const value = <Changed value={r.cells[c.id] ?? ''} from={before.get(p.key)?.[c.id]} />
                    return (
                      <td
                        key={c.id}
                        className={cn(
                          'h-9 px-2 first:pl-0 last:pr-0',
                          end.has(c.id) && 'text-right font-mono text-xs tnum',
                          !anyLead || r.lead ? (i === 0 ? 'text-fg-strong' : 'text-fg') : 'text-muted'
                        )}
                      >
                        {/* The row takes the click; its first cell is the button a keyboard reaches it by. */}
                        {click && i === 0 ? (
                          <button type="button" className="rounded-sm text-left focus-visible:vy-focus-ring">
                            {value}
                          </button>
                        ) : (
                          value
                        )}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ─── chart: the app's ChartBlock, without its own card ─── */

function Chart({ block }: { block: ViewBlockOf<'chart'> }) {
  return (
    <div>
      {block.spec.title ? <Title>{block.spec.title}</Title> : null}
      <div className="vy-reply-chart">
        <ChartBlock spec={{ ...block.spec, title: undefined }} />
      </div>
    </div>
  )
}

/* ─── checks ─── */

const CHECK_STATE = { pass: 'review', fail: 'failed', running: 'running', pending: 'queued' } as const
/** What the glyph says aloud: a passing check is not "Ready for review". */
const CHECK_WORD = { pass: 'Passed', fail: 'Failed', running: 'Running', pending: 'Not run yet' } as const

function Checks({ block }: { block: ViewBlockOf<'checks'> }) {
  // A block listing only some of them counts all of them.
  const met = block.passed ?? block.items.filter((c) => c.state === 'pass').length
  return (
    <div>
      <Title count={`${met}/${Math.max(block.total ?? 0, block.items.length)}`}>{block.title ?? 'Checks'}</Title>
      {/* Not ul/li: the reply's list rules (indent, item spacing) would reach in and break the edge. */}
      <div role="list" className="flex flex-col">
        {block.items.map((c, i) => (
          <div role="listitem" key={c.id ?? `${c.label}${i}`} className="flex min-h-7 items-center gap-3 text-sm">
            <StatusGlyph state={CHECK_STATE[c.state]} size={14} />
            <span className="sr-only">{CHECK_WORD[c.state]}: </span>
            <span className={c.state === 'fail' ? 'text-fg-strong' : c.state === 'pass' ? 'text-secondary' : 'text-muted'}>{c.label}</span>
          </div>
        ))}
      </div>
      {block.more ? <p className="m-0 mt-1 pl-[26px] text-xs text-tertiary">{block.more}</p> : null}
    </div>
  )
}

/* ─── note ─── */

function Note({ block, was }: { block: ViewBlockOf<'note'>; was: ViewBlockOf<'note'> | null }) {
  const tone = block.tone ?? 'muted'
  return (
    <p className="m-0 flex items-start gap-3 text-sm">
      <Icon
        name={tone === 'success' ? 'checkCircle' : tone === 'danger' ? 'warningCircle' : 'info'}
        size={14}
        className={cn('mt-[3px] shrink-0', tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-danger' : 'text-tertiary')}
      />
      <Changed value={block.text} from={was?.text} className={tone === 'muted' ? 'text-muted' : 'text-fg'} />
    </p>
  )
}

/* ─── actions: what you can tell it next, as buttons ─── */

function Actions({ block, act }: { block: ViewBlockOf<'actions'>; act: ViewActions }) {
  return (
    <div className={cn('border-t pt-3', BORDER_DIVIDER)}>
      {block.title ? <p className="m-0 text-sm font-medium text-fg-strong">{block.title}</p> : null}
      {block.body ? <p className="m-0 mt-0.5 text-sm text-secondary">{block.body}</p> : null}
      <div className={cn('flex flex-wrap gap-1.5', (block.title || block.body) && 'mt-2.5')}>
        {block.actions.map((a, i) => {
          // A web page's button names its site beside the label, so it opens without asking.
          const host = a.do?.action === 'link' ? linkHost(a.do.url) : null
          const click = clickOf(a, act, host != null)
          return (
            <Button
              key={`${a.label}${i}`}
              size="sm"
              variant={a.primary ? 'primary' : 'secondary'}
              disabled={!click}
              title={click ? clickTitle(a, act) : unavailable}
              onClick={click ?? undefined}
              trailingIcon={host ? 'external' : undefined}
            >
              {a.label}
              {/* In the button's own colour, quieter: a primary button's fill would swallow text-tertiary. */}
              {host ? <span className="font-normal opacity-70">{host}</span> : null}
            </Button>
          )
        })}
      </div>
    </div>
  )
}

/* ─── form: a question with real controls; submitting sends the answer ─── */

type Field = ViewBlockOf<'form'>['fields'][number]

const initial = (f: Field): string | boolean => (f.kind === 'choice' ? (f.value ?? f.options[0]!.id) : f.kind === 'switch' ? (f.value ?? false) : (f.value ?? ''))

function Form({ block, act }: { block: ViewBlockOf<'form'>; act: ViewActions }) {
  // Only what you changed is held here: a field that arrives later in the
  // stream, or with a reshape, starts from its own value.
  const [changed, setChanged] = useState<Record<string, string | boolean>>({})
  const valueOf = (f: Field): string | boolean => {
    const v = changed[f.id]
    // A choice a reshape took away is no longer an answer.
    return v === undefined || (f.kind === 'choice' && !f.options.some((o) => o.id === v)) ? initial(f) : v
  }
  const values: Record<string, string | boolean> = Object.fromEntries(block.fields.map((f) => [f.id, valueOf(f)]))
  const set = (id: string, v: string | boolean): void => setChanged((x) => ({ ...x, [id]: v }))
  const submit = (): void => {
    let text = block.submit.say
    for (const f of block.fields) {
      const v = values[f.id]
      const shown = f.kind === 'choice' ? (f.options.find((o) => o.id === v)?.label ?? String(v)) : f.kind === 'switch' ? (v ? 'yes' : 'no') : String(v ?? '')
      text = text.split(`{${f.id}}`).join(shown)
    }
    act.say?.(text)
  }
  return (
    <form
      className={cn('flex flex-col gap-3 border-t pt-3', BORDER_DIVIDER)}
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      {block.title ? <p className="m-0 text-sm font-medium text-fg-strong">{block.title}</p> : null}
      {block.fields.map((f) =>
        f.kind === 'choice' ? (
          <RadioList
            key={f.id}
            label={f.label}
            value={String(values[f.id])}
            onChange={(v) => set(f.id, v)}
            choices={f.options.map((o) => ({ value: o.id, label: o.label, description: o.hint }))}
          />
        ) : f.kind === 'switch' ? (
          <div key={f.id} className="flex items-center gap-3">
            <span className="min-w-0 flex-1">
              <span className="block text-sm text-fg">{f.label}</span>
              {f.hint ? <span className="block text-xs text-muted">{f.hint}</span> : null}
            </span>
            <Switch checked={Boolean(values[f.id])} onCheckedChange={(v) => set(f.id, v)} label={f.label} />
          </div>
        ) : (
          <label key={f.id} className="flex flex-col gap-1">
            <span className="text-xs text-muted">{f.label}</span>
            <Input value={String(values[f.id] ?? '')} placeholder={f.placeholder} onChange={(e) => set(f.id, e.target.value)} />
          </label>
        )
      )}
      <div>
        <Button type="submit" size="sm" variant="primary" disabled={!act.say} title={act.say ? undefined : unavailable}>
          {block.submit.label}
        </Button>
      </div>
    </form>
  )
}

/* ─── live: a source the app reads and keeps current ─── */

const LIVE_FROM: Record<ViewBlockOf<'live'>['source'], string> = {
  'git.changes': 'git',
  'git.branch': 'git',
  'git.commits': 'git',
  'pr.checks': 'GitHub',
  'task.changes': 'this task',
  'usage.spend': 'Usage',
  'usage.days': 'Usage'
}

/** Which block of its view this is: the key a live block reports its read under. */
export const BlockKeyContext = createContext<string | null>(null)
/** Where a live block reports what it read, so the view's Data and Copy show values, not a source name. */
export const LiveReadsContext = createContext<((key: string, block: ViewBlock) => void) | null>(null)

function LiveBlock({ block, act }: { block: ViewBlockOf<'live'>; act: ViewActions }) {
  const session = useRunSession()
  const { state, readAt, following, refresh } = useLiveSource(block, session.workspacePath, session.runId)
  const key = useContext(BlockKeyContext)
  const report = useContext(LiveReadsContext)
  useEffect(() => {
    if (state.status === 'ready' && key != null) report?.(key, state.block)
  }, [state, key, report])
  // Each new read is drawn against the one before it: a row that went away
  // folds, a number that moved washes once. The first read is drawn still.
  const reads = useRef<{ block: ViewBlock | null; prev: ViewBlock | null; n: number }>({ block: null, prev: null, n: 0 })
  if (state.status === 'ready' && state.block !== reads.current.block) {
    reads.current = { block: state.block, prev: reads.current.block, n: reads.current.block ? reads.current.n + 1 : 0 }
  }
  const { prev, n } = reads.current
  // Lists, tables, checks and charts carry the title themselves; stats and a note have no place for one.
  const titleHere = state.status === 'ready' && (state.block.type === 'stats' || state.block.type === 'note')
  return (
    <div data-live={block.source}>
      {block.title && titleHere ? <Title>{block.title}</Title> : null}
      {state.status === 'loading' ? (
        <p className="m-0 flex h-6 items-center text-caption" role="status">
          <span className="vy-text-live">Reading {LIVE_FROM[block.source]}</span>
        </p>
      ) : state.status === 'paused' ? (
        // An earlier answer's view: what it showed then was never kept, and now may not match the answer.
        <p className="m-0 flex min-h-6 flex-wrap items-center gap-x-2 text-caption text-tertiary">
          <span className="flex min-w-0 items-center gap-1">
            <Icon name="pause" size={11} className="shrink-0" />
            {block.title ? <span className="text-muted">{block.title}</span> : null}
            From an earlier answer, so not read from {LIVE_FROM[block.source]}
          </span>
          <Button size="xs" variant="ghost" icon="refresh" onClick={refresh}>
            Read now
          </Button>
        </p>
      ) : state.status === 'off' ? (
        <Note block={{ type: 'note', text: state.text, tone: 'muted' }} was={null} />
      ) : (
        <MotionProvider value={{ live: n > 0, settled: true }}>
          <Block key={n} block={state.block} was={prev} act={act} />
        </MotionProvider>
      )}
      {state.status === 'ready' && following ? (
        <p className="m-0 mt-1.5 flex items-center gap-1 text-caption text-tertiary">
          <Icon name="pulse" size={11} className="shrink-0" />
          Live from {LIVE_FROM[block.source]}
        </p>
      ) : state.status === 'ready' || (state.status === 'off' && !following) ? (
        // No longer following: says when it was read, so it is not taken for now.
        <p className="m-0 mt-1.5 flex items-center gap-2 text-caption text-tertiary">
          <span className="flex items-center gap-1">
            <Icon name="clock" size={11} className="shrink-0" />
            From {LIVE_FROM[block.source]}
            {readAt != null ? ` at ${formatDisplayTime(new Date(readAt).toISOString())}` : null}
          </span>
          <Button size="xs" variant="ghost" icon="refresh" onClick={refresh}>
            Refresh
          </Button>
        </p>
      ) : null}
    </div>
  )
}
