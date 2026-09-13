import { useCallback, useEffect, useMemo, useState } from 'react'
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
  copyHidden = false
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
}) {
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const nowMs = useSharedNow(!omitReceipt && !omitDuration && active && startedAt != null)

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

  if (!caption && copyHidden) return null

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
    </div>
  )
}
