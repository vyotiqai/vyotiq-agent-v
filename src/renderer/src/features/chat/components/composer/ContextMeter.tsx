import { useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Alert } from '@renderer/lib/ui/Alert'
import { Button } from '@renderer/lib/ui/Button'
import { cn } from '@renderer/lib/ui/cn'
import { MENU_SURFACE } from '@renderer/lib/ui/menuStyles'
import { useDropdownMenu } from '@renderer/lib/hooks/useDropdownMenu'
import { formatTokens } from '@renderer/lib/utils/formatTokens'
import { BORDER_DIVIDER, DIVIDER_FILL, NUM, ROW_HOVER, SECTION_LABEL } from '@renderer/lib/utils/layout'
import type { ContextToolGroupDetail, ContextUsageState } from '@shared/utils/contextUsage'
import type { StepUsageTotals } from '@shared/utils/runTelemetry'
import {
  LONG_RUN_BILLED_INPUT_HINT_THRESHOLD,
  LONG_RUN_STEP_HINT_THRESHOLD
} from '@shared/utils/tokenCost'
import { formatBilledUsd, turnCost } from '../../utils/messageFooterStats'
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

function formatPct(n: number, total: number): string {
  if (total <= 0) return '0%'
  const pct = (n / total) * 100
  if (pct > 0 && pct < 1) return `${pct.toFixed(1)}%`
  if (pct >= 10) return `${Math.round(pct)}%`
  return `${pct.toFixed(1)}%`
}

/** Ratio, percent and level for a usage snapshot — one source for every ring. */
export function usageMetrics(usage: ContextUsageState) {
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
          // The full circle must read as a track: on surface-2 it vanished
          // into the composer and the lone round-capped arc looked like a
          // loading spinner next to Stop.
          className="text-border"
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
        <span className="absolute inset-0 grid place-items-center text-caption font-semibold tnum leading-none">
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
  color,
  pctOverride,
  muted,
  onToggle,
  expanded
}: {
  label: string
  tokens: number
  total: number
  color: string
  /** Rendered in the % column instead of the computed share; null renders an em dash. */
  pctOverride?: string | null
  /** Dimmed informational row (e.g. deferred tools) — no bar, muted text. */
  muted?: boolean
  /** When set, the row is an expandable disclosure toggling its children. */
  onToggle?: () => void
  expanded?: boolean
}) {
  if (tokens <= 0 && !onToggle) return null
  const pct =
    pctOverride !== undefined
      ? pctOverride === null
        ? '—'
        : pctOverride
      : formatPct(tokens, total)
  const row = (
    <>
      <span className={cn('size-1.5 shrink-0 rounded-full', color)} aria-hidden />
      <span
        className={cn(
          'w-24 shrink-0 truncate text-caption',
          muted ? 'text-tertiary' : 'text-secondary'
        )}
        title={label}
      >
        {label}
      </span>
      {muted ? (
        <span className="min-w-0 flex-1" aria-hidden />
      ) : (
        <div className="min-w-0 flex-1">
          <div className={cn('h-1 overflow-hidden rounded-full', DIVIDER_FILL)}>
            <div
              className={cn('h-full rounded-full vy-transition', color)}
              style={{ width: `${total > 0 ? Math.min(100, (tokens / total) * 100) : 0}%` }}
            />
          </div>
        </div>
      )}
      <span
        className={cn(
          'w-10 shrink-0 text-right',
          NUM,
          muted ? 'text-tertiary' : 'text-fg'
        )}
      >
        {formatTokens(tokens)}
      </span>
      <span
        className={cn(
          'w-9 shrink-0 text-right',
          NUM,
          muted ? 'text-tertiary' : 'text-secondary'
        )}
      >
        {pct}
      </span>
    </>
  )
  if (!onToggle) {
    return <div className="flex items-center gap-2">{row}</div>
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className={cn('flex w-full items-center gap-2 rounded-sm text-left vy-transition focus-visible:vy-focus-ring', ROW_HOVER)}
    >
      {row}
    </button>
  )
}

