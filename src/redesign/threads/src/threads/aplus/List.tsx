import { flushSync } from 'react-dom'
import { forwardRef, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@renderer/lib/icons'
import { Button, DiffStat, IconButton, StatusGlyph, cn } from '@renderer/lib/ui'
import { ROW_HOVER, SELECTED } from '@renderer/lib/utils/layout'
import type { Thread } from '../data'
import { plainMarkdown } from '../markdown'
import { editsOf, plural } from '../parts'
import { lastTurn, listOrder, liveActivity, pendingAsk, threadState, useThreads } from '../store'

/*
  The threads, newest first, with anything waiting on you pinned above.
  Each row answers two questions: which thread (the title) and where it
  stands (the second line — what it is doing, what it wants, or what it
  left). A glyph appears only where the state needs one.
*/

export type ListHandle = { search: () => void }

const DAYS: { id: Thread['day']; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'earlier', label: 'Earlier' }
]

export const ThreadList = forwardRef<ListHandle, object>(function ThreadList(_props, ref) {
  const { threads, selected, select } = useThreads()
  const [query, setQuery] = useState<string | null>(null)
  const field = useRef<HTMLInputElement>(null)
  const open = query != null
  // The shortcut fires outside React's own events, where an update would wait
  // for a later task; render the field now so the very next key lands in it.
  useImperativeHandle(ref, () => ({ search: () => (open ? field.current?.select() : flushSync(() => setQuery(''))) }), [open])
  useLayoutEffect(() => {
    if (open) field.current?.focus()
  }, [open])

  const shown = useMemo(() => {
    const q = query?.trim().toLowerCase()
    if (!q) return threads
    return threads.filter((t) => t.title.toLowerCase().includes(q) || t.turns.some((u) => u.ask.toLowerCase().includes(q)))
  }, [threads, query])
  const ordered = listOrder(shown)
  const needs = ordered.filter((t) => threadState(t) === 'needs')
  const rest = ordered.filter((t) => threadState(t) !== 'needs')

  return (
    <nav className="flex w-[296px] shrink-0 flex-col bg-chrome" aria-label="Threads">
      {query == null ? (
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border pl-4 pr-2">
          <span className="text-sm text-fg-strong">Threads</span>
          <span className="flex-1" />
          <IconButton icon="search" label="Search threads (Ctrl K)" size="xs" tone="muted" onClick={() => setQuery('')} />
          <Button size="xs" variant="secondary" icon="plus" onClick={() => select(null)} title="New thread (Ctrl N)">
            New
          </Button>
        </div>
      ) : (
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
          <Icon name="search" size={14} className="shrink-0 text-tertiary" />
          <input
            ref={field}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery(null)
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && ordered[0]) select(ordered[0].id)
            }}
            placeholder="Search threads"
            aria-label="Search threads"
            className="min-w-0 flex-1 bg-transparent text-sm text-fg-strong outline-none placeholder:text-tertiary"
          />
          <IconButton icon="close" label="Close search (Esc)" size="xs" tone="muted" onClick={() => setQuery(null)} />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 scroll-thin [scrollbar-gutter:stable]">
        {needs.length ? <Section label="Needs you" rows={needs} selected={selected?.id} onSelect={select} /> : null}
        {DAYS.map((d) => {
          const rows = rest.filter((t) => t.day === d.id)
          return rows.length ? <Section key={d.id} label={d.label} rows={rows} selected={selected?.id} onSelect={select} /> : null
        })}
        {shown.length === 0 ? <p className="px-2 pt-6 text-center text-xs text-muted">No threads match “{query}”.</p> : null}
      </div>
    </nav>
  )
})

function Section({ label, rows, selected, onSelect }: { label: string; rows: Thread[]; selected?: string; onSelect: (id: string) => void }) {
  return (
    <section className="pt-3" aria-label={label}>
      <h2 className="flex h-6 items-center px-2 text-caption text-tertiary">{label}</h2>
      <ul className="space-y-px">
        {rows.map((t) => (
          <li key={t.id}>
            <Row thread={t} on={t.id === selected} onSelect={() => onSelect(t.id)} />
          </li>
        ))}
      </ul>
    </section>
  )
}

function Row({ thread, on, onSelect }: { thread: Thread; on: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={on || undefined}
      data-thread={thread.id}
      className={cn('block w-full rounded-md px-2 py-[7px] text-left focus-visible:vy-focus-ring', on ? SELECTED : ROW_HOVER)}
    >
      <span className="flex min-w-0 items-baseline gap-2">
        <span className={cn('min-w-0 flex-1 truncate text-sm', on || thread.unread ? 'text-fg-strong' : 'text-fg')}>{thread.title}</span>
        {thread.unread && !on ? <span className="sr-only">Unread</span> : null}
        <span className="shrink-0 font-mono tnum text-caption text-tertiary">{thread.age}</span>
      </span>
      <StatusLine thread={thread} />
    </button>
  )
}

/** The second line: what it is doing, what it wants, or what it left. */
function StatusLine({ thread }: { thread: Thread }) {
  const turn = lastTurn(thread)
  const state = threadState(thread)
  const line = 'mt-0.5 flex min-w-0 items-center gap-1.5 text-xs'
  if (state === 'running')
    return (
      <span className={line}>
        <StatusGlyph state="running" size={11} />
        <span className="vy-text-live truncate">{liveActivity(turn)}</span>
      </span>
    )
  if (state === 'needs')
    return (
      <span className={line}>
        <StatusGlyph state="needs" size={11} />
        <span className="truncate text-secondary">
          Wants to run <span className="font-mono text-caption text-fg">{pendingAsk(turn)?.cmd}</span>
        </span>
      </span>
    )
  if (state === 'failed')
    return (
      <span className={line}>
        <StatusGlyph state="failed" size={11} />
        <span className="truncate text-secondary">{turn.error?.title ?? 'Failed'}</span>
      </span>
    )
  if (state === 'stopped')
    return (
      <span className={line}>
        <StatusGlyph state="stopped" size={11} />
        <span className="truncate text-muted">Stopped</span>
      </span>
    )
  if (state === 'review') {
    const edits = editsOf(thread.turns)
    return (
      <span className={cn(line, 'text-muted')}>
        <span className="shrink-0">{plural(edits.length, 'file')} to review</span>
        <DiffStat add={edits.reduce((n, e) => n + e.add, 0)} del={edits.reduce((n, e) => n + e.del, 0)} />
      </span>
    )
  }
  return (
    <span className={cn(line, 'text-muted')}>
      <span className="truncate">{plainMarkdown(turn.answer ?? '') || (turn.state === 'done' ? 'Done' : '')}</span>
    </span>
  )
}
