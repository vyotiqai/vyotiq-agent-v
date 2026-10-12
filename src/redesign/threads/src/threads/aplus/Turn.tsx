import { useEffect, useMemo, useRef, useState } from 'react'
import { announceLive } from '@renderer/lib/a11y/useLiveAnnouncer'
import { Icon } from '@renderer/lib/icons'
import { copyText } from '@renderer/lib/markdown/copyText'
import { Button, DiffStat, IconButton, cn } from '@renderer/lib/ui'
import { ROW_HOVER } from '@renderer/lib/utils/layout'
import { MODEL, type Turn } from '../data'
import { Markdown } from '../markdown'
import { Approval, CheckGlyph, Path, fmtCost, fmtSecs, plural } from '../parts'
import { isLive, pendingAsk, useThreads } from '../store'
import { useReveal } from '../stream'
import { Activity } from './Activity'

/*
  One turn, in the order it happened: what you said, the work (one line),
  anything it needs from you, the answer, then what it left — files and
  checks — and a quiet footer. Nothing below the answer appears until the
  answer has finished arriving.
*/

export function TurnView({
  turn,
  last,
  locked,
  files,
  settled,
  onReview,
  onOpenFile
}: {
  turn: Turn
  /** What you did with the thread's edits in Review. */
  settled?: 'kept' | 'undone'
  /** The thread's latest turn: its footer stays visible, earlier ones on hover. */
  last: boolean
  /** The thread is working: editing an earlier ask would race it. */
  locked: boolean
  /** Files the thread read or changed: the paths an answer can open. */
  files: ReadonlySet<string>
  onReview: (path?: string) => void
  onOpenFile: (path: string, line?: number) => void
}) {
  return (
    <article className="space-y-3" data-turn={turn.state} aria-label={`You: ${turn.ask.slice(0, 60)}`}>
      <YouSaid turn={turn} locked={locked} />
      <Reply turn={turn} last={last} files={files} settled={settled} onReview={onReview} onOpenFile={onOpenFile} />
    </article>
  )
}

/* ─── What you said ─────────────────────────────────────────────────────── */

function YouSaid({ turn, locked }: { turn: Turn; locked: boolean }) {
  const { rerun } = useThreads()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(turn.ask)
  const field = useRef<HTMLTextAreaElement>(null)
  const editButton = useRef<HTMLButtonElement>(null)
  const restore = useRef(false)
  useEffect(() => {
    if (!editing && restore.current) {
      restore.current = false
      editButton.current?.focus()
    }
    if (!editing) return
    const el = field.current
    el?.focus()
    el?.setSelectionRange(el.value.length, el.value.length)
  }, [editing])
  useEffect(() => {
    const el = field.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [draft, editing])

  if (editing) {
    const cancel = (): void => {
      setDraft(turn.ask)
      setEditing(false)
      restore.current = true
    }
    const save = (): void => {
      if (!draft.trim()) return
      setEditing(false)
      rerun(turn.id, draft)
    }
    return (
      <div className="ml-auto w-[85%] rounded-xl border border-border-strong bg-bg p-2" data-editing>
        <textarea
          ref={field}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              save()
            }
            if (e.key === 'Escape') cancel()
          }}
          aria-label="Edit your message"
          rows={1}
          className="block w-full resize-none bg-transparent px-1.5 py-1 text-sm leading-[22px] text-fg-strong outline-none"
        />
        <div className="flex items-center gap-1.5 pt-1.5">
          <span className="min-w-0 flex-1 truncate pl-1.5 text-caption text-tertiary">Runs again from here. Later replies are replaced.</span>
          <Button size="xs" variant="ghost" onClick={cancel}>
            Cancel
          </Button>
          <Button size="xs" variant="primary" onClick={save} disabled={!draft.trim()}>
            Send
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="group relative ml-auto w-fit max-w-[85%]">
      <div className="rounded-xl bg-surface px-3.5 py-2.5 text-sm leading-[22px] text-fg-strong">
        {turn.mode === 'ask' ? <span className="mr-1.5 inline-block -translate-y-px rounded-sm bg-bg px-1 text-caption text-muted">Ask</span> : null}
        <span className="whitespace-pre-wrap">{turn.ask}</span>
        {turn.attachments?.length ? (
          <span className="mt-2 flex flex-wrap gap-1">
            {turn.attachments.map((a) => (
              <span key={a} className="inline-flex h-6 items-center gap-1 rounded-md bg-bg px-1.5 text-caption text-secondary">
                <Icon name="file" size={12} className="text-tertiary" />
                {a}
              </span>
            ))}
          </span>
        ) : null}
      </div>
      <div className="absolute bottom-0 right-full mr-1 flex h-7 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <span className="px-1 font-mono tnum text-caption text-tertiary">{turn.at}</span>
        <CopyButton text={turn.ask} label="Copy message" />
        <IconButton
          ref={editButton}
          icon="edit"
          label={locked ? 'Edit (after it finishes)' : 'Edit and run again'}
          size="xs"
          tone="muted"
          disabled={locked}
          onClick={() => {
            setDraft(turn.ask)
            setEditing(true)
          }}
        />
      </div>
    </div>
  )
}