/** Indented per-server rows under the expandable MCP tools row. */
function McpServerRows({ groups }: { groups: ContextToolGroupDetail[] }) {
  return (
    <>
      {groups.map((group) => (
        <div key={group.serverId} className="flex items-center gap-2 pl-3.5">
          <span className="w-1.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-caption text-tertiary" title={group.serverId}>
            {group.serverId}
          </span>
          <span className={cn('shrink-0 text-tertiary', NUM)}>
            {group.toolCount} {group.toolCount === 1 ? 'tool' : 'tools'}
          </span>
          <span className={cn('w-10 shrink-0 text-right text-secondary', NUM)}>
            {formatTokens(group.tokens)}
          </span>
          <span className="w-9 shrink-0" aria-hidden />
        </div>
      ))}
    </>
  )
}

/**
 * Full context breakdown (Record / System tools / MCP tools / System prompt /
 * Skills / Autocompact buffer / Free space + deferred tools), falling back to
 * the legacy 3-layer split when the run predates `detail` events. Categories
 * take the accent (the record) and then a grey ramp by weight — never a status
 * hue, which would read as a warning or a pass.
 */
function BreakdownRows({ usage }: { usage: ContextUsageState }) {
  const [mcpOpen, setMcpOpen] = useState(false)
  const [deferredMcpOpen, setDeferredMcpOpen] = useState(false)
  const detail = usage.detail
  if (!detail) {
    const contentTotal = usage.layers.system + usage.layers.history + usage.layers.tools
    return (
      <>
        <BreakdownRow
          label="System"
          tokens={usage.layers.system}
          total={contentTotal}
          color="bg-tertiary"
        />
        <BreakdownRow
          label="History"
          tokens={usage.layers.history}
          total={contentTotal}
          color="bg-secondary"
        />
        <BreakdownRow
          label="Tools"
          tokens={usage.layers.tools}
          total={contentTotal}
          color="bg-fg"
        />
      </>
    )
  }
  const base = usage.window
  const hasMcpServers = detail.tools.mcpByServer.length > 0
  const deferredMcpServers = detail.tools.deferredMcpByServer ?? []
  return (
    <>
      <BreakdownRow
        label="Record"
        tokens={usage.layers.history}
        total={base}
        color="bg-accent"
      />
      <BreakdownRow
        label="System tools"
        tokens={detail.tools.builtin.tokens}
        total={base}
        color="bg-fg"
      />
      <BreakdownRow
        label="MCP tools"
        tokens={detail.tools.mcp.tokens}
        total={base}
        color="bg-secondary"
        onToggle={hasMcpServers ? () => setMcpOpen((v) => !v) : undefined}
        expanded={hasMcpServers ? mcpOpen : undefined}
      />
      {mcpOpen && hasMcpServers ? <McpServerRows groups={detail.tools.mcpByServer} /> : null}
      <BreakdownRow
        label="System prompt"
        tokens={detail.systemPrompt}
        total={base}
        color="bg-muted"
      />
      <BreakdownRow label="Skills" tokens={detail.skills} total={base} color="bg-tertiary" />
      <BreakdownRow
        label="Autocompact buffer"
        tokens={detail.autocompactBuffer}
        total={base}
        color="bg-border-strong"
      />
      <BreakdownRow label="Free space" tokens={detail.free} total={base} color={DIVIDER_FILL} />
      <BreakdownRow
        label="Deferred sys tools"
        tokens={detail.tools.deferredBuiltin.tokens}
        total={base}
        color={DIVIDER_FILL}
        muted
        pctOverride={null}
      />
      <BreakdownRow
        label="Deferred MCP tools"
        tokens={detail.tools.deferredMcp.tokens}
        total={base}
        color={DIVIDER_FILL}
        muted
        pctOverride={null}
        onToggle={
          deferredMcpServers.length > 0 ? () => setDeferredMcpOpen((v) => !v) : undefined
        }
        expanded={deferredMcpServers.length > 0 ? deferredMcpOpen : undefined}
      />
      {deferredMcpOpen && deferredMcpServers.length > 0 ? (
        <McpServerRows groups={deferredMcpServers} />
      ) : null}
    </>
  )
}

