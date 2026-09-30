import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '@renderer/lib/icons'
import { Button, DiffStat, IconButton, StatusGlyph, StepMarker, cn, pushToast } from '@renderer/lib/ui'
import { QUESTION_GATE_BODY, QUESTION_GATE_FOOTER, QUESTION_GATE_HEADER, QUESTION_GATE_SURFACE } from '@renderer/lib/utils/layout'
import { INSTANCES, type Item, type Step } from './data'
import { CheckRow, Path, Prose } from './parts'
import { diffsOf, recordOf, taskOf } from './runtime'
import { useActions, useAgents } from './store'

/*
  The record, in Cursor's register: the brief in a quiet box, work as single
  verb-first lines ("Read src/server.ts"), lookups folded into "Explored 6
  files, 2 searches", the agent's own words as plain prose, edits as file
  chips, commands in bordered cards. What it adds is the plan: steps head
  their own work, and a finished step folds to one line.
*/

export function Record({ id }: { id: string }) {
  const { s } = useAgents()
  const t = taskOf(s, id)
  const data = recordOf(s, id)
  const followUps = s.followUps[id] ?? []
  const settled = !!data.result && (t.state === 'review' || t.state === 'done')
  return (
    <div className="flex flex-col gap-4 pb-6 pt-4">
      <Brief id={id} text={data.brief} attachments={data.attachments} />
      {data.checks.length && !data.result ? (
        <ul aria-label="Done when" className="-mt-1 px-1">
          {data.checks.map((c) => (
            <CheckRow key={c.text} c={c} dense />
          ))}
        </ul>
      ) : null}
      {data.setup ? <Items items={data.setup} agent={id} /> : null}
      {data.steps.length ? (
        <ol className="flex flex-col gap-1" aria-label="Plan">
          {data.steps.map((st) => (
            <StepBlock key={st.n} st={st} agent={id} />
          ))}
        </ol>
      ) : null}
      {data.result ? <Result id={id} /> : null}
      {followUps.map((f, i) => (
        <FollowUp key={i} text={f} live={i === followUps.length - 1 && t.state === 'running'} />
      ))}
      {t.state === 'stopped' && !settled ? <Stopped id={id} /> : null}
    </div>
  )
}

function Brief({ id, text, attachments }: { id: string; text: string; attachments?: string[] }) {
  const { d } = useAgents()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(text)
  const field = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (editing) field.current?.focus()
  }, [editing])

  if (editing) {
    return (
      <div className="rounded-lg border border-border-strong bg-card">
        <textarea
          ref={field}
          aria-label="Edit the brief"
          value={draft}
          rows={3}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditing(false)
            if (e.key === 'Enter' && e.ctrlKey) (e.preventDefault(), rerun())
          }}
          className="block w-full resize-none bg-transparent px-3 pt-2.5 text-sm leading-[22px] text-fg-strong outline-none"
        />
        <div className="flex items-center gap-1.5 px-2 pb-2 pt-1">
          <span className="flex-1 px-1 text-caption text-tertiary">Rewinds to the brief: its edits are undone first, and your own changes stay.</span>
          <Button size="xs" variant="ghost" onClick={() => (setDraft(text), setEditing(false))}>
            Cancel
          </Button>
          <Button size="xs" variant="primary" kbd={['Ctrl', '↵']} onClick={rerun}>
            Rerun
          </Button>
        </div>
      </div>
    )
  }

  function rerun(): void {
    if (!draft.trim()) return
    d({ type: 'rerun', agent: id, brief: draft.trim() })
    setEditing(false)
    pushToast('Rerunning from the edited brief', { icon: 'undo' })
  }

  return (
    <div className="group relative rounded-lg border border-border bg-card px-3 py-2.5">
      <p className="pr-6 text-sm leading-[22px] text-fg-strong">{text}</p>
      {attachments?.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {attachments.map((f) => (
            <span key={f} className="inline-flex h-6 items-center gap-1.5 rounded-md border border-border bg-bg px-2 text-caption text-secondary">
              <Icon name="doc" size={12} className="text-tertiary" />
              {f}
            </span>
          ))}
        </div>
      ) : null}
      <span className="absolute right-1.5 top-1.5 opacity-0 vy-transition group-hover:opacity-100 group-focus-within:opacity-100">
        <IconButton icon="edit" label="Edit and rerun" size="sm" tone="onSurface" onClick={() => (setDraft(text), setEditing(true))} />
      </span>
    </div>
  )
}

