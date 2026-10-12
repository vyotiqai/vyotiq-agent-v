import { useState } from 'react'
import { Icon } from '@renderer/lib/icons'
import { Button, DiffStat, IconButton, StatusGlyph, cn } from '@renderer/lib/ui'
import { ROW_HOVER, SELECTED } from '@renderer/lib/utils/layout'
import type { Thread, Turn } from '../data'
import { lastTurn, liveActivity, pendingAsk, threadState, useThreads } from '../store'
import {
  Approval,
  CheckRows,
  Composer,
  ErrorBlock,
  FileRows,
  Md,
  ReviewList,
  StepList,
  composerPlaceholder,
  editsOf,
  fmtCost,
  fmtSecs,
  plainText,
  plural,
  turnCounts,
  useFollow
} from '../parts'

/*
  A — Conversation.

  The thread reads as a back-and-forth again: what you said, then what it
  said. The work that got it there folds into one line above each reply —
  open while it works, folded the moment it settles — so the answer is the
  first thing under your message, not the last thing under forty rows.
*/

export function Conversation() {
  const { selected } = useThreads()
  const [review, setReview] = useState<{ open: boolean; focus: string | null }>({ open: false, focus: null })
  const openReview = (path?: string): void => setReview({ open: true, focus: path ?? null })
  return (
    <div className="flex min-h-0 flex-1">
      <ThreadList />
      <main className="vy-panel flex min-w-0 flex-1 flex-col" aria-label="Thread">
        {selected ? <ThreadView key={selected.id} thread={selected} onReview={openReview} reviewOpen={review.open} /> : <Start />}
      </main>
      {selected && review.open ? (
        <aside className="vy-panel flex w-[440px] shrink-0 flex-col" aria-label="Review">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
            <span className="text-sm text-fg-strong">Review</span>
            <span className="flex-1" />
            <IconButton icon="close" label="Close review" size="xs" tone="muted" onClick={() => setReview({ open: false, focus: null })} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
            <ReviewList turns={selected.turns} focus={review.focus} />
          </div>
        </aside>
      ) : null}
    </div>
  )
}

/* ─── The list: recency first, what each thread is doing on its second line ── */

const DAYS: { id: Thread['day']; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'earlier', label: 'Earlier' }
]

function ThreadList() {
  const { threads, selected, select } = useThreads()
  const needs = threads.filter((t) => threadState(t) === 'needs')
  const rest = threads.filter((t) => threadState(t) !== 'needs')
  return (
    <nav className="flex w-[288px] shrink-0 flex-col bg-chrome" aria-label="Threads">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border pl-4 pr-2">
        <span className="text-sm text-fg-strong">Threads</span>
        <span className="flex-1" />
        <IconButton icon="search" label="Search threads (Ctrl K)" size="xs" tone="muted" />
        <Button size="xs" variant="secondary" icon="plus" onClick={() => select(null)}>
          New
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 scroll-thin [scrollbar-gutter:stable]">
        {needs.length ? <Section label="Needs you" rows={needs} selected={selected?.id} onSelect={select} /> : null}
        {DAYS.map((d) => {
          const rows = rest.filter((t) => t.day === d.id)
          return rows.length ? <Section key={d.id} label={d.label} rows={rows} selected={selected?.id} onSelect={select} /> : null
        })}
      </div>
    </nav>
  )
}

function Section({ label, rows, selected, onSelect }: { label: string; rows: Thread[]; selected?: string; onSelect: (id: string) => void }) {
  return (
    <section className="pt-3">
      <h2 className="px-2 pb-1 text-caption text-tertiary">{label}</h2>
      <ul>
        {rows.map((t) => (
          <li key={t.id}>
            <ThreadRow thread={t} on={t.id === selected} onSelect={() => onSelect(t.id)} />
          </li>
        ))}
      </ul>
    </section>
  )
}

export function ThreadRow({ thread, on, onSelect }: { thread: Thread; on: boolean; onSelect: () => void }) {
  const state = threadState(thread)
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={on || undefined}
      className={cn('block w-full rounded-md px-2 py-1.5 text-left focus-visible:vy-focus-ring', on ? SELECTED : ROW_HOVER)}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className={cn('min-w-0 flex-1 truncate text-sm', on || thread.unread ? 'text-fg-strong' : 'text-fg')}>{thread.title}</span>
        {state === 'running' || state === 'needs' || state === 'failed' ? <StatusGlyph state={state} size={12} label /> : null}
        <span className="w-[3ch] shrink-0 text-right font-mono tnum text-caption text-tertiary">{thread.age}</span>
      </span>
      <RowPreview thread={thread} />
    </button>
  )
}

