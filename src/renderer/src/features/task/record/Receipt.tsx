import type { ReactNode } from 'react'
import type { RunFeedbackRating } from '@shared/ipc'
import { checksTally, type DoneWhenCheck } from '@shared/doneWhenChecks'
import type { StepUsageTotals } from '@shared/utils/runTelemetry'
import { formatUsdCost } from '@shared/utils/costDisplay'
import { formatElapsed } from '@shared/utils/timeFormat'
import { IconButton, STATE_LABEL, StatusGlyph, cn, pushToast } from '@renderer/lib/ui'
import { copyText } from '@renderer/lib/markdown/copyText'
import { useSharedNow } from '@renderer/lib/hooks/useSharedNow'
import {
  cacheCaptionPct,
  cacheHitCaption,
  formatTokPerSec,
  freshCaptionTokens,
  outputTokensPerSecond,
  tokensCaption,
  turnCost
} from '@renderer/features/chat/utils/messageFooterStats'
import { RecordRow } from './RecordLayout'
import { stripSpokenBlock } from '@shared/spokenSummary'
import { ReadAloudButton } from '@renderer/features/voice/ReadAloudButton'

/** `detail`: telemetry (tokens, speed, cache) the line keeps for its hover, not its text. */
export type ReceiptPart = { key: string; text: string; title: string; detail?: true }

/**
 * A run's cost as the record says it: "~" marks an estimate from published
 * prices, but an estimate of nothing is nothing — a free model's "~$0" on
 * every row was a squiggle carrying no news.
 */
export function costLabel(cost: { cost: number; estimated: boolean }): string {
  return cost.estimated && cost.cost !== 0 ? `~${formatUsdCost(cost.cost)}` : formatUsdCost(cost.cost)
}

/**
 * The run's receipt as parts: wall time, tokens, output speed, cache share and
 * cost. A part appears only when the usage actually reports it — no zeroes
 * standing in for "unknown", and cost says "~" when it was estimated from
 * published prices rather than billed.
 */
export function receiptParts(
  usage: StepUsageTotals | null,
  durationMs: number | null,
  checks: readonly DoneWhenCheck[] = []
): ReceiptPart[] {
  const parts: ReceiptPart[] = []
  if (durationMs != null && durationMs >= 1000) parts.push({ key: 'time', text: formatElapsed(durationMs), title: 'Wall time' })
  if (checks.length > 0) {
    const t = checksTally(checks)
    parts.push({
      key: 'checks',
      text: `${t.met}/${t.total} checks met`,
      title: 'Done-when checks the agent marked met, each with its evidence'
    })
  }
  if (!usage || usage.steps <= 0) return parts
  const tokens = freshCaptionTokens(usage)
  if (tokens > 0) parts.push({ key: 'tokens', text: tokensCaption(tokens), title: 'Fresh input + output tokens', detail: true })
  const speed = outputTokensPerSecond(usage)
  if (speed != null) parts.push({ key: 'speed', text: formatTokPerSec(speed), title: 'Output speed', detail: true })
  const cache = cacheCaptionPct(usage)
  if (cache != null) parts.push({ key: 'cache', text: cacheHitCaption(cache), title: 'Prompt cache hits', detail: true })
  const cost = turnCost(usage)
  if (cost) {
    parts.push({
      key: 'cost',
      text: costLabel(cost),
      title: cost.estimated ? 'Estimated from published prices' : 'Billed by the provider'
    })
  }
  return parts
}