function StepBlock({ st, agent }: { st: Step; agent: string }) {
  const live = st.state === 'running' || st.state === 'needs' || st.state === 'failed' || st.state === 'stopped'
  const [open, setOpen] = useState(live)
  useEffect(() => {
    if (live) setOpen(true)
  }, [live])
  const hasItems = st.items.length > 0
  const foldable = hasItems && !live
  return (
    <li data-step={st.n} data-step-state={st.state}>
      {foldable ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="group -mx-2 flex min-h-8 w-[calc(100%+16px)] items-center gap-2.5 rounded-md px-2 py-1 text-left vy-transition hover:bg-surface focus-visible:vy-focus-ring"
        >
          <StepHead st={st} live={live} open={open} foldable />
        </button>
      ) : (
        <div className="-mx-2 flex min-h-8 w-[calc(100%+16px)] items-center gap-2.5 px-2 py-1">
          <StepHead st={st} live={live} open={open} foldable={false} />
        </div>
      )}
      {hasItems ? (
        <div className="ag-fold" data-open={open}>
          <div>
            <div className="ml-[26px] pb-2 pt-1.5">
              <Items items={st.items} agent={agent} />
            </div>
          </div>
        </div>
      ) : null}
    </li>
  )
}

function StepHead({ st, live, open, foldable }: { st: Step; live: boolean; open: boolean; foldable: boolean }) {
  return (
    <>
      <StepMarker state={st.state} n={st.n} />
      <span className={cn('min-w-0 flex-1 truncate text-sm', live ? 'font-medium text-fg-strong' : st.state === 'queued' ? 'text-muted' : 'text-fg')}>{st.title}</span>
      {st.summary && !open ? <span className="shrink-0 text-caption text-tertiary">{st.summary}</span> : null}
      {st.time ? <span className="shrink-0 font-mono text-caption tnum text-tertiary">{st.time}</span> : null}
      {foldable ? <Icon name={open ? 'chevron' : 'chevronRight'} size={11} className="shrink-0 text-tertiary opacity-0 group-hover:opacity-100" /> : null}
    </>
  )
}

export function Items({ items, agent }: { items: Item[]; agent: string }) {
  return (
    <div className="flex flex-col gap-2.5">
      {items.map((it, i) => (
        <ItemView key={i} it={it} agent={agent} />
      ))}
    </div>
  )
}

function ItemView({ it, agent }: { it: Item; agent: string }) {
  switch (it.k) {
    case 'thought':
      return <WorkLine verb="Thought" obj={`${it.secs}s`} mono />
    case 'look':
      return <WorkLine verb={it.verb} obj={it.obj} />
    case 'explored':
      return <Explored files={it.files} searches={it.searches} items={it.items} />
    case 'say':
      return <Prose text={it.text} />
    case 'edit':
      return <EditChip path={it.path} add={it.add} del={it.del} created={it.created} />
    case 'cmd':
      return <CommandCard cmd={it.cmd} state={it.state} exit={it.exit} time={it.time} out={it.out} />
    case 'approval':
      return <Approval agent={agent} cmd={it.cmd} why={it.why} allowAs={it.allowAs} />
    case 'question':
      return <Question agent={agent} n={it.n} of={it.of} q={it.q} options={it.options} />
    case 'instances':
      return <InstancesBlock />
    case 'error':
      return <ErrorBlock agent={agent} title={it.title} detail={it.detail} />
    case 'live':
      return <Live text={it.text} />
    case 'you':
      return <You kind={it.kind} text={it.text} />
  }
}

/** "Read src/server.ts": the verb is what you scan, the object is detail. */
function WorkLine({ verb, obj, mono = false }: { verb: string; obj: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5 text-sm">
      <span className="shrink-0 text-secondary">{verb}</span>
      <span className={cn('min-w-0 truncate text-tertiary', mono ? 'font-mono text-xs tnum' : '')}>{obj}</span>
    </div>
  )
}

/** What it is doing this second: the words themselves carry the motion. */
function Live({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 text-sm" role="status">
      <StatusGlyph state="running" size={13} />
      <span className="vy-text-live">{text}</span>
    </div>
  )
}