/** The row's second line answers "what is it doing / what did it leave?". */
export function RowPreview({ thread }: { thread: Thread }) {
  const turn = lastTurn(thread)
  const state = threadState(thread)
  const line = 'mt-0.5 block truncate text-xs'
  if (state === 'running') return <span className={cn(line, 'vy-text-live')}>{liveActivity(turn)}</span>
  if (state === 'needs') {
    const ask = pendingAsk(turn)
    return (
      <span className={cn(line, 'text-secondary')}>
        Wants to run <span className="font-mono text-caption text-fg">{ask?.cmd}</span>
      </span>
    )
  }
  if (state === 'failed') return <span className={cn(line, 'text-secondary')}>{turn.error?.title ?? 'Failed'}</span>
  if (state === 'stopped') return <span className={cn(line, 'text-muted')}>Stopped</span>
  if (state === 'review') {
    const edits = editsOf(thread.turns)
    const add = edits.reduce((n, f) => n + f.add, 0)
    const del = edits.reduce((n, f) => n + f.del, 0)
    return (
      <span className={cn(line, 'flex items-center gap-1.5 text-muted')}>
        {plural(edits.length, 'file')} to review <DiffStat add={add} del={del} />
      </span>
    )
  }
  return <span className={cn(line, 'text-muted')}>{plainText(turn.answer ?? '')}</span>
}

/* ─── The thread ─────────────────────────────────────────────────────────── */

function ThreadView({ thread, onReview, reviewOpen }: { thread: Thread; onReview: (path?: string) => void; reviewOpen: boolean }) {
  const { send, stop, answer, retry } = useThreads()
  const turn = lastTurn(thread)
  const live = turn.state === 'running' || turn.state === 'needs'
  const files = new Set(thread.turns.flatMap((t) => t.files.map((f) => f.path))).size
  const scroller = useFollow(JSON.stringify(turn))
  return (
    <>
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
        <h1 className="min-w-0 truncate text-sm text-fg-strong">{thread.title}</h1>
        <span className="shrink-0 text-xs text-tertiary">
          {thread.workspace} · <span className="font-mono text-caption">{thread.branch}</span>
        </span>
        <span className="flex-1" />
        {live ? (
          <Button size="xs" variant="secondary" icon="stop" onClick={stop}>
            Stop
          </Button>
        ) : null}
        {files > 0 && !reviewOpen ? (
          <Button size="xs" variant="ghost" icon="diff" onClick={() => onReview()}>
            Review {files}
          </Button>
        ) : null}
        <IconButton icon="more" label="More" size="xs" tone="muted" />
      </header>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto scroll-thin">
        <div className="mx-auto max-w-[760px] space-y-8 px-6 pb-8 pt-6">
          {thread.turns.map((t) => (
            <TurnView key={t.id} turn={t} onAnswer={answer} onRetry={retry} onReview={onReview} />
          ))}
        </div>
      </div>
      <div className="mx-auto w-full max-w-[760px] px-6 pb-4">
        <Composer live={live} placeholder={composerPlaceholder(turn)} onSend={send} />
      </div>
    </>
  )
}

function TurnView({
  turn,
  onAnswer,
  onRetry,
  onReview
}: {
  turn: Turn
  onAnswer: (c: 'once' | 'always' | 'deny') => void
  onRetry: () => void
  onReview: (path?: string) => void
}) {
  const ask = pendingAsk(turn)
  return (
    <article className="space-y-4" data-turn={turn.state}>
      <YouSaid turn={turn} />
      <div className="space-y-4">
        <WorkFold turn={turn} />
        {ask ? <Approval w={ask} onAnswer={onAnswer} /> : null}
        {turn.error ? <ErrorBlock error={turn.error} onRetry={onRetry} /> : null}
        {turn.answer ? <Md text={turn.answer} className="th-rise" /> : null}
        {turn.state === 'done' && (turn.files.length > 0 || turn.checks.length > 0) ? <Outcome turn={turn} onReview={onReview} /> : null}
        {turn.state === 'done' || turn.state === 'failed' || turn.state === 'stopped' ? <TurnFoot turn={turn} /> : null}
      </div>
    </article>
  )
}

function YouSaid({ turn }: { turn: Turn }) {
  return (
    <div className="group flex items-start justify-end gap-2">
      <span className="mt-2 flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <span className="font-mono tnum text-caption text-tertiary">{turn.at}</span>
        <IconButton icon="edit" label="Edit and rerun" size="xs" tone="muted" />
      </span>
      <div className="max-w-[85%] rounded-xl bg-surface px-3.5 py-2.5 text-sm leading-[20px] text-fg-strong">
        {turn.mode === 'ask' ? <span className="mr-1.5 rounded-sm bg-bg px-1 py-px text-caption text-muted">Ask</span> : null}
        {turn.ask}
      </div>
    </div>
  )
}