export function ReceiptLine({
  usage,
  startedAt,
  endedAt,
  live,
  feedback,
  checks = [],
  outcome,
  outcomeDetail,
  actions,
  summary,
  onRerun,
  readAloudId
}: {
  usage: StepUsageTotals | null
  startedAt: number | null
  endedAt: number | null
  /** The run's done-when checks; counted once the run has ended. */
  checks?: readonly DoneWhenCheck[]
  /** Still running: time ticks and there is nothing to rate yet. */
  live: boolean
  /** How a run that did not finish ended; a finished run says nothing here. */
  outcome?: 'stopped' | 'failed'
  /** Where it got to: "at step 2 of 4 · 3 files changed". */
  outcomeDetail?: string
  feedback?: { value: RunFeedbackRating | null; onRate: (rating: RunFeedbackRating | null) => void }
  /** What to do about how it ended (a stopped run: undo, resume), at the line's end. */
  actions?: ReactNode
  /** The run's result as text: a settled run offers to copy it. */
  summary?: string
  /** The latest finished run: run its instruction again. */
  onRerun?: () => void
  /** Offer to read the result aloud; the id tells this answer's button from the others. */
  readAloudId?: string
}) {
  const now = useSharedNow(live && startedAt != null)
  const end = live ? now : endedAt
  const duration = startedAt != null && end != null ? end - startedAt : null
  const all = receiptParts(usage, duration, live ? [] : checks)
  // Time, checks and cost answer "how did it go"; tokens, speed and cache are
  // for whoever tunes the harness: the line's hover, and its screen-reader text.
  const parts = all.filter((p) => !p.detail)
  const details = all.filter((p) => p.detail)
  const copyable = !live && Boolean(summary?.trim())
  const rerun = live ? undefined : onRerun
  if (parts.length === 0 && details.length === 0 && !feedback && !outcome && !actions && !copyable && !rerun) return null
  const rate = (rating: RunFeedbackRating): void => {
    if (!feedback) return
    feedback.onRate(feedback.value === rating ? null : rating)
  }
  return (
    <RecordRow className="border-t border-border">
      <div
        className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs text-tertiary tnum"
        title={details.length > 0 ? details.map((p) => p.text).join(' · ') : live ? 'So far' : 'Receipt'}
        data-receipt
      >
        {outcome ? (
          // How it ended leads the line, in words and a glyph, not colour alone.
          <span
            className={cn('inline-flex items-center gap-1.5 font-sans', outcome === 'failed' ? 'text-danger' : 'text-muted')}
            data-receipt-outcome={outcome}
          >
            <StatusGlyph state={outcome} size={12} />
            {STATE_LABEL[outcome]}
            {outcomeDetail ? <span data-receipt-outcome-detail> {outcomeDetail}</span> : null}
            {parts.length > 0 ? <span aria-hidden="true" className="ml-0.5 font-mono text-tertiary">·</span> : null}
          </span>
        ) : null}
        {parts.map((p, i) => (
          <span key={p.key} className="inline-flex items-center gap-2" title={p.title}>
            {i > 0 ? <span aria-hidden="true">·</span> : null}
            {/* The caption alone is cryptic; the meaning reaches screen readers. */}
            <span className="sr-only">{p.title}: </span>
            {p.text}
          </span>
        ))}
        {details.length > 0 ? (
          <span className="sr-only" data-receipt-details>
            {details.map((p) => `${p.title}: ${p.text}`).join('; ')}
          </span>
        ) : null}
        <span className="flex-1" />
        {actions ? (
          <span className="flex items-center gap-1 font-sans" data-receipt-actions>
            {actions}
          </span>
        ) : null}
        {!live && (feedback || copyable || rerun) ? (
          <span className="flex items-center gap-0.5">
            {rerun ? <IconButton icon="retry" label="Run this again" size="sm" tone="muted" onClick={rerun} /> : null}
            {feedback ? (
              <>
                <IconButton
                  icon="thumbsUp"
                  label={feedback.value === 'up' ? 'Marked helpful' : 'Mark helpful'}
                  size="sm"
                  tone="muted"
                  active={feedback.value === 'up'}
                  aria-pressed={feedback.value === 'up'}
                  onClick={() => rate('up')}
                />
                <IconButton
                  icon="thumbsDown"
                  label={feedback.value === 'down' ? 'Marked unhelpful' : 'Mark unhelpful'}
                  size="sm"
                  tone="muted"
                  active={feedback.value === 'down'}
                  aria-pressed={feedback.value === 'down'}
                  onClick={() => rate('down')}
                />
              </>
            ) : null}
            {copyable && readAloudId ? <ReadAloudButton text={summary!} owner={readAloudId} /> : null}
            {copyable ? (
              <IconButton icon="copy" label="Copy the summary" size="sm" tone="muted" onClick={() => copySummary(summary!)} />
            ) : null}
          </span>
        ) : null}
      </div>
    </RecordRow>
  )
}

/** The result as it reads, markdown and all, onto the clipboard. */
function copySummary(text: string): void {
  // A voice answer's spoken summary is for the ear; the copy is the written answer.
  void copyText(stripSpokenBlock(text).trim()).then((ok) => {
    if (ok) pushToast('Summary copied', { icon: 'copy' })
    else pushToast('Could not copy the summary.', 'error')
  })
}
