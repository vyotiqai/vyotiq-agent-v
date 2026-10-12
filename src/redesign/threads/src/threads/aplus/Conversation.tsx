import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLiveAnnouncer } from '@renderer/lib/a11y/useLiveAnnouncer'
import { Icon } from '@renderer/lib/icons'
import { ActionMenu, Button, IconButton, ToastHost, cn, pushToast } from '@renderer/lib/ui'
import { HOVER_ON_SURFACE } from '@renderer/lib/utils/layout'
import type { Thread, Turn } from '../data'
import { ReviewList, composerPlaceholder, editsOf, plural } from '../parts'
import { isLive, lastTurn, listOrder, useThreads } from '../store'
import { Composer } from './Composer'
import { ThreadList, type ListHandle } from './List'
import { TurnView } from './Turn'

/*
  A+ — Conversation, refined.

  The thread reads as a conversation: what you said on the right, what it
  said on the left, one turn under the next. Everything about *how* folds
  into one line per reply, so the eye goes from your words to its answer.
  The answer streams in word by word; what it changed and whether the checks
  held arrive after it, in that order, with a footer last.

  Keys: Ctrl N new thread · Ctrl K search · Alt ↑/↓ previous/next thread ·
  Esc closes Review.
*/

export function ConversationPlus() {
  const { threads, selected, select, settleEdits } = useThreads()
  const [review, setReview] = useState<{ open: boolean; focus: string | null }>({ open: false, focus: null })
  const list = useRef<ListHandle>(null)
  // One live region, as the app mounts at its root: copy and other quiet outcomes are spoken there.
  const { LiveRegion } = useLiveAnnouncer()

  const openReview = useCallback((path?: string) => setReview({ open: true, focus: path ?? null }), [])
  const sheet = useRef<HTMLElement>(null)
  // Review takes focus when it opens and hands it back to its toggle when it closes.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (review.open === wasOpen.current) return
    wasOpen.current = review.open
    if (review.open) sheet.current?.focus({ preventScroll: true })
    else if (document.activeElement === document.body) document.querySelector<HTMLElement>('[data-review-toggle]')?.focus()
  }, [review.open])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        select(null)
      } else if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        list.current?.search()
      } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault()
        const order = listOrder(threads)
        const i = order.findIndex((t) => t.id === selected?.id)
        const next = i < 0 ? order[0] : order[Math.max(0, Math.min(order.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
        if (next) {
          select(next.id)
          document.querySelector(`[data-thread="${next.id}"]`)?.scrollIntoView({ block: 'nearest' })
        }
      } else if (e.key === 'Escape' && review.open && !(e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement)) {
        setReview({ open: false, focus: null })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [threads, selected, select, review.open])

  // A different thread starts with Review closed. Coming from New thread, the
  // cursor stays in the box, so a follow-up is one keystroke away.
  const [shownId, setShownId] = useState(selected?.id)
  const [fromStart, setFromStart] = useState(false)
  if (shownId !== selected?.id) {
    setFromStart(shownId === undefined && selected != null && selected.id.startsWith('new-'))
    setShownId(selected?.id)
    setReview({ open: false, focus: null })
  }

  return (
    <div className="flex min-h-0 flex-1">
      <ToastHost />
      <LiveRegion />
      <ThreadList ref={list} />
      <main className="vy-panel flex min-w-0 flex-1 flex-col" aria-label={selected ? selected.title : 'New thread'}>
        {selected ? (
          <ThreadView
            key={selected.id}
            thread={selected}
            focusBox={fromStart}
            onReview={openReview}
            reviewOpen={review.open}
            onToggleReview={() => setReview((r) => ({ open: !r.open, focus: null }))}
          />
        ) : (
          <Start />
        )}
      </main>
      {selected && review.open ? (
        <aside ref={sheet} tabIndex={-1} className="vy-panel flex w-[min(460px,38%)] shrink-0 flex-col outline-none" aria-label="Review">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
            <span className="text-sm text-fg-strong">Review</span>
            <span className="text-xs text-tertiary">{plural(editsOf(selected.turns).length, 'file')}</span>
            <span className="flex-1" />
            <IconButton icon="close" label="Close Review (Esc)" size="xs" tone="muted" onClick={() => setReview({ open: false, focus: null })} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
            <ReviewList
              key={review.focus ?? ''}
              turns={selected.turns}
              focus={review.focus}
              settled={selected.settled}
              onSettle={isLive(lastTurn(selected)) ? undefined : settleEdits}
            />
          </div>
        </aside>
      ) : null}
    </div>
  )
}

/* ─── The thread ─────────────────────────────────────────────────────────── */

function ThreadView({
  thread,
  focusBox,
  onReview,
  reviewOpen,
  onToggleReview
}: {
  thread: Thread
  focusBox: boolean
  onReview: (path?: string) => void
  reviewOpen: boolean
  onToggleReview: () => void
}) {
  const { send, steerNow, stop, queued, steer, unqueue } = useThreads()
  const turn = lastTurn(thread)
  const live = isLive(turn) || turn.streamStart != null
  // What Review lists — edits as they happen, not only once the turn settles — so a chip opens the same place mid-stream.
  const changed = useMemo(
    () => new Set([...thread.turns.flatMap((t) => t.files.map((f) => f.path)), ...editsOf(thread.turns).map((e) => e.path)]),
    [thread.turns]
  )
  // Every file the thread read or changed: the paths an answer can turn into chips.
  const known = useMemo(
    () => new Set([...changed, ...thread.turns.flatMap((t) => t.steps.flatMap((s) => s.work.flatMap((w) => (w.kind === 'read' ? w.paths : w.kind === 'edit' ? [w.path] : [])))) ]),
    [thread.turns, changed]
  )
  // A changed file opens in Review; any other opens in the editor — which the mockup can only say.
  const openFile = useCallback(
    (path: string, line?: number) => (changed.has(path) ? onReview(path) : pushToast(`In the app this opens ${path}${line ? ` at line ${line}` : ''} in the editor.`, 'info')),
    [changed, onReview]
  )
  const edits = editsOf(thread.turns).length
  const { scroller, content, away, toEnd } = useStickToEnd()
  const [menu, setMenu] = useState(false)

  return (
    <>
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
        <h1 className="min-w-0 truncate text-sm text-fg-strong">{thread.title}</h1>
        <span className="flex min-w-0 shrink items-center gap-1 truncate text-caption text-tertiary">
          <span>{thread.workspace}</span>
          <Icon name="branch" size={11} />
          <span className="font-mono">{thread.branch}</span>
        </span>
        <span className="flex-1" />
        {isLive(turn) ? (
          <Button size="xs" variant="secondary" icon="stop" onClick={stop}>
            Stop
          </Button>
        ) : null}
        {edits > 0 ? (
          <Button size="xs" variant={reviewOpen ? 'secondary' : 'ghost'} icon="diff" onClick={onToggleReview} aria-pressed={reviewOpen} data-review-toggle>
            Review {edits}
          </Button>
        ) : null}
        <ActionMenu
          open={menu}
          onOpenChange={setMenu}
          placement="down"
          align="end"
          aria-label="Thread actions"
          items={[
            { id: 'copy', label: 'Copy thread as Markdown', icon: 'copy', onSelect: () => void navigator.clipboard?.writeText(asMarkdown(thread)).catch(() => undefined) },
            { id: 'review', label: 'Open Review', icon: 'diff', disabled: edits === 0, disabledReason: 'Nothing changed yet', onSelect: () => onReview() }
          ]}
          trigger={(t) => <IconButton {...t} icon="more" label="Thread actions" size="xs" tone="muted" active={menu} />}
        />
      </header>

      <div className="relative min-h-0 flex-1">
        <div ref={scroller} className="absolute inset-0 overflow-y-auto scroll-thin [scrollbar-gutter:stable]">
          <div ref={content} className="mx-auto max-w-[768px] space-y-10 px-6 pb-10 pt-6">
            {thread.turns.map((t, i) => (
              <TurnView key={t.id} turn={t} last={i === thread.turns.length - 1} locked={live} files={known} settled={thread.settled} onReview={onReview} onOpenFile={openFile} />
            ))}
          </div>
        </div>
        {away ? (
          <button
            type="button"
            onClick={toEnd}
            className="th-rise absolute bottom-3 left-1/2 inline-flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-bg px-3 text-xs text-secondary hover:border-border-strong hover:text-fg-strong focus-visible:vy-focus-ring"
          >
            <Icon name="arrowDown" size={12} />
            {live ? 'Follow the latest' : 'Jump to latest'}
          </button>
        ) : null}
      </div>

      <div className="mx-auto w-full max-w-[768px] px-6 pb-4">
        {queued.length ? (
          <ul className="mb-2 space-y-1" aria-label="Queued messages">
            {queued.map((q) => (
              <li key={q.id} className="th-rise flex h-8 min-w-0 items-center gap-2 rounded-lg bg-surface pl-3 pr-1 text-xs">
                <Icon name="clock" size={13} className="shrink-0 text-tertiary" />
                <span className="shrink-0 text-tertiary">{isLive(turn) ? 'Next' : 'Waiting'}</span>
                <span className="min-w-0 flex-1 truncate text-fg">{q.text}</span>
                <button
                  type="button"
                  onClick={() => steer(q.id)}
                  className={cn('h-6 shrink-0 rounded-md px-2 text-caption font-medium text-secondary hover:text-fg-strong focus-visible:vy-focus-ring', HOVER_ON_SURFACE)}
                >
                  {isLive(turn) ? 'Send now' : 'Send'}
                </button>
                <IconButton icon="close" label="Remove from queue" size="xs" tone="onSurface" onClick={() => unqueue(q.id)} />
              </li>
            ))}
          </ul>
        ) : null}
        <Composer
          draftKey={thread.id}
          live={live}
          placeholder={composerPlaceholder(turn)}
          onSend={(text, mode, opts) => send(text, mode, opts)}
          onSteer={isLive(turn) ? steerNow : undefined}
          focusOnMount={focusBox}
        />
      </div>
      <Announcer turn={turn} />
    </>
  )
}

/**
 * Follow the end while new content arrives — streaming text, a new step —
 * unless the reader has scrolled up; then offer the way back instead of
 * pulling them down. Watches the content's size, so it follows growth no
 * prop change would announce.
 */
function useStickToEnd() {
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [away, setAway] = useState(false)

  useLayoutEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  useEffect(() => {
    const el = scroller.current
    const inner = content.current
    if (!el || !inner) return
    const onScroll = (): void => {
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < 64
      pinned.current = near
      setAway(!near)
    }
    const ro = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight
      else setAway(true)
    })
    el.addEventListener('scroll', onScroll, { passive: true })
    ro.observe(inner)
    return () => {
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
    }
  }, [])

  const toEnd = useCallback(() => {
    const el = scroller.current
    if (!el) return
    pinned.current = true
    // Instant, not smooth: a smooth scroll reports itself as "away" mid-flight
    // and stops short when the answer grows under it.
    el.scrollTop = el.scrollHeight
    setAway(false)
  }, [])

  return { scroller, content, away, toEnd }
}

