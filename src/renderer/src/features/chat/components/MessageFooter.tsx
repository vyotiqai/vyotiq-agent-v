import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import { RUN_FEEDBACK_NOTE_MAX, type RunFeedbackRating } from '@shared/ipc'
import { Icon } from '@renderer/lib/icons'
import { Tooltip, cn } from '@renderer/lib/ui'
import { copyText } from '@renderer/lib/markdown/copyText'
import { useSharedNow } from '@renderer/lib/hooks/useSharedNow'
import { buildFooterStats } from '../utils/messageFooterStats'
import type { StepUsageTotals } from '@shared/utils/runTelemetry'

const COPIED_FEEDBACK_MS = 1600

export function MessageFooter({
  content,
  at,
  copyContent,
  startedAt = null,
  endedAt = null,
  active = false,
  usage = null,
  omitDuration = false,
  omitReceipt = false,
  copyHidden = false,
  runFeedback
}: {
  content: string
  at?: string
  copyContent?: string
  startedAt?: number | null
  endedAt?: number | null
  active?: boolean
  usage?: StepUsageTotals | null
  /** Live TurnSummary already shows elapsed. */
  omitDuration?: boolean
  /** Live TurnSummary already shows the receipt. */
  omitReceipt?: boolean
  /** Hide copy until the closing answer finishes streaming. */
  copyHidden?: boolean
  /**
   * Per-run verdict. Supplied only for the last answer of a finished run, so
   * one run gets one rating control rather than one per turn.
   */
  runFeedback?: {
    value: RunFeedbackRating | null
    note?: string
    onRate: (rating: RunFeedbackRating | null, note?: string) => void
  }
}) {
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const nowMs = useSharedNow(!omitReceipt && !omitDuration && active && startedAt != null)

  const savedNote = runFeedback?.note ?? ''
  const noteActive = runFeedback != null && runFeedback.value != null
  const [noteDraft, setNoteDraft] = useState('')

  // The note input only exists while a verdict is active; the draft tracks
  // the stored note so an optimistic rollback snaps the text back too.
  useEffect(() => {
    if (!noteActive) return
    setNoteDraft(savedNote)
  }, [noteActive, savedNote])

  const stats = useMemo(
    () =>
      buildFooterStats({
        startedAt,
        endedAt,
        active,
        nowMs,
        at,
        usage,
        omitDuration,
        omitReceipt
      }),
    [startedAt, endedAt, active, nowMs, at, usage, omitDuration, omitReceipt]
  )

  useEffect(() => {
    if (!copied && !copyError) return undefined
    const id = window.setTimeout(() => {
      setCopied(false)
      setCopyError(false)
    }, COPIED_FEEDBACK_MS)
    return () => window.clearTimeout(id)
  }, [copied, copyError])

  const onCopy = useCallback(() => {
    void copyText(copyContent ?? content).then((didCopy) => {
      if (didCopy) {
        setCopied(true)
        setCopyError(false)
      } else {
        setCopied(false)
        setCopyError(true)
      }
    })
  }, [content, copyContent])

  // Enter and blur both submit; an unchanged draft never re-fires the IPC.
  const submitNote = () => {
    if (!noteActive || !runFeedback) return
    const trimmed = noteDraft.trim()
    if (trimmed === savedNote) return
    runFeedback.onRate(runFeedback.value, trimmed || undefined)
  }

  const onNoteKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Escape') return
    setNoteDraft(savedNote)
    e.currentTarget.blur()
  }

  if (!content.trim()) return null

  const label = copied ? 'Copied' : copyError ? 'Copy failed' : 'Copy message'
  const caption = stats.caption ? (
    stats.tooltip ? (
      <Tooltip content={stats.tooltip}>
        <span className="min-w-0 truncate tabular-nums" aria-label={stats.ariaLabel}>
          {stats.caption}
        </span>
      </Tooltip>
    ) : (
      <span className="min-w-0 truncate tabular-nums" aria-label={stats.ariaLabel}>
        {stats.caption}
      </span>
    )
  ) : null

  if (!caption && copyHidden && !runFeedback) return null

  const rateButton = (rating: RunFeedbackRating): ReactNode => {
    if (!runFeedback) return null
    const active = runFeedback.value === rating
    const label =
      rating === 'up'
        ? active
          ? 'Marked helpful'
          : 'Mark helpful'
        : active
          ? 'Marked unhelpful'
          : 'Mark unhelpful'
    return (
      <Tooltip content={label} describeChild={false}>
        <button
          type="button"
          className={cn(
            'inline-grid size-6 shrink-0 place-items-center rounded-sm vy-transition',
            'opacity-0 hover:bg-surface hover:text-fg focus-visible:opacity-100',
            'group-hover/message:opacity-100 [@media(hover:none)]:opacity-100',
            active && 'opacity-100',
            active && (rating === 'up' ? 'text-success' : 'text-danger')
          )}
          // Clicking the active verdict clears it — the rating is a toggle,
          // and a mis-click must be undoable without a second control.
          onClick={() => runFeedback.onRate(active ? null : rating)}
          aria-label={label}
          aria-pressed={active}
        >
          <Icon name={rating === 'up' ? 'thumbsUp' : 'thumbsDown'} size={14} />
        </button>
      </Tooltip>
    )
  }

  return (
    <div className="mt-1.5 flex min-w-0 items-center gap-1 text-2xs text-muted">
      {caption}
      {copyHidden ? null : (
        <Tooltip content={label} describeChild={false}>
          <button
            type="button"
            className={cn(
              'inline-grid size-6 shrink-0 place-items-center rounded-sm vy-transition',
              'opacity-0 hover:bg-surface hover:text-fg focus-visible:opacity-100',
              'group-hover/message:opacity-100 [@media(hover:none)]:opacity-100',
              copied && 'opacity-100 text-success',
              copyError && 'opacity-100 text-danger'
            )}
            onClick={onCopy}
            aria-label={label}
          >
            <Icon name={copied ? 'check' : 'copy'} size={14} />
          </button>
        </Tooltip>
      )}
      {rateButton('up')}
      {rateButton('down')}
      {noteActive && runFeedback ? (
        <input
          type="text"
          className="min-w-0 flex-1 bg-transparent text-2xs text-muted focus:outline-none"
          maxLength={RUN_FEEDBACK_NOTE_MAX}
          value={noteDraft}
          onChange={(e) => setNoteDraft(e.target.value)}
          onBlur={submitNote}
          onKeyDown={onNoteKeyDown}
          placeholder="Add a note…"
          aria-label="Feedback note"
        />
      ) : null}
    </div>
  )
}
