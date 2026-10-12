import { useState, type ReactNode } from 'react'
import { Icon } from '@renderer/lib/icons'
import { Button, DiffStat, IconButton, STATE_LABEL, StatusGlyph, cn, type TaskState } from '@renderer/lib/ui'
import { ROW_HOVER, SELECTED } from '@renderer/lib/utils/layout'
import type { Thread, Turn } from '../data'
import { lastTurn, liveActivity, pendingAsk, threadState, useThreads, type ThreadState } from '../store'
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
  fmtCost,
  fmtSecs,
  plural,
  turnCounts,
  useFollow
} from '../parts'
import { StartThread } from '../a/Conversation'

/*
  B — Outcome first.

  Each turn answers "so what happened?" before "how". Your ask is the
  heading; under it one status line, then the answer, then what changed and
  whether the done-when checks held, side by side. How it got there is one
  fold at the bottom. Earlier turns shrink to a line each, so the latest
  outcome is always on screen without scrolling.
*/

export function Outcome() {
  const { selected } = useThreads()
  const [review, setReview] = useState<{ open: boolean; focus: string | null }>({ open: false, focus: null })
  return (
    <div className="flex min-h-0 flex-1">
      <StatusList />
      <main className="vy-panel flex min-w-0 flex-1 flex-col" aria-label="Thread">
        {selected ? <ThreadView key={selected.id} thread={selected} onReview={(p) => setReview({ open: true, focus: p ?? null })} /> : <StartThread />}
      </main>
      {selected && review.open ? (
        <aside className="vy-panel flex w-[440px] shrink-0 flex-col" aria-label="Review">
          <div className="flex h-10 shrink-0 items-center border-b border-border pl-4 pr-2">
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

/* ─── The list, by what each thread needs from you ──────────────────────── */

const GROUPS: { id: ThreadState[]; label: string; glyph?: TaskState }[] = [
  { id: ['needs'], label: 'Needs you', glyph: 'needs' },
  { id: ['running'], label: 'Working', glyph: 'running' },
  { id: ['review'], label: 'Ready for review', glyph: 'review' },
  { id: ['failed', 'stopped'], label: 'Didn’t finish', glyph: 'failed' },
  { id: ['done'], label: 'Done' }
]

function StatusList() {
  const { threads, selected, select } = useThreads()
  return (
    <nav className="flex w-[272px] shrink-0 flex-col bg-chrome" aria-label="Threads">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border pl-4 pr-2">
        <span className="text-sm text-fg-strong">All workspaces</span>
        <Icon name="chevron" size={11} className="text-tertiary" />
        <span className="flex-1" />
        <Button size="xs" variant="secondary" onClick={() => select(null)}>
          New thread
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3 scroll-thin [scrollbar-gutter:stable]">
        {GROUPS.map((g) => {
          const rows = threads.filter((t) => g.id.includes(threadState(t)))
          if (!rows.length) return null
          return (
            <section key={g.label} className="pt-3">
              <h2 className="flex h-6 items-center gap-2 pl-4 pr-3 text-caption text-tertiary">
                <span className="flex-1">{g.label}</span>
                {g.glyph ? <StatusGlyph state={g.glyph} size={12} /> : null}
                <span className="font-mono tnum">{rows.length}</span>
              </h2>
              <ul className="px-2">
                {rows.map((t) => (
                  <li key={t.id}>
                    <Row thread={t} on={t.id === selected?.id} onSelect={() => select(t.id)} />
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
      </div>
    </nav>
  )
}

function Row({ thread, on, onSelect }: { thread: Thread; on: boolean; onSelect: () => void }) {
  const state = threadState(thread)
  const turn = lastTurn(thread)
  const at = turn.steps.findIndex((s) => s.state === 'running' || s.state === 'needs')
  let meta: ReactNode = <span className="font-mono tnum text-caption text-tertiary">{thread.age}</span>
  if (state === 'running' || state === 'needs') meta = <span className="font-mono tnum text-caption text-tertiary">{at + 1}/{turn.steps.length}</span>
  if (state === 'review') meta = <DiffStat add={turn.files.reduce((n, f) => n + f.add, 0)} del={turn.files.reduce((n, f) => n + f.del, 0)} />
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={on || undefined}
      className={cn('flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left focus-visible:vy-focus-ring', on ? SELECTED : ROW_HOVER)}
    >
      <span className={cn('min-w-0 flex-1 truncate text-sm', on || thread.unread ? 'text-fg-strong' : 'text-fg')}>{thread.title}</span>
      {state === 'stopped' ? <StatusGlyph state="stopped" size={12} label /> : null}
      <span className="shrink-0">{meta}</span>
    </button>
  )
}

/* ─── The thread ─────────────────────────────────────────────────────────── */

function ThreadView({ thread, onReview }: { thread: Thread; onReview: (path?: string) => void }) {
  const { send, stop } = useThreads()
  const turn = lastTurn(thread)
  const live = turn.state === 'running' || turn.state === 'needs'
  const earlier = thread.turns.slice(0, -1)
  const scroller = useFollow(JSON.stringify(turn))
  return (
    <>
      <header className="relative flex h-10 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
        <h1 className="min-w-0 truncate text-sm text-fg-strong">{thread.title}</h1>
        <span className="shrink-0 font-mono text-caption text-tertiary">{thread.branch}</span>
        <span className="flex-1" />
        {live ? (
          <Button size="xs" variant="secondary" icon="stop" onClick={stop}>
            Stop
          </Button>
        ) : null}
        <IconButton icon="more" label="More" size="xs" tone="muted" />
        {live ? <Progress turn={turn} /> : null}
      </header>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto scroll-thin">
        <div className="mx-auto max-w-[800px] px-8 pb-8 pt-6">
          {earlier.length ? (
            <section aria-label="Earlier in this thread" className="mb-6 border-b border-border/60 pb-3">
              {earlier.map((t) => (
                <EarlierTurn key={t.id} turn={t} onReview={onReview} />
              ))}
            </section>
          ) : null}
          <TurnView turn={turn} onReview={onReview} />
        </div>
      </div>
      <div className="mx-auto w-full max-w-[800px] px-8 pb-4">
        <Composer live={live} placeholder={composerPlaceholder(turn)} onSend={send} />
      </div>
    </>
  )
}

/** The plan as the header's bottom hairline: one segment per step. */
function Progress({ turn }: { turn: Turn }) {
  return (
    <div className="absolute inset-x-0 -bottom-px flex h-[2px] gap-[2px]" role="img" aria-label={`Step ${turn.steps.findIndex((s) => s.state === 'running' || s.state === 'needs') + 1} of ${turn.steps.length}`}>
      {turn.steps.map((s, i) => (
        <span key={i} className={cn('h-full flex-1', s.state === 'done' ? 'bg-muted' : s.state === 'running' ? 'bg-accent animate-pulse' : s.state === 'needs' ? 'bg-accent' : 'bg-border')} />
      ))}
    </div>
  )
}

function EarlierTurn({ turn, onReview }: { turn: Turn; onReview: (path?: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={cn('-mx-2 flex h-8 w-[calc(100%+16px)] min-w-0 items-center gap-2 rounded-md px-2 text-left text-xs focus-visible:vy-focus-ring', ROW_HOVER)}
      >
        <Icon name="chevronRight" size={11} className={cn('shrink-0 text-tertiary transition-transform', open ? 'rotate-90' : '')} />
        <span className="min-w-0 flex-1 truncate text-secondary">{turn.ask}</span>
        <span className="shrink-0 text-tertiary">{turn.files.length ? plural(turn.files.length, 'file') : 'Answered'}</span>
        <span className="w-12 shrink-0 text-right font-mono tnum text-caption text-tertiary">{turn.at}</span>
      </button>
      {open ? (
        <div className="pb-4 pl-5 pt-2">
          <TurnView turn={turn} onReview={onReview} compact />
        </div>
      ) : null}
    </div>
  )
}

function TurnView({ turn, onReview, compact = false }: { turn: Turn; onReview: (path?: string) => void; compact?: boolean }) {
  const { answer, retry } = useThreads()
  const ask = pendingAsk(turn)
  const live = turn.state === 'running' || turn.state === 'needs'
  return (
    <article data-turn={turn.state}>
      {compact ? null : (
        <>
          <div className="group flex items-center gap-2 pb-1 text-caption text-tertiary">
            <span>You asked{turn.mode === 'ask' ? ' (Ask mode)' : ''} · {turn.at}</span>
            <IconButton icon="edit" label="Edit and rerun" size="xs" tone="muted" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" />
          </div>
          <p className="max-w-[72ch] text-md text-fg-strong">{turn.ask}</p>
        </>
      )}

      <StatusLine turn={turn} />

      <div className="space-y-5">
        {ask ? <Approval w={ask} onAnswer={answer} /> : null}
        {turn.error ? <ErrorBlock error={turn.error} onRetry={retry} /> : null}

        {live ? (
          <Block label="Progress">
            <StepList steps={turn.steps} numbered hideNeeds />
          </Block>
        ) : null}

        {turn.answer ? <Md text={turn.answer} className="th-rise" /> : null}

        {!live && (turn.files.length || turn.checks.length) ? (
          <div className={cn('grid gap-x-8 gap-y-5', turn.files.length && turn.checks.length ? 'grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]' : 'grid-cols-1')}>
            {turn.files.length ? (
              <Block
                label="What changed"
                aside={
                  <Button size="xs" variant="ghost" trailingIcon="chevronRight" onClick={() => onReview()}>
                    Review
                  </Button>
                }
              >
                <FileRows files={turn.files} max={5} onOpen={onReview} />
              </Block>
            ) : null}
            {turn.checks.length ? (
              <Block label="Done when">
                <CheckRows checks={turn.checks} />
              </Block>
            ) : null}
          </div>
        ) : live && turn.checks.length ? (
          <Block label="Done when">
            <CheckRows checks={turn.checks} />
          </Block>
        ) : null}

        {!live ? <HowItGotThere turn={turn} /> : null}
      </div>
    </article>
  )
}

/** One line that says where the turn stands — the thing you came to check. */
function StatusLine({ turn }: { turn: Turn }) {
  const state: TaskState = turn.state === 'done' ? (turn.files.length ? 'review' : 'done') : turn.state
  const met = turn.checks.filter((c) => c.state === 'met').length
  const facts =
    turn.state === 'running'
      ? [liveActivity(turn)]
      : turn.state === 'needs'
        ? ['It needs your answer to carry on']
        : [
            fmtSecs(turn.secs),
            turn.files.length ? plural(turn.files.length, 'file') + ' changed' : turn.mode === 'ask' ? 'nothing changed' : null,
            turn.checks.length ? `${met}/${turn.checks.length} checks met` : null
          ]
  return (
    <div className="my-4 flex min-w-0 items-center gap-2 text-xs" data-status={state}>
      <StatusGlyph state={state} size={14} />
      <span className="shrink-0 font-medium text-fg-strong">{state === 'running' ? 'Working' : state === 'done' && turn.mode === 'ask' ? 'Answered' : STATE_LABEL[state]}</span>
      <span className={cn('min-w-0 truncate', turn.state === 'running' ? 'vy-text-live' : 'text-tertiary')}>
        {facts.filter(Boolean).join(' · ')}
      </span>
    </div>
  )
}

function Block({ label, aside, children }: { label: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={label}>
      <div className="flex h-6 items-center gap-2">
        <h3 className="text-caption text-tertiary">{label}</h3>
        <span className="flex-1" />
        {aside}
      </div>
      <div className="pt-1">{children}</div>
    </section>
  )
}

function HowItGotThere({ turn }: { turn: Turn }) {
  const [open, setOpen] = useState(turn.state === 'failed')
  return (
    <section className="border-t border-border/60 pt-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={cn('-mx-2 flex h-7 w-[calc(100%+16px)] min-w-0 items-center gap-2 rounded-md px-2 text-left text-xs focus-visible:vy-focus-ring', ROW_HOVER)}
      >
        <Icon name="chevronRight" size={11} className={cn('shrink-0 text-tertiary transition-transform', open ? 'rotate-90' : '')} />
        <span className="shrink-0 text-secondary">How it got there</span>
        <span className="min-w-0 truncate text-tertiary">
          · {plural(turn.steps.filter((s) => s.state !== 'queued').length, 'step')} · {turnCounts(turn)}
        </span>
        <span className="flex-1" />
        <span className="shrink-0 font-mono tnum text-caption text-tertiary">{fmtCost(turn.cost)}</span>
      </button>
      {open ? (
        <div className="pt-1">
          <StepList steps={turn.steps} numbered />
        </div>
      ) : null}
    </section>
  )
}