/** Your words inside the record: an answer or a steer, marked as yours without a bubble. */
function You({ kind, text }: { kind: 'steer' | 'answer'; text: string }) {
  return (
    <div className="flex items-start gap-2 border-l-2 border-accent pl-2.5">
      <div className="min-w-0">
        <div className="text-caption text-tertiary">{kind === 'answer' ? 'You answered' : 'You steered'}</div>
        <div className="text-sm text-fg-strong">{text}</div>
      </div>
    </div>
  )
}

function Explored({ files, searches, items }: { files: number; searches: number; items: { verb: string; obj: string }[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="group -mx-1 inline-flex items-baseline gap-1.5 rounded-sm px-1 text-sm focus-visible:vy-focus-ring">
        <span className="text-secondary group-hover:text-fg-strong">Explored</span>
        <span className="text-tertiary group-hover:text-secondary">
          {files} files, {searches} searches
        </span>
        <Icon name={open ? 'chevron' : 'chevronRight'} size={10} className="self-center text-tertiary" />
      </button>
      <div className="ag-fold" data-open={open}>
        <div>
          <div className="ml-1 mt-1.5 flex flex-col gap-1 border-l border-border pl-3">
            {items.map((l, i) => (
              <WorkLine key={i} verb={l.verb} obj={l.obj} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/** An edit: one bordered chip, like the file it names. Opens the file in the side pane's Files tab. */
export function EditChip({ path, add, del, created }: { path: string; add: number; del: number; created?: boolean }) {
  const { s, d } = useAgents()
  const plan = path.startsWith('plans/')
  const mark = s.fileMarks[`${s.agent}:${path}`]
  return (
    <button
      type="button"
      onClick={() => (plan ? d({ type: 'ws', tab: 'plan' }) : d({ type: 'file', path }))}
      className="group flex h-9 w-full min-w-0 items-center gap-2 rounded-lg border border-border bg-bg px-3 text-left text-sm vy-transition hover:border-border-strong hover:bg-card focus-visible:vy-focus-ring"
    >
      <Icon name={created ? 'fileNew' : 'file'} size={15} className="shrink-0 text-tertiary" />
      <Path path={path} strong className={cn('flex-1', mark === 'undone' ? 'line-through decoration-tertiary' : '')} />
      {mark ? <span className="shrink-0 text-caption text-tertiary">{mark === 'kept' ? 'Kept' : 'Undone'}</span> : null}
      <DiffStat add={add} del={del} className="shrink-0" />
      <Icon name="chevronRight" size={11} className="shrink-0 text-tertiary opacity-0 vy-transition group-hover:opacity-100" />
    </button>
  )
}

/** Commands keep their bordered card: output needs a frame to be read as output. */
export function CommandCard({ cmd, state, exit, time, out }: { cmd: string; state: 'running' | 'ok' | 'fail' | 'stopped'; exit?: number; time: string; out: string[] }) {
  const { d } = useAgents()
  const [secs, setSecs] = useState(parseInt(time, 10) || 0)
  const [open, setOpen] = useState(state !== 'ok' || out.length > 0)
  useEffect(() => {
    if (state !== 'running') return
    const t = setInterval(() => setSecs((x) => x + 1), 1000)
    return () => clearInterval(t)
  }, [state])
  const body = out.length > 0
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className={cn('flex h-8 items-center gap-2 bg-card px-3', body && open ? 'border-b border-border/60' : '')}>
        {body ? (
          <button type="button" aria-expanded={open} aria-label={open ? 'Hide output' : 'Show output'} onClick={() => setOpen(!open)} className="-ml-1 grid size-5 place-items-center rounded-sm text-tertiary hover:text-fg focus-visible:vy-focus-ring">
            <Icon name={open ? 'chevron' : 'chevronRight'} size={10} />
          </button>
        ) : null}
        <span className="font-mono text-xs text-tertiary">$</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{cmd}</span>
        {state === 'running' ? (
          <span className="vy-text-live shrink-0 text-caption">Running · {secs}s</span>
        ) : state === 'stopped' ? (
          <span className="shrink-0 text-caption text-tertiary">Stopped · {time}</span>
        ) : (
          <span className={cn('shrink-0 font-mono text-caption tnum', state === 'fail' ? 'text-danger' : 'text-tertiary')}>
            exit {exit ?? (state === 'ok' ? 0 : 1)} · {time}
          </span>
        )}
        <IconButton icon="expand" label="Open in Terminal" size="xs" tone="muted" onClick={() => d({ type: 'ws', tab: 'terminal' })} />
      </div>
      {body && open ? (
        <pre className="max-h-[164px] overflow-hidden bg-sunken px-3 py-2 font-mono text-caption leading-mono text-secondary">
          {out.map((l, i) => (
            <div key={i} className="min-h-[1lh]">
              <OutLine l={l} />
              {state === 'running' && i === out.length - 1 ? <span className="ag-caret ml-1 inline-block h-3 w-1.5 translate-y-0.5 bg-fg" /> : null}
            </div>
          ))}
        </pre>
      ) : null}
    </div>
  )
}

/** Test output reads at a glance: a pass mark in the success hue, a failure in danger, the rest quiet. */
export function OutLine({ l }: { l: string }) {
  const pass = l.match(/^(\s*)(✓|✔)(.*)$/)
  if (pass) {
    return (
      <span className="text-fg">
        {pass[1]}
        <span className="text-success">{pass[2]}</span>
        {pass[3]}
      </span>
    )
  }
  const fail = l.match(/^(\s*)(✗|✘)(.*)$/)
  if (fail) {
    return (
      <span className="text-fg-strong">
        {fail[1]}
        <span className="text-danger">{fail[2]}</span>
        {fail[3]}
      </span>
    )
  }
  if (/Error|Timeout|expected/.test(l)) return <span className="text-danger">{l}</span>
  if (l.includes('❯')) return <span className="text-fg-strong">{l}</span>
  return <>{l}</>
}

/** The one accent block in a record. Answer it here, in the list, or in the Inbox. */
function Approval({ agent, cmd, why, allowAs }: { agent: string; cmd: string; why: string; allowAs: string }) {
  const { s } = useAgents()
  const act = useActions()
  const verdict = s.allowed[agent]
  if (verdict === 'allowed' || verdict === 'always') {
    return (
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center gap-1.5 text-xs text-tertiary">
          <Icon name="check" size={12} />
          {verdict === 'always' ? (
            <>
              Allowed by you · always for <span className="font-mono">{allowAs}</span> in this workspace
            </>
          ) : (
            'Allowed by you just now'
          )}
        </div>
        <CommandCard cmd={cmd} state="running" time="0s" out={['> acme@ db:migrate', '> drizzle-kit migrate --env staging', '', 'Applying 0043_sessions.sql']} />
      </div>
    )
  }
  if (verdict === 'denied') {
    return (
      <div className="flex items-center gap-1.5 text-xs text-tertiary">
        <Icon name="close" size={12} />
        Denied by you
      </div>
    )
  }
  return (
    <div className={cn(QUESTION_GATE_SURFACE, 'ag-rise')} role="group" aria-label="Needs you: approve a command">
      <div className={QUESTION_GATE_HEADER}>
        <Icon name="hand" size={14} className="text-accent" />
        <span className="font-medium text-fg-strong">Wants to run a command</span>
        <span className="flex-1" />
        <span className="text-muted">{why}</span>
      </div>
      <div className={QUESTION_GATE_BODY}>
        <div className="rounded-md bg-sunken px-2.5 py-2 font-mono text-xs text-fg-strong">
          <span className="mr-2 text-tertiary">$</span>
          {cmd}
        </div>
      </div>
      <div className={QUESTION_GATE_FOOTER}>
        <Button size="sm" variant="primary" onClick={() => act.decide(agent, 'allowed')}>
          Allow
        </Button>
        <Button size="sm" variant="secondary" onClick={() => act.decide(agent, 'always')}>
          Always allow <span className="font-mono text-caption">{allowAs}</span>
        </Button>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => act.decide(agent, 'denied')}>
          Deny
        </Button>
      </div>
    </div>
  )
}

/** Numbered answers: 1–3 picks, Enter continues. The box below takes an answer of your own. */
function Question({ agent, n, of, q, options }: { agent: string; n: number; of: number; q: string; options: string[] }) {
  const { s, d } = useAgents()
  const chosen = s.choice[agent] ?? null
  const answer = (text: string): void => d({ type: 'answer', agent, text })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return
      const k = Number(e.key)
      if (k >= 1 && k <= options.length) d({ type: 'choose', agent, n: k })
      if (e.key === 'Enter' && chosen) d({ type: 'answer', agent, text: options[chosen - 1] })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [d, agent, options, chosen])
  return (
    <div className={cn(QUESTION_GATE_SURFACE, 'ag-rise')} role="group" aria-label="Needs you: a question">
      <div className={QUESTION_GATE_HEADER}>
        <Icon name="question" size={14} className="text-accent" />
        <span className="font-medium text-fg-strong">Question</span>
        <span className="tnum text-muted">
          {n} of {of}
        </span>
      </div>
      <div className={QUESTION_GATE_BODY}>
        <p className="mb-2 text-sm font-medium text-fg-strong">{q}</p>
        <div role="radiogroup" aria-label={q} className="flex flex-col gap-0.5">
          {options.map((o, i) => {
            const on = chosen === i + 1
            return (
              <button
                key={o}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => d({ type: 'choose', agent, n: i + 1 })}
                onDoubleClick={() => answer(o)}
                className={cn(
                  '-mx-1 flex h-8 items-center gap-2.5 rounded-md px-1 text-left text-sm vy-transition focus-visible:vy-focus-ring',
                  on ? 'bg-surface-2 text-fg-strong' : 'text-fg hover:bg-surface'
                )}
              >
                <Keycap n={i + 1} on={on} />
                <span className="min-w-0 flex-1 truncate">{o}</span>
                {on ? <Icon name="check" size={14} className="text-accent" /> : null}
              </button>
            )
          })}
        </div>
      </div>
      <div className={QUESTION_GATE_FOOTER}>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => answer('Skipped — use the plan’s default')}>
          Skip
        </Button>
        <Button size="sm" variant="primary" disabled={chosen == null} kbd={chosen ? ['↵'] : undefined} onClick={() => chosen && answer(options[chosen - 1])}>
          Continue
        </Button>
      </div>
    </div>
  )
}

/** Kbd with a selected state: two looks, one ternary, never an override. */
function Keycap({ n, on }: { n: number; on: boolean }) {
  return (
    <kbd
      className={cn(
        'inline-grid h-[18px] min-w-[18px] place-items-center rounded-sm border px-1 font-mono text-2xs leading-none',
        on ? 'border-accent bg-accent-soft text-accent' : 'border-border bg-card text-muted'
      )}
    >
      {n}
    </kbd>
  )
}

/** A task's instances, one line each; each opens in place of the record. */
function InstancesBlock() {
  const { d } = useAgents()
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex h-8 items-center gap-2 border-b border-border/60 bg-card px-3 text-xs">
        <Icon name="crew" size={14} className="text-tertiary" />
        <span className="font-medium text-fg">{INSTANCES.length} instances</span>
        <span className="text-tertiary">· one route file each</span>
      </div>
      <ul>
        {INSTANCES.map((i) => {
          return (
            <li key={i.id} className="border-b border-border/60 last:border-b-0">
              <button
                type="button"
                onClick={() => d({ type: 'instance', id: i.id })}
                className="flex h-9 w-full min-w-0 items-center gap-2.5 px-3 text-left text-sm vy-transition hover:bg-surface focus-visible:vy-focus-ring"
              >
                <StatusGlyph state={i.state} size={14} />
                <span className="shrink-0 font-mono text-xs text-fg-strong">{i.title.split('/').pop()}</span>
                <span className={cn('min-w-0 flex-1 truncate text-xs', i.state === 'running' ? 'vy-text-live' : 'text-tertiary')}>{i.verb}</span>
                <Icon name="chevronRight" size={11} className="shrink-0 text-tertiary" />
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** What broke, in words, with the two ways forward. */
function ErrorBlock({ agent, title, detail }: { agent: string; title: string; detail: string }) {
  const { d } = useAgents()
  return (
    <div className="rounded-lg border border-danger bg-danger-soft px-3 py-2.5" role="alert">
      <div className="flex items-center gap-2 text-sm font-medium text-fg-strong">
        <Icon name="warningCircle" size={15} weight="fill" className="text-danger" />
        {title}
      </div>
      <Prose text={detail} small className="mt-1" />
      <div className="mt-2.5 flex gap-1.5">
        <Button size="xs" variant="secondary" icon="retry" onClick={() => d({ type: 'resume', agent })}>
          Retry
        </Button>
        <Button size="xs" variant="ghost" onClick={() => d({ type: 'draft', text: 'Mock Redis in the search tests instead of needing a live server.' })}>
          Ask it to mock Redis
        </Button>
      </div>
    </div>
  )
}

function Stopped({ id }: { id: string }) {
  const { s, d } = useAgents()
  const act = useActions()
  const t = taskOf(s, id)
  const files = diffsOf(s, id).length
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3 text-xs text-muted">
      <StatusGlyph state="stopped" size={14} />
      <span className="flex-1">
        {t.line}
        {files ? ` · ${files} ${files === 1 ? 'file' : 'files'} changed` : ''}
      </span>
      {files ? (
        <Button size="xs" variant="ghost" icon="undo" onClick={() => act.undoAll(id)}>
          Undo its changes
        </Button>
      ) : null}
      <Button size="xs" variant="secondary" icon="play" onClick={() => d({ type: 'resume', agent: id })}>
        Resume
      </Button>
    </div>
  )
}

function FollowUp({ text, live }: { text: string; live: boolean }) {
  return (
    <div className="ag-rise flex flex-col gap-3 border-t border-border/60 pt-4">
      <div className="rounded-lg border border-border bg-card px-3 py-2.5 text-sm leading-[22px] text-fg-strong">{text}</div>
      {live ? <Live text="Thinking" /> : null}
    </div>
  )
}

function Result({ id }: { id: string }) {
  const { s, d } = useAgents()
  const t = taskOf(s, id)
  const data = recordOf(s, id)
  const r = data.result!
  const [rated, setRated] = useState<'up' | 'down' | null>(null)
  return (
    <section aria-label="Result" className="flex flex-col gap-3 border-t border-border/60 pt-4">
      <div className="flex items-center gap-1.5 text-xs text-tertiary">
        <Icon name="timer" size={13} />
        Worked for <span className="font-mono tnum">{data.worked}</span>
      </div>
      <Heading>Summary</Heading>
      <Prose text={r.text} />
      {r.files.length ? (
        <div className="flex flex-col gap-1.5">
          {r.files.map((f) => (
            <EditChip key={f.path} path={f.path} add={f.add} del={f.del} />
          ))}
        </div>
      ) : null}
      <Heading>Checks</Heading>
      <ul className="-mt-1">
        {data.checks.map((c) => (
          <CheckRow key={c.text} c={c} />
        ))}
      </ul>
      {t.outcome ? (
        <div className="flex items-center gap-2 rounded-md bg-surface px-3 py-2 text-xs">
          <Icon name={t.outcome.kind === 'committed' ? 'commit' : t.outcome.kind === 'kept' ? 'check' : 'undo'} size={14} className="text-tertiary" />
          <span className="flex-1 text-fg">
            {t.outcome.kind === 'committed' ? (
              <>
                Committed <span className="font-mono">{t.outcome.sha}</span> to {t.branch}
              </>
            ) : t.outcome.kind === 'kept' ? (
              'Kept · not committed yet'
            ) : (
              'Undone — the files are back as they were'
            )}
          </span>
          {t.outcome.kind === 'kept' ? (
            <Button size="xs" variant="secondary" icon="commit" onClick={() => (d({ type: 'ws', tab: 'review' }), d({ type: 'commit', open: true }))}>
              Commit…
            </Button>
          ) : t.outcome.kind === 'committed' ? (
            <Button size="xs" variant="ghost" icon="pullRequest" onClick={() => d({ type: 'ws', tab: 'pr' })}>
              Pull request
            </Button>
          ) : null}
        </div>
      ) : t.state === 'review' ? (
        <div className="flex items-center gap-1.5">
          <span className="flex-1 text-xs text-tertiary">Nothing is kept until you say so.</span>
          <Button size="xs" variant="secondary" trailingIcon="arrowRight" onClick={() => (d({ type: 'sideFull', on: false }), d({ type: 'ws', tab: 'review' }))}>
            Review changes
          </Button>
        </div>
      ) : null}
      <div className="flex items-center gap-2 pt-1">
        <span className="min-w-0 flex-1 truncate font-mono text-caption tnum text-tertiary">{r.receipt}</span>
        <IconButton icon="thumbsUp" label="Good run" size="sm" tone="muted" active={rated === 'up'} onClick={() => setRated('up')} />
        <IconButton icon="thumbsDown" label="Bad run" size="sm" tone="muted" active={rated === 'down'} onClick={() => setRated('down')} />
        <IconButton icon="copy" label="Copy the summary" size="sm" tone="muted" onClick={() => pushToast('Summary copied', { icon: 'copy' })} />
      </div>
    </section>
  )
}

function Heading({ children }: { children: ReactNode }) {
  return <h3 className="text-sm font-semibold text-fg-strong">{children}</h3>
}