/**
 * The meter's words: how full the context is, of what, how much was cached,
 * and whether a long-run tip waits inside. Shared by every place the meter
 * opens from, so screen readers hear the same reading wherever it is.
 */
export function contextMeterLabels(
  usage: ContextUsageState,
  advisoryHint: string | null
): { aria: string; title: string } {
  const { budget, displayPct } = usageMetrics(usage)
  const estimate = usage.source === 'estimate' ? '~' : ''
  const used = formatTokens(usage.used)
  const of = formatTokens(budget)
  const hit = cacheHitPct(usage.stepUsage)
  const tip = longRunTipCue(usage, advisoryHint)
  return {
    aria: `Context window ${displayPct}% full: ${estimate}${used} of ${of}${hit != null ? `. ${hit}% cached` : ''}.${tip ? ' Long-run tip available.' : ''} Open details.`,
    title: `${estimate}${used} / ${of} (${displayPct}%)${hit != null ? ` · ${hit}% cached` : ''}`
  }
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
    <div className="flex h-6 min-w-0 items-center justify-between gap-2" title={title}>
      <dt className="truncate text-caption text-secondary">{label}</dt>
      <dd className={cn('m-0 shrink-0 truncate', NUM, tone ?? 'text-fg')}>{value}</dd>
    </div>
  )
}

