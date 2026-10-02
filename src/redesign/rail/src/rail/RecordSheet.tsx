import { useState } from 'react'
import { Icon } from '@renderer/lib/icons'
import { Button, DiffStat, IconButton, StatusGlyph, StepMarker, cn, type TaskState } from '@renderer/lib/ui'
import { QUESTION_GATE_BODY, QUESTION_GATE_FOOTER, QUESTION_GATE_HEADER, QUESTION_GATE_SURFACE } from '@renderer/lib/utils/layout'
import { base, type DiffLine, type Task, type WorkItem } from '../data'
import { Empty, GUTTER, ROW, SCROLL, Section } from './parts'
import { useRail, type Steer } from './store'

/*
  The record keeps its shape — brief, the work under each step, the result —
  and keeps terminal and diff output in bordered cards. What changes is that
  every file, command and diff in it is a portal: it opens as a sheet beside
  the record instead of replacing it, and any line you select can be pinned
  to the lens.
*/

/** A file name that opens its sheet. */
export function Portal({ path, className }: { path: string; className?: string }) {
  const { d } = useRail()
  return (
    <button
      type="button"
      onClick={() => d({ type: 'open', kind: 'file', path })}
      className={cn('rounded-sm font-mono text-xs text-fg underline decoration-border-strong underline-offset-[3px] vy-transition hover:decoration-fg focus-visible:vy-focus-ring', className)}
    >
      {base(path)}
    </button>
  )
}

export function DiffLines({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="py-1 font-mono text-xs leading-mono">
      {lines.map((l, i) => (
        <div key={i} className={cn('flex whitespace-pre', l.sign === '+' ? 'diff-row-add' : l.sign === '−' ? 'diff-row-del' : '')}>
          <span className="w-10 shrink-0 select-none pr-2 text-right text-tertiary tnum">{l.n ?? ''}</span>
          <span className={cn('w-4 shrink-0 select-none', l.sign === '+' ? 'text-success' : l.sign === '−' ? 'text-danger' : 'text-tertiary')}>{l.sign}</span>
          <span className={l.sign === '−' ? 'text-secondary' : 'text-fg'}>{l.text}</span>
        </div>
      ))}
    </div>
  )
}

function Work({ item }: { item: WorkItem }) {
  const { d } = useRail()
  switch (item.kind) {
    case 'note':
      return <p className="m-0 max-w-[62ch] text-sm text-secondary">{item.text}</p>
    case 'reads':
      return (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="font-medium text-fg-strong">{item.verb}</span>
          {item.files.map((f) => (
            <Portal key={f} path={f} />
          ))}
        </div>
      )
    case 'agent':
      return (
        <div className="flex h-7 items-center gap-2 text-sm">
          <StatusGlyph state={item.state} size={14} label />
          <span className="rounded-sm bg-surface px-1.5 font-mono text-caption text-secondary">{item.id}</span>
          <span className="min-w-0 flex-1 truncate text-fg">{item.title}</span>
          <span className="font-mono text-caption text-tertiary tnum">{item.time}</span>
        </div>
      )
    case 'terminal':
      return (
        <div className="overflow-hidden rounded-lg border border-border bg-bg">
          <div className="flex h-8 items-center gap-2 border-b border-border pl-3 pr-1">
            <Icon name="terminal" size={13} className="shrink-0 text-muted" />
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{item.command}</span>
            {item.exit === null ? (
              <span className="vy-text-live text-caption">running</span>
            ) : (
              <span className={cn('font-mono text-caption tnum', item.exit === 0 ? 'text-tertiary' : 'text-danger')}>exit {item.exit}</span>
            )}
            <IconButton
              icon="external"
              size="sm"
              tone="muted"
              label="Open in the Terminal sheet"
              onClick={() => d({ type: 'open', kind: 'terminal' })}
            />
            <IconButton
              icon="pin"
              size="sm"
              tone="muted"
              label="Pin this output to the lens"
              onClick={() => d({ type: 'pin', item: { kind: 'terminal', label: item.command.split(' ').slice(0, 3).join(' '), detail: item.lines[0] } })}
            />
          </div>
          <div className="overflow-x-auto px-3 py-2 font-mono text-xs leading-mono text-secondary" data-ask-source="Terminal output">
            {item.lines.map((l, i) => (
              <div key={i} className="min-h-[1lh] whitespace-pre">
                {l}
              </div>
            ))}
          </div>
        </div>
      )
    case 'diff':
      return (
        <div className="overflow-hidden rounded-lg border border-border bg-bg">
          <div className="flex h-8 items-center gap-2 border-b border-border pl-3 pr-1">
            <Icon name="diff" size={13} className="shrink-0 text-muted" />
            <Portal path={item.file} />
            <DiffStat add={item.add} del={item.del} />
            <span className="flex-1" />
            <IconButton icon="columns" size="sm" tone="muted" label="Open in Changes" onClick={() => d({ type: 'open', kind: 'changes' })} />
          </div>
          <div className="overflow-x-auto" data-ask-source={base(item.file)}>
            <DiffLines lines={item.lines} />
          </div>
        </div>
      )
  }
}