/** Says, once, when the thread changes state — for screen readers. */
function Announcer({ turn }: { turn: Turn }) {
  const [said, setSaid] = useState('')
  const [was, setWas] = useState(turn.state)
  if (turn.state !== was) {
    setWas(turn.state)
    setSaid(
      turn.state === 'done'
        ? `Reply finished${turn.files.length ? `, ${plural(turn.files.length, 'file')} changed` : ''}.`
        : turn.state === 'needs'
          ? 'It is waiting for your approval.'
          : turn.state === 'failed'
            ? `Failed: ${turn.error?.title ?? 'the run stopped'}.`
            : turn.state === 'stopped'
              ? 'Stopped.'
              : 'Working.'
    )
  }
  return (
    <div className="sr-only" role="status" aria-live="polite">
      {said}
    </div>
  )
}

function asMarkdown(thread: Thread): string {
  return [`# ${thread.title}`, ...thread.turns.flatMap((t) => [`**You:** ${t.ask}`, t.answer ?? ''])].filter(Boolean).join('\n\n')
}

/* ─── A new thread ───────────────────────────────────────────────────────── */

const SUGGESTIONS: { text: string; mode: 'agent' | 'ask'; icon: 'question' | 'edit' | 'checklist' }[] = [
  { text: 'Explain how the session store works', mode: 'ask', icon: 'question' },
  { text: 'Add a test for the rate limiter', mode: 'agent', icon: 'checklist' },
  { text: 'Rename `useTheme` to `useAppearance` everywhere', mode: 'agent', icon: 'edit' }
]