/* ─── What it said and did ──────────────────────────────────────────────── */

function Reply({
  turn,
  last,
  files,
  settled,
  onReview,
  onOpenFile
}: {
  turn: Turn
  last: boolean
  files: ReadonlySet<string>
  settled?: 'kept' | 'undone'
  onReview: (path?: string) => void
  onOpenFile: (path: string, line?: number) => void
}) {
  const { answer: respond, retry, send } = useThreads()
  const ask = pendingAsk(turn)
  const { shown, streaming } = useReveal(turn.answer ?? '', turn.streamStart)
  const over = !isLive(turn) && !streaming
  // An approval that was already waiting when you opened the thread does not
  // grab focus; one that appears while you watch does.
  const [waitingAtMount] = useState(turn.state === 'needs')

  return (
    <div className="group/reply space-y-3" aria-busy={turn.state === 'running' || undefined}>
      <Activity turn={turn} />

      {ask ? <Approval w={ask} onAnswer={respond} takeFocus={!waitingAtMount} /> : null}

      {turn.error ? (
        <ErrorNote
          error={turn.error}
          onRetry={last ? retry : undefined}
          onHint={last && turn.error.hint ? () => send('Mock Redis in the session tests instead of needing a live server, then run them again.', 'agent') : undefined}
        />
      ) : null}

      {shown ? <Markdown text={shown} streaming={streaming} onOpenFile={onOpenFile} files={files} /> : null}

      {over && turn.state === 'done' && (turn.files.length > 0 || turn.checks.length > 0) ? (
        <div className="th-rise">
          <Outcome turn={turn} settled={settled} onReview={onReview} />
        </div>
      ) : null}

      {over ? <Foot turn={turn} last={last} /> : null}
    </div>
  )
}

/* ─── What it left ──────────────────────────────────────────────────────── */