/**
 * The work, as one line. Open while it runs (the live step shows its
 * commands and edits); folded once it settles, saying how long and what.
 */
function WorkFold({ turn }: { turn: Turn }) {
  const live = turn.state === 'running' || turn.state === 'needs'
  const settledOpen = turn.state === 'failed'
  const [open, setOpen] = useState(live || settledOpen)
  const [was, setWas] = useState(live)
  if (live !== was) {
    setWas(live)
    setOpen(live || settledOpen)
  }
  const plan = turn.steps.filter((s) => s.state !== 'queued' || live)
  const at = turn.steps.findIndex((s) => s.state === 'running' || s.state === 'needs')
  const counts = turnCounts(turn)
  return (
    <div data-work-fold={open ? 'open' : 'closed'}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={cn('-mx-2 flex h-7 w-[calc(100%+16px)] min-w-0 items-center gap-2 rounded-md px-2 text-left text-xs focus-visible:vy-focus-ring', ROW_HOVER)}
      >
        <Icon name="chevronRight" size={11} className={cn('shrink-0 text-tertiary transition-transform', open ? 'rotate-90' : '')} />
        {turn.state === 'running' ? (
          <span className="vy-text-live shrink-0">Working</span>
        ) : turn.state === 'needs' ? (
          <span className="shrink-0 text-accent">Waiting for you</span>
        ) : (
          <span className="shrink-0 text-secondary">{turn.state === 'failed' ? 'Failed after' : turn.state === 'stopped' ? 'Stopped after' : 'Worked for'} {fmtSecs(turn.secs)}</span>
        )}
        {live && at >= 0 ? (
          <span className="min-w-0 truncate text-tertiary">
            · step {at + 1} of {turn.steps.length} · {turn.steps[at].title}
          </span>
        ) : counts ? (
          <span className="min-w-0 truncate text-tertiary">· {counts}</span>
        ) : null}
      </button>
      {open ? (
        <div className="mt-1 border-l border-border/60 pl-4 ml-[3px]">
          <StepList steps={plan} hideNeeds />
        </div>
      ) : null}
    </div>
  )
}

/** What it left: the files (into Review) and the done-when checks, as rows. */
function Outcome({ turn, onReview }: { turn: Turn; onReview: (path?: string) => void }) {
  const add = turn.files.reduce((n, f) => n + f.add, 0)
  const del = turn.files.reduce((n, f) => n + f.del, 0)
  return (
    <div className="space-y-3 border-t border-border/60 pt-3">
      {turn.files.length ? (
        <div>
          <div className="flex h-6 items-center gap-2 text-xs">
            <span className="text-secondary">{plural(turn.files.length, 'file')} changed</span>
            <DiffStat add={add} del={del} />
            <span className="flex-1" />
            <Button size="xs" variant="ghost" trailingIcon="chevronRight" onClick={() => onReview()}>
              Review
            </Button>
          </div>
          <FileRows files={turn.files} max={4} onOpen={onReview} />
        </div>
      ) : null}
      {turn.checks.length ? <CheckRows checks={turn.checks} /> : null}
    </div>
  )
}

function TurnFoot({ turn }: { turn: Turn }) {
  return (
    <div className="flex items-center gap-1 text-caption text-tertiary">
      <span className="font-mono tnum">
        {fmtSecs(turn.secs)} · {fmtCost(turn.cost)}
      </span>
      <span className="flex-1" />
      <IconButton icon="copy" label="Copy reply" size="xs" tone="muted" />
      <IconButton icon="thumbsUp" label="Good result" size="xs" tone="muted" />
      <IconButton icon="thumbsDown" label="Bad result" size="xs" tone="muted" />
    </div>
  )
}

/* ─── A new thread ───────────────────────────────────────────────────────── */

function Start() {
  const { send } = useThreads()
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center border-b border-border pl-4 pr-2">
        <span className="text-sm text-fg-strong">New thread</span>
        <span className="ml-2 text-xs text-tertiary">storefront · <span className="font-mono text-caption">main</span></span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col justify-center px-6">
        <div className="mx-auto w-full max-w-[680px]">
          <h1 className="pb-4 text-title font-semibold tracking-[var(--vy-tracking-tight)] text-fg-strong">What should it work on?</h1>
          <Composer live={false} placeholder={composerPlaceholder(null)} onSend={send} focusOnMount rows={3} />
          <div className="flex flex-wrap gap-1.5 pt-3">
            {['Explain how auth works', 'Find why the build got slower', 'Add a test for rateLimit'].map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => send(s, s.startsWith('Explain') || s.startsWith('Find') ? 'ask' : 'agent')}
                className="h-7 rounded-md border border-border px-2.5 text-xs text-secondary hover:border-border-strong hover:bg-surface hover:text-fg-strong focus-visible:vy-focus-ring"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export { Start as StartThread }
