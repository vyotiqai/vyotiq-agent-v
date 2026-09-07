import { useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@renderer/lib/icons'
import { cn } from '@renderer/lib/ui/cn'
import { useDropdownMenu } from '@renderer/lib/hooks/useDropdownMenu'
import { formatTokens } from '@renderer/lib/utils/formatTokens'
import {
  alignContextUsageToModelWindow,
  type ContextUsageState
} from '@shared/utils/contextUsage'
import type { StepUsageTotals } from '@shared/utils/runTelemetry'
import {
  LONG_RUN_BILLED_INPUT_HINT_THRESHOLD,
  LONG_RUN_STEP_HINT_THRESHOLD
} from '@shared/utils/tokenCost'
import { clampComposerDropdownPanel } from './composerDropdownLayout'

export type { ContextUsageState }

const PANEL_MAX_PX = 300
const RING_STROKE = 2.5
const LONG_RUN_TIP_CUE = 'Long run — /clear between unrelated tasks'

function longRunTipCue(
  usage: ContextUsageState,
  advisoryHint?: string | null
): string | null {
  if (advisoryHint && /Long run — \/clear/i.test(advisoryHint)) return advisoryHint
  if (
    usage.stepUsage.steps >= LONG_RUN_STEP_HINT_THRESHOLD ||
    usage.stepUsage.billedInputTokens >= LONG_RUN_BILLED_INPUT_HINT_THRESHOLD
  ) {
    return LONG_RUN_TIP_CUE
  }
  return advisoryHint ?? null
}

type UsageLevel = 'normal' | 'warning' | 'danger'

function usageLevel(ratio: number, overBudget: boolean): UsageLevel {
  if (overBudget || ratio >= 0.9) return 'danger'
  if (ratio >= 0.7) return 'warning'
  return 'normal'
}

const levelRing: Record<UsageLevel, string> = {
  normal: 'text-fg',
  warning: 'text-warning',
  danger: 'text-danger'
}

const levelFill: Record<UsageLevel, string> = {
  normal: 'bg-fg',
  warning: 'bg-warning',
  danger: 'bg-danger'
}

const levelSoft: Record<UsageLevel, string> = {
  normal: 'bg-fg/10',
  warning: 'bg-warning/12',
  danger: 'bg-danger/12'
}

function formatPct(n: number, total: number): string {
  if (total <= 0) return '0%'
  const pct = (n / total) * 100
  if (pct > 0 && pct < 1) return `${pct.toFixed(1)}%`
  if (pct >= 10) return `${Math.round(pct)}%`
  return `${pct.toFixed(1)}%`
}

function usageMetrics(usage: ContextUsageState) {
  const budget = Math.max(1, usage.contentWindow > 0 ? usage.contentWindow : usage.window)
  const overBudget = usage.used > budget || usage.overflow === true
  const ratio = Math.min(1, usage.used / budget)
  const displayPct = overBudget ? Math.round((usage.used / budget) * 100) : Math.round(ratio * 100)
  const level = usageLevel(ratio, overBudget)
  const overage = overBudget ? usage.used - budget : 0
  const compactRatio =
    usage.compactionTrigger > 0 ? Math.min(1, usage.compactionTrigger / budget) : null
  return { budget, overBudget, ratio, displayPct, level, overage, compactRatio }
}

function UsageRing({
  ratio,
  size,
  level,
  className,
  children
}: {
  ratio: number
  size: number
  level: UsageLevel
  className?: string
  children?: React.ReactNode
}) {
  const stroke = RING_STROKE
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const clamped = Math.min(1, Math.max(0, ratio))
  const offset = c * (1 - clamped)

  return (
    <span
      className={cn('relative inline-grid shrink-0 place-items-center', className)}
      style={{ width: size, height: size }}
      aria-hidden={children ? undefined : true}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          className="text-surface-2"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          className={cn(levelRing[level], 'vy-transition')}
        />
      </svg>
      {children ? (
        <span className="absolute inset-0 grid place-items-center text-3xs font-semibold tabular-nums leading-none">
          {children}
        </span>
      ) : null}
    </span>
  )
}

function BreakdownRow({
  label,
  tokens,
  total,
  color
}: {
  label: string
  tokens: number
  total: number
  color: string
}) {
  if (tokens <= 0) return null
  return (
    <div className="flex items-center gap-2">
      <span className={cn('size-1.5 shrink-0 rounded-full', color)} aria-hidden />
      <span className="w-14 shrink-0 text-2xs text-secondary">{label}</span>
      <div className="min-w-0 flex-1">
        <div className="h-1 overflow-hidden rounded-full bg-surface-2">
          <div
            className={cn('h-full rounded-full vy-transition', color)}
            style={{ width: `${total > 0 ? Math.min(100, (tokens / total) * 100) : 0}%` }}
          />
        </div>
      </div>
      <span className="w-10 shrink-0 text-right text-2xs tabular-nums text-fg">
        {formatTokens(tokens)}
      </span>
      <span className="w-9 shrink-0 text-right text-2xs tabular-nums text-secondary">
        {formatPct(tokens, total)}
      </span>
    </div>
  )
}

/** Latest-step cache hit share of provider input, or null when unknown. */
export function cacheHitPct(totals: StepUsageTotals): number | null {
  if (totals.cachedInputTokens <= 0 || totals.inputTokens <= 0) return null
  return Math.round((totals.cachedInputTokens / totals.inputTokens) * 100)
}

/** Run-level cache hit share from summed step cache / billed input. */
export function billedCacheHitPct(totals: StepUsageTotals): number | null {
  if (totals.billedCachedInputTokens <= 0 || totals.billedInputTokens <= 0) return null
  return Math.round((totals.billedCachedInputTokens / totals.billedInputTokens) * 100)
}

function RunStat({
  label,
  value,
  tone,
  title
}: {
  label: string
  value: string
  tone?: string
  title?: string
}) {
  return (
    <div
      className="flex min-w-0 flex-col gap-0.5 rounded-lg bg-surface/40 px-2 py-1.5"
      title={title}
    >
      <span className="text-3xs text-secondary">{label}</span>
      <span className={cn('truncate text-xs font-medium tabular-nums', tone ?? 'text-fg')}>
        {value}
      </span>
    </div>
  )
}

function ContextMeterPanel({
  usage,
  onCompact,
  compacting,
  compactDisabled,
  compactMessage,
  compactFailed,
  advisoryHint
}: {
  usage: ContextUsageState
  onCompact?: () => void
  compacting?: boolean
  compactDisabled?: boolean
  compactMessage?: string | null
  compactFailed?: boolean
  advisoryHint?: string | null
}) {
  const { budget, overBudget, ratio, displayPct, level, overage, compactRatio } =
    usageMetrics(usage)
  const contentTotal = usage.layers.system + usage.layers.history + usage.layers.tools
  const headroom = Math.max(0, budget - usage.used)
  const hitPct = cacheHitPct(usage.stepUsage)
  const runHit = billedCacheHitPct(usage.stepUsage)
  const reasoningPct =
    usage.stepUsage.reasoningTokens > 0 && usage.stepUsage.outputTokens > 0
      ? Math.round((usage.stepUsage.reasoningTokens / usage.stepUsage.outputTokens) * 100)
      : null
  const effectiveAdvisoryHint = longRunTipCue(usage, advisoryHint)
  const hasRunStats =
    usage.stepUsage.steps > 0 ||
    usage.stepUsage.billedInputTokens > 0 ||
    usage.stepUsage.outputTokens > 0 ||
    hitPct != null ||
    runHit != null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 px-3.5 pt-3.5 pb-3">
        <div className="flex items-start gap-3">
          <UsageRing ratio={ratio} size={56} level={level}>
            <span className={levelRing[level]}>{displayPct}%</span>
          </UsageRing>
          <div className="min-w-0 flex-1 pt-0.5">
            <p className="m-0 text-sm font-medium text-fg">Context</p>
            <p className="m-0 mt-0.5 text-2xs leading-snug text-secondary">
              Current step {usage.step}
              <span className="text-tertiary"> · </span>
              {formatTokens(usage.window)} model
              {usage.source === 'estimate' ? (
                <span className="text-tertiary"> · estimated</span>
              ) : null}
            </p>
            <p className="m-0 mt-1.5 text-xs tabular-nums text-fg">
              <span className="font-semibold">{formatTokens(usage.used)}</span>
              <span className="text-secondary"> used of </span>
              <span className="font-medium">{formatTokens(budget)}</span>
            </p>
          </div>
        </div>

        <div className="relative mt-3 h-2 overflow-hidden rounded-full bg-surface-2">
          <div
            className={cn('absolute inset-y-0 left-0 rounded-full vy-transition', levelFill[level])}
            style={{ width: `${Math.min(100, displayPct)}%` }}
          />
          {compactRatio != null ? (
            <div
              className="absolute inset-y-0 w-px bg-warning/80"
              style={{ left: `${compactRatio * 100}%` }}
              title={`Auto-compact at ${formatTokens(usage.compactionTrigger)}`}
            />
          ) : null}
        </div>

        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-3xs text-secondary">
          {usage.compactionTrigger > 0 ? (
            <span>Auto-compact at {formatTokens(usage.compactionTrigger)}</span>
          ) : (
            <span />
          )}
          {headroom > 0 ? <span>{formatTokens(headroom)} headroom</span> : null}
        </div>
      </header>

      <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto border-t border-border px-3.5 py-3">
        {overBudget ? (
          <p className="m-0 mb-3 rounded-lg bg-danger/10 px-2.5 py-2 text-3xs leading-snug text-danger" role="alert">
            {usage.overflow
              ? 'Context still exceeds the model window after compaction. Start a new chat if the agent cannot fold further.'
              : `${formatTokens(overage)} over budget — auto-compact will fold at the threshold, or use Compact when the run is stopped.`}
          </p>
        ) : null}

        {effectiveAdvisoryHint ? (
          <p className="m-0 mb-3 rounded-lg bg-warning/10 px-2.5 py-2 text-3xs leading-snug text-warning" role="status">
            {effectiveAdvisoryHint}
          </p>
        ) : null}

        {contentTotal > 0 ? (
          <div className="mb-3 flex flex-col gap-2">
            <p className="m-0 text-3xs font-medium uppercase tracking-[var(--vy-tracking-caps)] text-secondary">
              Breakdown
            </p>
            <BreakdownRow
              label="System"
              tokens={usage.layers.system}
              total={contentTotal}
              color="bg-fg/35"
            />
            <BreakdownRow
              label="History"
              tokens={usage.layers.history}
              total={contentTotal}
              color="bg-fg/70"
            />
            <BreakdownRow
              label="Tools"
              tokens={usage.layers.tools}
              total={contentTotal}
              color="bg-fg"
            />
          </div>
        ) : null}

        {hasRunStats ? (
          <div className="flex flex-col gap-2">
            <p className="m-0 text-3xs font-medium uppercase tracking-[var(--vy-tracking-caps)] text-secondary">
              This run
            </p>
            <div className="grid grid-cols-2 gap-1.5">
              {usage.stepUsage.steps > 0 ? (
                <RunStat
                  label="Completed steps"
                  value={String(usage.stepUsage.steps)}
                  title="Provider calls finished this run"
                />
              ) : null}
              {usage.stepUsage.billedInputTokens > 0 ? (
                <RunStat
                  label="Run input"
                  value={formatTokens(usage.stepUsage.billedInputTokens)}
                  title="Sum of billed input across all completed steps"
                />
              ) : null}
              {usage.stepUsage.peakInputTokens > 0 ? (
                <RunStat
                  label="Largest step"
                  value={formatTokens(usage.stepUsage.peakInputTokens)}
                  title="Peak context size in a single step"
                />
              ) : null}
              {usage.stepUsage.outputTokens > 0 ? (
                <RunStat label="Output" value={formatTokens(usage.stepUsage.outputTokens)} />
              ) : null}
              {hitPct != null ? (
                <RunStat
                  label="Step cache"
                  value={`${hitPct}%`}
                  tone="text-success"
                  title="Cache hit rate on the latest step"
                />
              ) : null}
              {runHit != null ? (
                <RunStat
                  label="Run cache"
                  value={`${runHit}%`}
                  tone="text-success"
                  title="Cache hit rate across all completed steps"
                />
              ) : null}
              {usage.stepUsage.cacheCreationInputTokens > 0 ? (
                <RunStat
                  label="Cache write"
                  value={formatTokens(usage.stepUsage.cacheCreationInputTokens)}
                  tone="text-warning"
                />
              ) : null}
              {usage.stepUsage.reasoningTokens > 0 ? (
                <RunStat
                  label="Reasoning"
                  value={`${formatTokens(usage.stepUsage.reasoningTokens)}${reasoningPct != null ? ` · ${reasoningPct}%` : ''}`}
                  tone={reasoningPct != null && reasoningPct >= 40 ? 'text-warning' : undefined}
                />
              ) : null}
            </div>
            {reasoningPct != null && reasoningPct >= 40 ? (
              <p className="m-0 text-3xs leading-snug text-secondary">
                Reasoning is a large share of output — lower Think effort for simpler work.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {onCompact ? (
        <footer className="shrink-0 border-t border-border p-3">
          <button
            type="button"
            onClick={onCompact}
            disabled={compacting || compactDisabled}
            title={
              compactDisabled
                ? 'Unavailable while the agent is running'
                : compacting
                  ? 'Compacting…'
                  : 'Summarize older history'
            }
            className={cn(
              'flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium vy-transition',
              'bg-surface text-fg hover:bg-surface-2',
              'disabled:cursor-not-allowed disabled:opacity-[var(--vy-disabled-opacity)]'
            )}
          >
            <Icon name="stack" size={14} className="shrink-0 opacity-70" />
            {compacting ? 'Compacting…' : 'Compact history'}
          </button>
          {compactMessage ? (
            <p
              className={cn(
                'm-0 mt-2 text-center text-3xs leading-snug',
                compactFailed ? 'text-danger' : 'text-secondary'
              )}
              role={compactFailed ? 'alert' : 'status'}
            >
              {compactMessage}
            </p>
          ) : null}
        </footer>
      ) : null}
    </div>
  )
}

export function ContextMeter({
  usage,
  modelWindow,
  onCompact,
  compactDisabled = false,
  advisoryHint = null,
  className
}: {
  usage: ContextUsageState | null
  modelWindow?: number | null
  onCompact?: (
    focus?: string
  ) => Promise<{ ok: true; message: string } | { ok: false; message: string }>
  compactDisabled?: boolean
  advisoryHint?: string | null
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const [compactMessage, setCompactMessage] = useState<string | null>(null)
  const [compactFailed, setCompactFailed] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const alignedUsage =
    usage && modelWindow && modelWindow > 0
      ? alignContextUsageToModelWindow(usage, modelWindow)
      : usage
  const { position } = useDropdownMenu({
    open,
    onOpenChange: setOpen,
    triggerRef,
    panelRef,
    placement: 'up',
    align: 'end',
    disabled: !alignedUsage,
    trapFocus: true
  })

  const runCompaction = async (): Promise<void> => {
    if (!onCompact || compacting || compactDisabled) return
    setCompacting(true)
    setCompactMessage(null)
    setCompactFailed(false)
    try {
      const result = await onCompact()
      setCompactMessage(result.message)
      setCompactFailed(!result.ok)
    } finally {
      setCompacting(false)
    }
  }

  // Silent before the first usage report: an em-dash placeholder spends
  // permanent toolbar width on information that does not exist yet.
  if (!alignedUsage || alignedUsage.window <= 0) {
    return null
  }

  const { budget, overBudget, ratio, displayPct, level } = usageMetrics(alignedUsage)
  const estimate = alignedUsage.source === 'estimate'
  const usedLabel = formatTokens(alignedUsage.used)
  const budgetLabel = formatTokens(budget)
  const hitPct = cacheHitPct(alignedUsage.stepUsage)
  const tipCue = longRunTipCue(alignedUsage, advisoryHint)

  const panelLayout =
    open && position
      ? (() => {
          const desired = Math.min(
            PANEL_MAX_PX,
            Math.max(0, (typeof window !== 'undefined' ? window.innerWidth : 1024) - 16)
          )
          const unclampedLeft = position.left - desired
          return clampComposerDropdownPanel({
            position: {
              left: unclampedLeft,
              top: position.top,
              placement: position.placement
            },
            maxWidthPx: PANEL_MAX_PX
          })
        })()
      : null

  return (
    <div className={cn('relative flex h-7 shrink-0 items-center', className)}>
      <button
        ref={triggerRef}
        type="button"
        className={cn(
          'inline-grid size-7 shrink-0 place-items-center rounded-md vy-transition',
          overBudget
            ? cn(levelSoft.danger, levelRing.danger, 'hover:bg-danger/15')
            : 'text-muted hover:bg-surface hover:text-fg',
          open && (overBudget ? 'bg-danger/15' : 'bg-surface text-fg')
        )}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        aria-label={`Context window ${displayPct}% full: ${estimate ? '~' : ''}${usedLabel} of ${budgetLabel}${hitPct != null ? `. ${hitPct}% cached` : ''}.${tipCue ? ' Long-run tip available.' : ''} Open details.`}
        title={`${estimate ? '~' : ''}${usedLabel} / ${budgetLabel} (${displayPct}%)${hitPct != null ? ` · ${hitPct}% cached` : ''}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
      >
        <UsageRing ratio={ratio} size={16} level={level} />
      </button>

      {open && position && panelLayout
        ? createPortal(
            <div
              ref={panelRef}
              id={panelId}
              role="dialog"
              aria-label="Context details"
              className="fixed z-dropdown flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-menu animate-menu-in origin-bottom"
              style={{
                top: position.placement === 'up' ? undefined : position.top,
                bottom:
                  position.placement === 'up'
                    ? window.innerHeight - position.top
                    : undefined,
                left: panelLayout.left,
                width: panelLayout.width,
                maxWidth: panelLayout.width,
                maxHeight: panelLayout.maxHeight
              }}
            >
              <ContextMeterPanel
                usage={alignedUsage}
                onCompact={onCompact ? () => void runCompaction() : undefined}
                compacting={compacting}
                compactDisabled={compactDisabled}
                compactMessage={compactMessage}
                compactFailed={compactFailed}
                advisoryHint={advisoryHint}
              />
            </div>,
            document.body
          )
        : null}
    </div>
  )
}