function Start() {
  const { send } = useThreads()
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
        <span className="text-sm text-fg-strong">New thread</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col justify-center overflow-y-auto px-6 pb-16">
        <div className="mx-auto w-full max-w-[640px]">
          <h1 className="text-title font-semibold tracking-[var(--vy-tracking-tight)] text-fg-strong">What should we work on?</h1>
          <p className="flex items-center gap-1.5 pb-5 pt-1 text-xs text-tertiary">
            <Icon name="folder" size={12} /> storefront <Icon name="branch" size={12} className="ml-1" /> <span className="font-mono">main</span>
          </p>
          <Composer draftKey="new" live={false} placeholder={composerPlaceholder(null)} onSend={(text, mode, opts) => send(text, mode, opts)} rows={3} focusOnMount />
          <ul className="mt-4 space-y-px" aria-label="Suggestions">
            {SUGGESTIONS.map((s) => (
              <li key={s.text}>
                <button
                  type="button"
                  onClick={() => send(s.text.replace(/`/g, ''), s.mode)}
                  className={cn('group -mx-2 flex h-8 w-[calc(100%+16px)] items-center gap-2.5 rounded-md px-2 text-left text-xs text-secondary hover:bg-surface hover:text-fg-strong focus-visible:vy-focus-ring')}
                >
                  <Icon name={s.icon} size={14} className="shrink-0 text-tertiary" />
                  <span className="min-w-0 flex-1 truncate">{s.text.replace(/`/g, '')}</span>
                  <span className="shrink-0 text-caption text-tertiary">{s.mode === 'ask' ? 'Ask' : 'Agent'}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
