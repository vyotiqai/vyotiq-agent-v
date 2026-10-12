import { useState } from 'react'
import { Icon } from '@renderer/lib/icons'
import { Button, DiffStat, IconButton, StatusGlyph, Tabs, cn } from '@renderer/lib/ui'
import { ROW_HOVER, SELECTED } from '@renderer/lib/utils/layout'
import type { Thread, Turn, Work } from '../data'
import { lastTurn, liveActivity, pendingAsk, threadState, useThreads } from '../store'
import {
  Approval,
  CheckRows,
  CommandCard,
  Composer,
  ErrorBlock,
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
  C — Conversation beside the work.

  The middle column is only the conversation: your messages and its replies.
  Every reply carries one chip — live, or "4 steps · 3m 22s" — that points
  the right pane at that turn's work: its steps, its diffs, its commands.
  Reading and auditing become two places, so neither crowds the other.
*/

type Pane = 'work' | 'changes' | 'terminal'

export function Split() {
  const { selected } = useThreads()
  return (
    <div className="flex min-h-0 flex-1">
      <CompactList />
      {selected ? <ThreadView key={selected.id} thread={selected} /> : <main className="vy-panel flex min-w-0 flex-1 flex-col"><StartThread /></main>}
    </div>
  )
}

/* ─── The list: one line per thread, the glyph column says its state ────── */

function CompactList() {
  const { threads, selected, select } = useThreads()
  const spaces = [...new Set(threads.map((t) => t.workspace))]
  return (
    <nav className="flex w-[248px] shrink-0 flex-col bg-chrome" aria-label="Threads">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border pl-4 pr-2">
        <span className="text-sm text-fg-strong">Threads</span>
        <span className="flex-1" />
        <IconButton icon="plus" label="New thread (Ctrl N)" size="xs" onClick={() => select(null)} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 scroll-thin [scrollbar-gutter:stable]">
        {spaces.map((ws) => (
          <section key={ws} className="pt-3">
            <h2 className="px-2 pb-1 text-caption text-tertiary">{ws}</h2>
            <ul>
              {threads
                .filter((t) => t.workspace === ws)
                .map((t) => {
                  const state = threadState(t)
                  const on = t.id === selected?.id
                  return (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => select(t.id)}
                        aria-current={on || undefined}
                        className={cn('flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left focus-visible:vy-focus-ring', on ? SELECTED : ROW_HOVER)}
                      >
                        <span className="grid w-3.5 shrink-0 place-items-center">
                          {state === 'done' ? <span className="size-1 rounded-full bg-border-strong" /> : <StatusGlyph state={state} size={12} label />}
                        </span>
                        <span className={cn('min-w-0 flex-1 truncate text-xs', on || t.unread ? 'text-fg-strong' : 'text-fg')}>{t.title}</span>
                        <span className="shrink-0 font-mono tnum text-caption text-tertiary">{t.age}</span>
                      </button>
                    </li>
                  )
                })}
            </ul>
          </section>
        ))}
      </div>
    </nav>
  )
}

/* ─── Conversation + work ───────────────────────────────────────────────── */