function Outcome({ turn, settled, onReview }: { turn: Turn; settled?: 'kept' | 'undone'; onReview: (path?: string) => void }) {
  const [all, setAll] = useState(false)
  const add = turn.files.reduce((n, f) => n + f.add, 0)
  const del = turn.files.reduce((n, f) => n + f.del, 0)
  const shown = all ? turn.files : turn.files.slice(0, 4)
  return (
    <div className="space-y-3 pt-1" data-outcome>
      {turn.files.length ? (
        <div role="group" aria-label="Files changed">
          <div className="flex h-7 items-center gap-2 text-xs">
            <Icon name="diff" size={14} className="shrink-0 text-tertiary" />
            <span className="text-secondary">Changed {plural(turn.files.length, 'file')}</span>
            <DiffStat add={add} del={del} />
            {settled ? <span className="text-tertiary">· {settled === 'kept' ? 'Kept' : 'Undone'}</span> : null}
            <span className="flex-1" />
            <Button size="xs" variant="ghost" trailingIcon="chevronRight" onClick={() => onReview()}>
              Review
            </Button>
          </div>
          <ul className="pl-6">
            {shown.map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  onClick={() => onReview(f.path)}
                  className={cn('group -mx-2 flex h-7 w-[calc(100%+16px)] min-w-0 items-center gap-2 rounded-md px-2 text-left text-xs focus-visible:vy-focus-ring', ROW_HOVER)}
                >
                  <Path path={f.path} className="flex-1 font-mono text-caption" />
                  {f.created ? <span className="shrink-0 text-caption text-tertiary">New</span> : null}
                  <DiffStat add={f.add} del={f.del} className="shrink-0" />
                </button>
              </li>
            ))}
            {turn.files.length > 4 && !all ? (
              <li>
                <button
                  type="button"
                  onClick={() => setAll(true)}
                  className={cn('-mx-2 flex h-7 w-[calc(100%+16px)] items-center rounded-md px-2 text-xs text-muted focus-visible:vy-focus-ring', ROW_HOVER)}
                >
                  {turn.files.length - 4} more
                </button>
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
      {turn.checks.length ? (
        <div role="group" aria-label="Done when">
          <div className="flex h-7 items-center gap-2 text-xs">
            <Icon name="target" size={14} className="shrink-0 text-tertiary" />
            <span className="text-secondary">
              {turn.checks.filter((c) => c.state === 'met').length} of {plural(turn.checks.length, 'check')} met
            </span>
          </div>
          <ul className="space-y-1 pl-6">
            {turn.checks.map((c) => (
              <li key={c.text} className="flex min-w-0 items-start gap-2 text-xs leading-[18px]">
                <span className="mt-px">
                  <CheckGlyph state={c.state} />
                </span>
                <span className="min-w-0">
                  <span className={c.state === 'open' ? 'text-muted' : 'text-fg'}>{c.text}</span>
                  <span className="sr-only">{c.state === 'met' ? ' — met' : c.state === 'unmet' ? ' — not met' : ' — not checked yet'}</span>
                  {c.evidence ? <span className="block truncate font-mono text-caption text-tertiary">{c.evidence}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

/** What went wrong. Only the latest turn offers Retry: an older one has been moved past. */
function ErrorNote({ error, onRetry, onHint }: { error: NonNullable<Turn['error']>; onRetry?: () => void; onHint?: () => void }) {
  return (
    <div className="rounded-lg bg-danger-soft px-3 py-2.5" role={onRetry ? 'alert' : 'group'} aria-label="What went wrong">
      <div className="flex items-start gap-2">
        <Icon name="warningCircle" size={15} weight="fill" className="mt-0.5 shrink-0 text-danger" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-fg-strong">{error.title}</div>
          <p className="text-xs leading-[18px] text-secondary">{error.detail}</p>
          <p className="pt-0.5 font-mono text-caption text-tertiary">{error.where}</p>
          {onRetry ? (
            <div className="flex flex-wrap gap-1.5 pt-2.5">
              <Button size="sm" variant="secondary" icon="retry" onClick={onRetry}>
                Retry
              </Button>
              {onHint ? (
                <Button size="sm" variant="ghost" onClick={onHint}>
                  Ask it to mock Redis
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/* ─── Footer ─────────────────────────────────────────────────────────────── */

function Foot({ turn, last }: { turn: Turn; last: boolean }) {
  const { rerun, rate } = useThreads()
  const rating = turn.rating ?? null
  const setRating = (r: 'up' | 'down' | null): void => rate(turn.id, r)
  const meta = useMemo(() => [fmtSecs(turn.secs), fmtCost(turn.cost), turn.model ?? MODEL].join(' · '), [turn.secs, turn.cost, turn.model])
  return (
    <div
      className={cn(
        '-ml-1 flex h-7 items-center gap-0.5 transition-opacity',
        last || rating ? 'opacity-100' : 'opacity-0 group-hover/reply:opacity-100 group-focus-within/reply:opacity-100'
      )}
    >
      {turn.answer ? <CopyButton text={turn.answer} label="Copy reply" /> : null}
      {last && !turn.error ? <IconButton icon="retry" label="Run this again" size="xs" tone="muted" onClick={() => rerun(turn.id, turn.ask)} /> : null}
      <IconButton
        icon="thumbsUp"
        label="Good reply"
        size="xs"
        tone={rating === 'up' ? 'default' : 'muted'}
        active={rating === 'up'}
        onClick={() => setRating(rating === 'up' ? null : 'up')}
      />
      <IconButton
        icon="thumbsDown"
        label="Bad reply"
        size="xs"
        tone={rating === 'down' ? 'default' : 'muted'}
        active={rating === 'down'}
        onClick={() => setRating(rating === 'down' ? null : 'down')}
      />
      <span className="ml-2 font-mono tnum text-caption text-tertiary">{meta}</span>
    </div>
  )
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState<'copied' | 'failed' | null>(null)
  useEffect(() => {
    if (!done) return
    const id = window.setTimeout(() => setDone(null), 1400)
    return () => window.clearTimeout(id)
  }, [done])
  return (
    <IconButton
      icon={done === 'copied' ? 'check' : 'copy'}
      label={done === 'copied' ? 'Copied' : done === 'failed' ? 'Copy failed' : label}
      size="xs"
      tone="muted"
      onClick={() =>
        // Say "Copied" only when the clipboard took it.
        void copyText(text).then((ok) => {
          setDone(ok ? 'copied' : 'failed')
          announceLive(ok ? 'Copied' : 'Copy failed', ok ? 'polite' : 'assertive')
        })
      }
    />
  )
}