export function ContextMeterPanel({
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
  const runCost = turnCost(usage.stepUsage)
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
      <header className="shrink-0 p-3">
        <div className="flex items-start gap-3">
          <UsageRing ratio={ratio} size={56} level={level}>
            <span className={levelRing[level]}>{displayPct}%</span>
          </UsageRing>
          <div className="min-w-0 flex-1 pt-0.5">
            <p className="m-0 text-sm font-medium text-fg">Context</p>
            <p className="m-0 mt-0.5 text-caption text-secondary">
              Current step {usage.step}
              <span className="text-tertiary"> · </span>
              {formatTokens(usage.window)} model
              {usage.source === 'estimate' ? (
                <span className="text-tertiary"> · estimated</span>
              ) : null}
            </p>
            <p className="m-0 mt-1.5 text-caption text-fg">
              <span className={NUM}>{formatTokens(usage.used)}</span>
              <span className="text-secondary"> used of </span>
              <span className={NUM}>{formatTokens(budget)}</span>
            </p>
          </div>
        </div>

        <div className={cn('relative mt-3 h-2 overflow-hidden rounded-full', DIVIDER_FILL)}>
          <div
            className={cn('absolute inset-y-0 left-0 rounded-full vy-transition', levelFill[level])}
            style={{ width: `${Math.min(100, displayPct)}%` }}
          />
          {compactRatio != null ? (
            <div
              className="absolute inset-y-0 w-px bg-warning"
              style={{ left: `${compactRatio * 100}%` }}
              title={`Auto-compact at ${formatTokens(usage.compactionTrigger)}`}
            />
          ) : null}
        </div>

        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-caption text-secondary">
          {usage.compactionTrigger > 0 ? (
            <span>Auto-compact at {formatTokens(usage.compactionTrigger)}</span>
          ) : (
            <span />
          )}
          {headroom > 0 ? <span>{formatTokens(headroom)} headroom</span> : null}
        </div>
      </header>

      <div className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain border-t p-3 scroll-thin', BORDER_DIVIDER)}>
        {overBudget ? (
          <Alert className="mb-3">
            {usage.overflow
              ? 'Context still exceeds the model window after compaction. Start a new task if the agent cannot fold further.'
              : `${formatTokens(overage)} over budget — auto-compact will fold at the threshold, or use Compact when the run is stopped.`}
          </Alert>
        ) : null}

        {effectiveAdvisoryHint ? (
          <Alert variant="info" className="mb-3">
            {effectiveAdvisoryHint}
          </Alert>
        ) : null}

        {contentTotal > 0 ? (
          <div className="mb-3 flex flex-col gap-2">
            <p className={cn('m-0', SECTION_LABEL)}>Breakdown</p>
            <BreakdownRows usage={usage} />
          </div>
        ) : null}

        {hasRunStats ? (
          <div className="flex flex-col gap-1">
            <p className={cn('m-0', SECTION_LABEL)}>This run</p>
            <dl className="m-0 flex flex-col">
              {usage.stepUsage.steps > 0 ? (
                <RunStat
                  label="Completed steps"
                  value={String(usage.stepUsage.steps)}
                  title="Provider calls finished this run"
                />
              ) : null}
              {runCost != null ? (
                <RunStat
                  label="Run cost"
                  value={`${formatBilledUsd(runCost.cost)}${runCost.estimated ? ' est.' : ''}`}
                  tone={runCost.estimated ? 'text-secondary' : undefined}
                  title={
                    runCost.estimated
                      ? 'Estimated from published model rates — not a provider bill'
                      : 'Provider-reported cost for this run'
                  }
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
            </dl>
            {reasoningPct != null && reasoningPct >= 40 ? (
              <p className="m-0 text-caption text-secondary">
                Reasoning is a large share of output — lower Think effort for simpler work.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {onCompact ? (
        <footer className={cn('shrink-0 border-t p-3', BORDER_DIVIDER)}>
          <Button
            size="sm"
            variant="secondary"
            icon="stack"
            className="w-full"
            onClick={onCompact}
            disabled={compactDisabled}
            pending={compacting}
            title={
              compactDisabled
                ? 'Unavailable while the agent is running'
                : compacting
                  ? 'Compacting…'
                  : 'Summarise older history'
            }
          >
            {compacting ? 'Compacting…' : 'Compact history'}
          </Button>
          {compactMessage ? (
            <p
              className={cn(
                'm-0 mt-2 text-center text-caption',
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

/**
 * A ring that opens the read-only context panel — the agent instance pane's
 * header meter. The task pane's meter, with Compact, lives in TaskOptions.
 */
export function ContextMeter({ usage }: { usage: ContextUsageState | null }) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const { position } = useDropdownMenu({
    open,
    onOpenChange: setOpen,
    triggerRef,
    panelRef,
    placement: 'up',
    align: 'end',
    disabled: !usage,
    trapFocus: true
  })

  // Silent before the first usage report: an em-dash placeholder spends
  // permanent header width on information that does not exist yet.
  if (!usage || usage.window <= 0) {
    return null
  }

  const { overBudget, ratio, level } = usageMetrics(usage)
  const labels = contextMeterLabels(usage, null)

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
    <div className="relative flex h-7 shrink-0 items-center">
      <button
        ref={triggerRef}
        type="button"
        className={cn(
          'inline-grid size-7 shrink-0 place-items-center rounded-md vy-transition focus-visible:vy-focus-ring',
          // One state's classes at a time: appended, the open state's text-fg lost to text-muted.
          overBudget
            ? cn('bg-danger-soft', levelRing.danger)
            : open
              ? 'bg-surface text-fg'
              : 'text-muted hover:bg-surface hover:text-fg'
        )}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        aria-label={labels.aria}
        title={labels.title}
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
              className={cn('fixed flex flex-col origin-bottom', MENU_SURFACE)}
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
              <ContextMeterPanel usage={usage} />
            </div>,
            document.body
          )
        : null}
    </div>
  )
}