function ThreadView({ thread }: { thread: Thread }) {
  const { send, stop, answer, retry } = useThreads()
  const turn = lastTurn(thread)
  const live = turn.state === 'running' || turn.state === 'needs'
  const [focus, setFocus] = useState<string>(turn.id)
  const [pane, setPane] = useState<Pane>('work')
  const [paneOpen, setPaneOpen] = useState(true)
  // A new turn takes the pane with it.
  const [lastId, setLastId] = useState(turn.id)
  if (lastId !== turn.id) {
    setLastId(turn.id)
    setFocus(turn.id)
  }
  const focused = thread.turns.find((t) => t.id === focus) ?? turn
  const scroller = useFollow(JSON.stringify(turn))
  const show = (id: string, p: Pane): void => {
    setFocus(id)
    setPane(p)
    setPaneOpen(true)
  }
  return (
    <>
      <main className="vy-panel flex min-w-0 flex-1 flex-col" aria-label="Conversation">
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
          <h1 className="min-w-0 truncate text-sm text-fg-strong">{thread.title}</h1>
          <span className="shrink-0 font-mono text-caption text-tertiary">{thread.branch}</span>
          <span className="flex-1" />
          {live ? (
            <Button size="xs" variant="secondary" icon="stop" onClick={stop}>
              Stop
            </Button>
          ) : null}
          <IconButton icon="inspector" label={paneOpen ? 'Hide work' : 'Show work'} size="xs" active={paneOpen} onClick={() => setPaneOpen(!paneOpen)} />
        </header>
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto scroll-thin">
          <div className="mx-auto max-w-[720px] space-y-7 px-6 pb-8 pt-6">
            {thread.turns.map((t) => (
              <article key={t.id} className="space-y-3" data-turn={t.state}>
                <div className="flex justify-end">
                  <div className="max-w-[85%] rounded-xl bg-surface px-3.5 py-2.5 text-sm leading-[20px] text-fg-strong">{t.ask}</div>
                </div>
                <WorkChip turn={t} on={paneOpen && focused.id === t.id} onClick={() => show(t.id, 'work')} />
                {pendingAsk(t) ? <Approval w={pendingAsk(t)!} onAnswer={answer} /> : null}
                {t.error ? <ErrorBlock error={t.error} onRetry={retry} /> : null}
                {t.answer ? <Md text={t.answer} className="th-rise" /> : null}
                {t.state === 'done' && t.files.length ? <FileChips turn={t} onOpen={() => show(t.id, 'changes')} /> : null}
                {t.state === 'done' && t.checks.length ? <CheckRows checks={t.checks} evidence={false} /> : null}
              </article>
            ))}
          </div>
        </div>
        <div className="mx-auto w-full max-w-[720px] px-6 pb-4">
          <Composer live={live} placeholder={composerPlaceholder(turn)} onSend={send} />
        </div>
      </main>
      {paneOpen ? <WorkPane thread={thread} turn={focused} pane={pane} onPane={setPane} onClose={() => setPaneOpen(false)} /> : null}
    </>
  )
}

/** The reply's handle on its work: live while it runs, a summary once settled. */
function WorkChip({ turn, on, onClick }: { turn: Turn; on: boolean; onClick: () => void }) {
  const live = turn.state === 'running'
  const at = turn.steps.findIndex((s) => s.state === 'running' || s.state === 'needs')
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        'inline-flex h-7 max-w-full min-w-0 items-center gap-2 rounded-md border px-2.5 text-xs focus-visible:vy-focus-ring',
        on ? 'border-border-strong bg-surface text-fg-strong' : 'border-border text-secondary hover:border-border-strong hover:bg-surface'
      )}
    >
      {live ? (
        <StatusGlyph state="running" size={12} />
      ) : turn.state === 'needs' ? (
        <StatusGlyph state="needs" size={12} />
      ) : turn.state === 'failed' ? (
        <StatusGlyph state="failed" size={12} />
      ) : (
        <Icon name="listTodo" size={13} className="shrink-0 text-tertiary" />
      )}
      {live ? (
        <span className="vy-text-live min-w-0 truncate">{liveActivity(turn)}</span>
      ) : turn.state === 'needs' ? (
        <span className="min-w-0 truncate text-accent">Waiting for you</span>
      ) : (
        <span className="min-w-0 truncate">
          {plural(turn.steps.filter((s) => s.state !== 'queued').length, 'step')} · {fmtSecs(turn.secs)}
        </span>
      )}
      {at >= 0 ? <span className="shrink-0 font-mono tnum text-caption text-tertiary">{at + 1}/{turn.steps.length}</span> : null}
      <Icon name="chevronRight" size={11} className="shrink-0 text-tertiary" />
    </button>
  )
}