function SteerRow({ steer }: { steer: Steer }) {
  const lands = steer.mode === 'ask' ? 'Question · answered without changes' : steer.mode === 'queue' ? 'Queued · runs after this task' : 'Steer · lands after this step'
  return (
    <div className="flex items-start gap-2 rounded-md bg-surface px-3 py-2 animate-fade-in">
      <Icon name={steer.mode === 'ask' ? 'question' : 'enter'} size={14} className="mt-[3px] shrink-0 text-muted" />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-fg-strong">{steer.text}</div>
        <div className="text-caption text-tertiary">
          {lands}
          {steer.target ? ` · about ${steer.target}` : ''}
          {steer.context > 0 ? ` · ${steer.context} pinned` : ''}
        </div>
      </div>
    </div>
  )
}

function Gate({ task }: { task: Task }) {
  const { s, d } = useRail()
  const choice = s.gate[task.id]
  if (!task.gate) return null
  if (choice) {
    return (
      <div className="flex items-center gap-2 text-sm text-secondary animate-fade-in">
        <Icon name={choice === 'deny' ? 'xCircle' : 'checkCircle'} size={15} className={choice === 'deny' ? 'text-danger' : 'text-success'} />
        {choice === 'deny' ? 'You denied it. I’ll stop here and report.' : choice === 'task' ? 'Allowed for the rest of this task.' : 'Allowed once.'}
      </div>
    )
  }
  return (
    <div className={QUESTION_GATE_SURFACE} role="group" aria-label="Needs you">
      <div className={QUESTION_GATE_HEADER}>
        <Icon name="hand" size={13} className="text-accent" />
        <span className="font-medium text-accent">Needs you</span>
        <span className="text-tertiary">· approval · asked 2m ago</span>
      </div>
      <div className={QUESTION_GATE_BODY}>
        <div className="text-heading font-medium text-fg-strong">{task.gate.title}</div>
        <p className="m-0 mt-1 text-sm text-secondary">{task.gate.why}</p>
        <div className="mt-3 overflow-x-auto rounded-md border border-border bg-sunken px-3 py-2 font-mono text-xs text-fg" data-ask-source="The command">
          <span className="select-none text-tertiary">$ </span>
          {task.gate.command}
        </div>
      </div>
      <div className={QUESTION_GATE_FOOTER}>
        <Button variant="primary" size="sm" onClick={() => d({ type: 'gate', choice: 'once' })}>
          Allow once
        </Button>
        <Button variant="secondary" size="sm" onClick={() => d({ type: 'gate', choice: 'task' })}>
          Allow for this task
        </Button>
        <Button variant="ghost" size="sm" onClick={() => d({ type: 'gate', choice: 'deny' })}>
          Deny
        </Button>
        <span className="flex-1" />
        <span className="text-caption text-tertiary">Or type a reply in the lens</span>
      </div>
    </div>
  )
}

function stepState(task: Task, st: TaskState, choice: string | undefined): TaskState {
  if (st === 'needs' && choice) return choice === 'deny' ? 'stopped' : 'running'
  return st
}

