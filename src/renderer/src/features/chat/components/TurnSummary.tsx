import { memo, useMemo } from 'react'
import { Icon, type IconName } from '@renderer/lib/icons'
import { Tooltip, cn } from '@renderer/lib/ui'
import { DISCLOSURE_CHEVRON, DISCLOSURE_ROW } from '@renderer/lib/utils/layout'
import { formatElapsed } from '@shared/utils/timeFormat'
import { useSharedNow } from '@renderer/lib/hooks/useSharedNow'
import type { StepUsageTotals } from '@shared/utils/runTelemetry'
import type { TurnSpan } from '../utils/transcriptRows'
import { turnSummaryActiveLabel } from '../utils/runActivity'
import { buildFooterStats } from '../utils/messageFooterStats'
import { TextShimmer } from './TextShimmer'

/** Below this the duration is noise; the turn was effectively instant. */
const MIN_REPORTABLE_MS = 1000

export const TurnSummary = memo(function TurnSummary({
  span,
  collapsed,
  onToggle,
  controlsId,
  suppressPhaseLabel = false,
  usage = null
}: {
  span: TurnSpan
  collapsed: boolean
  onToggle?: () => void
  controlsId?: string
  /** Live expanded with tool chrome visible — elapsed + collapse only. */
  suppressPhaseLabel?: boolean
  usage?: StepUsageTotals | null
}) {
  const { startedAt, endedAt, active, activity } = span
  const terminalStatus = span.status ?? (span.failed ? 'error' : 'done')
  const now = useSharedNow(active && startedAt != null)

  const turnElapsedMs =
    startedAt == null ? null : active ? now - startedAt : endedAt == null ? null : endedAt - startedAt

  const turnDuration = useMemo(
    () =>
      turnElapsedMs != null && turnElapsedMs >= MIN_REPORTABLE_MS ? formatElapsed(turnElapsedMs) : '',
    [turnElapsedMs]
  )

  const hidePhase = suppressPhaseLabel && active && !collapsed
  const phaseLabel = turnSummaryActiveLabel(activity)
  const receipt = useMemo(
    () =>
      buildFooterStats({
        startedAt: null,
        endedAt: null,
        active: false,
        nowMs: 0,
        usage,
        omitDuration: true,
        omitReceipt: !active && terminalStatus !== 'done'
      }),
    [active, terminalStatus, usage]
  )
  const receiptCaption = receipt.caption
  const activeText = hidePhase
    ? [turnDuration, receiptCaption].filter(Boolean).join(' · ')
    : [phaseLabel, turnDuration, receiptCaption].filter(Boolean).join(' · ')
  const emptyLiveChrome = hidePhase && !turnDuration && !receiptCaption

  const doneLabel =
    terminalStatus === 'cancelled'
      ? 'Cancelled'
      : terminalStatus === 'interrupted'
        ? 'Interrupted'
        : terminalStatus === 'error'
          ? span.failureLabel?.trim() || 'Failed'
          : 'Completed'
  const doneDuration = terminalStatus === 'done' ? (usage ? turnDuration : '') : turnDuration
  // No closing-answer footer: keep duration + verified usage on this row.
  const doneText = !active
    ? [doneLabel, doneDuration, receiptCaption].filter(Boolean).join(' · ')
    : doneLabel
  const statusTone =
    terminalStatus === 'error'
      ? 'text-danger'
      : terminalStatus === 'cancelled' || terminalStatus === 'interrupted'
        ? 'text-warning'
        : undefined
  // Terminal rows get a scannable status mark before the text so the transcript
  // reads at a glance; live rows keep the phase label as the mark.
  const statusIcon: IconName =
    terminalStatus === 'done'
      ? 'check'
      : terminalStatus === 'error'
        ? 'warning'
        : 'minimize'
  const statusIconTone =
    terminalStatus === 'done' ? 'text-success' : (statusTone ?? 'text-tertiary')

  let accessibleName = doneText
  if (active) {
    if (collapsed) {
      accessibleName = activeText || phaseLabel
    } else {
      accessibleName = activeText
        ? `Collapse turn work, ${activeText}`
        : 'Collapse turn work'
    }
  }

  const receiptMark =
    receiptCaption ? (
      receipt.tooltip ? (
        <Tooltip content={receipt.tooltip}>
          <span className="shrink-0 tabular-nums">
            {hidePhase ? (turnDuration ? `· ${receiptCaption}` : receiptCaption) : `· ${receiptCaption}`}
          </span>
        </Tooltip>
      ) : (
        <span className="shrink-0 tabular-nums">
          {hidePhase && !turnDuration ? receiptCaption : `· ${receiptCaption}`}
        </span>
      )
    ) : null

  return (
    <button
      type="button"
      className={cn(DISCLOSURE_ROW, 'group w-full text-left text-tertiary')}
      aria-expanded={!collapsed}
      aria-controls={controlsId}
      aria-label={accessibleName}
      onClick={onToggle}
      disabled={!onToggle}
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        {active ? (
          hidePhase ? (
            <>
              {turnDuration ? (
                <span className="shrink-0 tabular-nums">{turnDuration}</span>
              ) : null}
              {receiptMark}
            </>
          ) : (
            <>
              {collapsed ? (
                <TextShimmer className="min-w-0 truncate">{phaseLabel}</TextShimmer>
              ) : (
                <span className="min-w-0 truncate">{phaseLabel}</span>
              )}
              {turnDuration ? (
                <span className="shrink-0 tabular-nums">· {turnDuration}</span>
              ) : null}
              {receiptMark}
            </>
          )
        ) : (
          <>
            <Icon
              name={statusIcon}
              size={13}
              className={cn('shrink-0 tool-status-morph', statusIconTone)}
            />
            {receiptCaption && receipt.tooltip ? (
              <Tooltip content={receipt.tooltip}>
                <span className={cn('min-w-0 truncate tabular-nums', statusTone)}>{doneText}</span>
              </Tooltip>
            ) : (
              <span className={cn('min-w-0 truncate tabular-nums', statusTone)}>{doneText}</span>
            )}
          </>
        )}
      </span>
      <Icon
        name="chevronRight"
        size={14}
        className={cn(
          DISCLOSURE_CHEVRON,
          'self-center',
          !collapsed && 'rotate-90',
          emptyLiveChrome && 'opacity-100'
        )}
      />
    </button>
  )
})