function FileChips({ turn, onOpen }: { turn: Turn; onOpen: () => void }) {
  const add = turn.files.reduce((n, f) => n + f.add, 0)
  const del = turn.files.reduce((n, f) => n + f.del, 0)
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {turn.files.slice(0, 4).map((f) => (
        <button
          key={f.path}
          type="button"
          onClick={onOpen}
          title={f.path}
          className="inline-flex h-6 min-w-0 max-w-[240px] items-center gap-1.5 rounded-md bg-surface px-2 text-caption hover:bg-surface-2 focus-visible:vy-focus-ring"
        >
          <span className="min-w-0 truncate font-mono text-fg">{f.path.split('/').pop()}</span>
          <DiffStat add={f.add} del={f.del} />
        </button>
      ))}
      {turn.files.length > 4 ? (
        <button type="button" onClick={onOpen} className="inline-flex h-6 items-center gap-1.5 rounded-md px-1.5 text-caption text-muted hover:bg-surface hover:text-fg focus-visible:vy-focus-ring">
          {turn.files.length - 4} more <DiffStat add={add} del={del} />
        </button>
      ) : null}
    </div>
  )
}

/* ─── The right pane: one turn's work, changes and commands ─────────────── */

function WorkPane({ thread, turn, pane, onPane, onClose }: { thread: Thread; turn: Turn; pane: Pane; onPane: (p: Pane) => void; onClose: () => void }) {
  const commands = turn.steps.flatMap((s) => s.work.filter((w): w is Extract<Work, { kind: 'command' }> => w.kind === 'command'))
  const n = thread.turns.indexOf(turn) + 1
  return (
    <aside className="vy-panel flex w-[min(460px,40%)] shrink-0 flex-col" aria-label="Work">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2">
        <Tabs
          size="row"
          label="Work for this reply"
          value={pane}
          onChange={onPane}
          items={[
            { id: 'work', label: 'Work', live: turn.state === 'running' },
            { id: 'changes', label: 'Changes', count: turn.files.length || undefined },
            { id: 'terminal', label: 'Terminal', count: commands.length || undefined }
          ]}
        />
        <span className="flex-1" />
        {thread.turns.length > 1 ? <span className="shrink-0 text-caption text-tertiary">Reply {n} of {thread.turns.length}</span> : null}
        <IconButton icon="close" label="Hide work" size="xs" tone="muted" onClick={onClose} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
        {pane === 'work' ? (
          <div className="p-4">
            <div className="flex items-center gap-2 pb-2 text-xs">
              <span className="text-secondary">{turn.state === 'running' ? 'Working' : turn.state === 'needs' ? 'Waiting for you' : `${turn.state === 'failed' ? 'Failed after' : turn.state === 'stopped' ? 'Stopped after' : 'Worked for'} ${fmtSecs(turn.secs)}`}</span>
              <span className="min-w-0 truncate text-tertiary">· {turnCounts(turn) || 'starting'}</span>
              <span className="flex-1" />
              <span className="font-mono tnum text-caption text-tertiary">{fmtCost(turn.cost)}</span>
            </div>
            <StepList steps={turn.steps} numbered hideNeeds />
            {turn.checks.length ? (
              <div className="mt-4 border-t border-border/60 pt-3">
                <h3 className="pb-1.5 text-caption text-tertiary">Done when</h3>
                <CheckRows checks={turn.checks} />
              </div>
            ) : null}
          </div>
        ) : pane === 'changes' ? (
          <ReviewList turns={[turn]} />
        ) : commands.length ? (
          <div className="space-y-2 p-4">
            {commands.map((c, i) => (
              <CommandCard key={i} w={c} defaultOpen />
            ))}
          </div>
        ) : (
          <div className="grid h-full place-items-center text-xs text-muted">No commands in this reply.</div>
        )}
      </div>
    </aside>
  )
}