export function RecordBody({ task }: { task: Task }) {
  const { s } = useRail()
  const steers = (s.steers[task.id] ?? []).filter((x) => x.mode !== 'run')
  const choice = s.gate[task.id]
  const live = task.steps.findIndex((st) => st.state === 'running' || st.state === 'needs')
  const [open, setOpen] = useState<Set<number>>(() => new Set(task.steps.map((st, i) => (st.state === 'done' && task.state === 'review' ? -1 : i)).filter((i) => i >= 0 && i >= task.steps.length - 3)))
  const met = task.checks.filter((c) => c.met).length

  const toggle = (i: number): void => {
    const next = new Set(open)
    if (next.has(i)) next.delete(i)
    else next.add(i)
    setOpen(next)
  }

  if (task.steps.length === 0) {
    return (
      <Empty icon="list" title={task.title}>
        This mockup carries full records for the first three tasks in the navigator.
      </Empty>
    )
  }

  return (
    <div className={SCROLL} data-ask-source="Record">
      <div className={cn(GUTTER, 'max-w-[840px] pb-10 pt-5')}>
        <p className="m-0 max-w-[70ch] text-heading leading-relaxed text-fg-strong">{task.brief}</p>

        {task.checks.length > 0 ? (
          <Section label="Done when" count={`${met}/${task.checks.length}`}>
            <ul className="m-0 list-none p-0">
              {task.checks.map((c) => (
                <li key={c.text} className="flex min-h-7 items-start gap-3 py-1 text-sm">
                  <span className="flex h-5 w-[18px] shrink-0 items-center justify-center">
                    <StatusGlyph state={c.met ? 'done' : 'queued'} size={14} label />
                  </span>
                  <span className={cn('min-w-0 flex-1', c.met ? 'text-secondary' : 'text-fg')}>
                    {c.text}
                    {c.evidence ? <span className="ml-2 font-mono text-caption text-tertiary">{c.evidence}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        <Section label="Work" count={task.elapsed}>
          <ol className="m-0 list-none p-0">
            {task.steps.map((st, i) => {
              const state = stepState(task, st.state, choice)
              const isOpen = open.has(i)
              const hasWork = st.work.length > 0 || (i === live && (steers.length > 0 || Boolean(task.gate)))
              return (
                <li key={st.title} className="border-b border-border/60 last:border-b-0">
                  <button
                    type="button"
                    aria-expanded={hasWork ? isOpen : undefined}
                    disabled={!hasWork}
                    onClick={() => toggle(i)}
                    className={cn(ROW, 'h-10 w-[calc(100%+16px)] gap-3 text-left vy-transition focus-visible:vy-focus-ring enabled:hover:bg-surface')}
                  >
                    <StepMarker state={state} n={i + 1} />
                    <span className={cn('min-w-0 flex-1 truncate text-sm', state === 'queued' ? 'text-tertiary' : 'text-fg-strong')}>{st.title}</span>
                    <span className="font-mono text-caption text-tertiary tnum">{st.time}</span>
                    <span className="grid w-4 place-items-center">
                      {hasWork ? <Icon name={isOpen ? 'chevronUp' : 'chevron'} size={12} className="text-tertiary" /> : null}
                    </span>
                  </button>
                  {isOpen && hasWork ? (
                    <div className="space-y-2.5 pb-4 pl-[30px] pt-1">
                      {st.work.map((w, k) => (
                        <Work key={k} item={w} />
                      ))}
                      {i === live ? <Gate task={task} /> : null}
                      {i === live ? steers.map((sr, k) => <SteerRow key={k} steer={sr} />) : null}
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ol>
          {live < 0 && steers.length > 0 ? <div className="mt-3 space-y-2">{steers.map((sr, k) => <SteerRow key={k} steer={sr} />)}</div> : null}
        </Section>

        {task.result ? (
          <Section label="Result">
            <p className="m-0 max-w-[68ch] text-md text-fg-strong">{task.result.summary}</p>
            <div className="mt-3 font-mono text-caption text-tertiary tnum">{task.result.receipt}</div>
          </Section>
        ) : null}
      </div>
    </div>
  )
}
