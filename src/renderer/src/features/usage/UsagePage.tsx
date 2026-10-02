import { useId, useMemo, useState, type ReactNode } from 'react'
import type { HomeActivityResult } from '@shared/ipc'
import { formatUsdCost, windowCostDisplay } from '@shared/utils/costDisplay'
import { workspacePathsEqual } from '@shared/workspacePathMatch'
import { Icon } from '@renderer/lib/icons'
import { Button, Input, Menu, ProgressBar, Segmented, cn, pushToast, type MenuOption } from '@renderer/lib/ui'
import { BORDER_DIVIDER, DIVIDER_FILL, ROW_HOVER, SECTION_LABEL } from '@renderer/lib/utils/layout'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import { UNTITLED_TASK, taskTitleFromGoal } from '@shared/utils/taskTitle'
import { ProviderLogo } from '@renderer/features/chat/components/composer/ProviderLogo'
import { openRouterSubProvider } from '@renderer/features/chat/components/composer/composerModelUtils'
import {
  activityDayBars,
  activityModelMix,
  activitySpendSeries,
  finishedShare,
  keptShare,
  formatCompactCount,
  formatCount,
  weekdayShort
} from '@renderer/features/home/activityView'
import { ACTIVITY_WORKSPACE_CAP, useHomeActivity } from '@renderer/features/home/useHomeActivity'
import {
  FIXED_RANGE_DAYS,
  dayLabel,
  rangeEndDate,
  resolveCustomRange,
  shiftDay,
  todayKey,
  type UsageRangeChoice
} from './usageRange'
import { usageBreakdown, type BreakdownGroup, type BreakdownTask } from './usageBreakdown'

const ALL = 'all'

/**
 * The analytics that used to lead Home, on their own page: what the tasks
 * cost and how they went, over seven or thirty local days, for one
 * workspace or all of them. Every number is read from run receipts and
 * usage ledgers; a measurement nobody reported is a dash, never a zero.
 */
export function UsagePage({
  openWorkspaces,
  onOpenTask,
  refreshVersion = 0
}: {
  openWorkspaces: readonly string[]
  onOpenTask: (workspacePath: string, runId: string) => void
  refreshVersion?: number
}) {
  const [scope, setScope] = useState<string>(ALL)
  const [choice, setChoice] = useState<UsageRangeChoice>('7d')
  // The custom range as typed, and the last valid one, which is what is read.
  const [customFrom, setCustomFrom] = useState(() => shiftDay(todayKey(), -29))
  const [customTo, setCustomTo] = useState(() => todayKey())
  const custom = resolveCustomRange(customFrom, customTo)
  const [lastValid, setLastValid] = useState<{ windowDays: number; endDay?: string }>({ windowDays: 30 })
  const setCustom = (from: string, to: string): void => {
    setCustomFrom(from)
    setCustomTo(to)
    const next = resolveCustomRange(from, to)
    if (next.ok) setLastValid({ windowDays: next.windowDays, ...(next.endDay ? { endDay: next.endDay } : {}) })
  }
  const range = choice === 'custom' ? lastValid : { windowDays: FIXED_RANGE_DAYS[choice] }
  const windowDays = range.windowDays
  const endDay = range.endDay

  const scoped = scope !== ALL ? openWorkspaces.find((path) => workspacePathsEqual(path, scope)) : undefined
  const paths = useMemo(() => (scoped ? [scoped] : [...openWorkspaces]), [scoped, openWorkspaces])
  const activity = useHomeActivity(paths, windowDays, refreshVersion, { endDay, breakdown: true })
  const data = activity.data
  const [exporting, setExporting] = useState(false)

  const scopeOptions: MenuOption[] = [
    { value: ALL, label: 'All workspaces' },
    ...openWorkspaces.map((path) => ({ value: path, label: formatWorkspaceName(path) }))
  ]

  const exportCsv = (): void => {
    const api = window.vyotiq?.usageExportCsv
    if (!api || exporting) return
    setExporting(true)
    void api({
      workspacePaths: [...new Set(paths)].slice(0, ACTIVITY_WORKSPACE_CAP),
      windowDays,
      ...(endDay ? { endDay } : {})
    })
      .then((res) => {
        if (!res.ok) pushToast(`Usage couldn’t be exported: ${res.error}`, 'error')
        else if (res.data.saved) {
          const rows = res.data.rows ?? 0
          pushToast(`Exported ${formatCount(rows)} ${rows === 1 ? 'row' : 'rows'}`, 'success')
        }
      })
      .catch((err: unknown) => pushToast(`Usage couldn’t be exported: ${err instanceof Error ? err.message : String(err)}`, 'error'))
      .finally(() => setExporting(false))
  }

  const emptyTitle =
    choice === 'custom' && endDay
      ? `No tasks from ${dayLabel(shiftDay(endDay, 1 - windowDays))} to ${dayLabel(endDay)}`
      : `No tasks in the last ${windowDays} days`

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-usage>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2">
        <h1 className="sr-only">Usage</h1>
        <Menu
          value={scoped ?? ALL}
          options={scopeOptions}
          onChange={setScope}
          aria-label="Workspaces"
          placement="down"
          size="xs"
          bare
          quiet
        />
        <span className="flex-1" />
        {choice === 'custom' ? (
          <CustomRange
            from={customFrom}
            to={customTo}
            error={custom.ok ? null : custom.error}
            onFrom={(from) => setCustom(from, customTo)}
            onTo={(to) => setCustom(customFrom, to)}
          />
        ) : null}
        <Segmented
          size="xs"
          label="Range"
          value={choice}
          items={[
            { id: '7d', label: '7 days' },
            { id: '30d', label: '30 days' },
            { id: '90d', label: '90 days' },
            { id: 'custom', label: 'Custom' }
          ]}
          onChange={setChoice}
        />
        <Button
          size="xs"
          variant="ghost"
          icon="download"
          disabled={!data || data.totals.runs === 0 || exporting || !window.vyotiq?.usageExportCsv}
          onClick={exportCsv}
        >
          Export CSV
        </Button>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="@container mx-auto w-full max-w-[1040px] px-8 pb-12 pt-6">
          {activity.error ? (
            <Notice
              icon="warning"
              title="Usage couldn’t be read"
              body="The run receipts in these workspaces could not be read. Nothing is lost; try again."
              action={{ label: 'Try again', onClick: activity.refresh }}
            />
          ) : !data ? (
            <p className="py-10 text-center text-xs text-muted">{activity.loading ? 'Reading receipts…' : 'Usage is unavailable.'}</p>
          ) : data.totals.runs === 0 ? (
            <Notice
              icon="chart"
              title={emptyTitle}
              body="Tasks you run show up here with what they cost and how they went."
            />
          ) : (
            <UsageBody data={data} windowDays={windowDays} onOpenTask={onOpenTask} />
          )}
        </div>
      </div>
    </div>
  )
}

function UsageBody({
  data,
  windowDays,
  onOpenTask
}: {
  data: HomeActivityResult
  windowDays: number
  onOpenTask: (workspacePath: string, runId: string) => void
}) {
  const span = data.windowDays ?? windowDays
  const end = useMemo(() => rangeEndDate(data.endDay), [data.endDay])
  const totals = data.totals
  const tokens = totals.billedInputTokens + totals.outputTokens
  const cost = windowCostDisplay(totals)
  const finished = finishedShare(data.outcomes)
  const kept = keptShare(data.changes)

  const previous = totals.previousRuns
  const taskTrend =
    previous != null && previous > 0
      ? (() => {
          const pct = Math.round(((totals.runs - previous) / previous) * 100)
          return pct === 0 ? `same as the ${span} days before` : `${pct > 0 ? '+' : ''}${pct}% vs the ${span} days before`
        })()
      : data.activeDays != null
        ? `on ${data.activeDays} of ${span} days`
        : ''

  const endedDetail = [
    data.outcomes.error ? `${data.outcomes.error} failed` : '',
    data.outcomes.cancelled ? `${data.outcomes.cancelled} stopped` : '',
    data.outcomes.running ? `${data.outcomes.running} running` : ''
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <>
      <div className="grid grid-cols-2 divide-border/60 border-y border-border @3xl:grid-cols-5 @3xl:divide-x">
        <BigStat value={formatCount(totals.runs)} label="Tasks" detail={taskTrend} />
        <BigStat
          value={formatCompactCount(tokens)}
          label="Tokens"
          detail={
            totals.cacheShare != null
              ? `${Math.round(totals.cacheShare * 100)}% from cache`
              : `${formatCompactCount(totals.billedInputTokens)} in · ${formatCompactCount(totals.outputTokens)} out`
          }
          title={`${formatCount(tokens)} input and output tokens · ${formatCompactCount(totals.billedInputTokens)} in · ${formatCompactCount(totals.outputTokens)} out`}
        />
        <BigStat
          value={cost ? cost.text : '—'}
          label="Spend"
          detail={
            cost?.perTask != null
              ? `${formatUsdCost(cost.perTask)} a task${(totals.pricedRuns ?? totals.runs) < totals.runs ? ' with a cost' : ''}`
              : 'No cost reported'
          }
          title={cost ? cost.title : 'No provider reported a cost, and none could be estimated'}
        />
        <BigStat
          value={finished ? `${finished.percent}%` : '—'}
          label="Finished"
          detail={endedDetail || (finished ? 'none failed' : 'none ended')}
        />
        <BigStat
          value={kept ? `${kept.percent}%` : '—'}
          label="Kept"
          detail={kept ? `${formatCount(kept.kept)} of ${formatCount(kept.total)} changed files` : 'No changes reviewed'}
          title="Files the tasks changed that were kept rather than undone. Files still waiting for review are not counted."
        />
      </div>

      <div className="mt-8">
        <ByDayChart data={data} span={span} end={end} />
      </div>

      <div className="mt-10 grid gap-10 @3xl:grid-cols-3">
        <ModelMixChart data={data} />
        <ToolFailuresChart data={data} span={span} />
        <UncheckedChart data={data} span={span} onOpenTask={onOpenTask} />
      </div>

      {data.tasks ? (
        <div className="mt-10">
          <BreakdownChart data={data} onOpenTask={onOpenTask} />
        </div>
      ) : null}
    </>
  )
}

type Measure = 'cost' | 'tokens' | 'tasks'

const MEASURE_TITLE: Record<Measure, string> = {
  cost: 'Spend per day',
  tokens: 'Tokens per day',
  tasks: 'Tasks per day'
}

function measureText(measure: Measure, value: number): string {
  return measure === 'cost' ? formatUsdCost(value) : measure === 'tokens' ? formatCompactCount(value) : formatCount(value)
}

/**
 * One chart by day, with what it measures on a switch: spend, tokens or
 * tasks. It opens on spend when any was reported. A day nobody reported a
 * cost or tokens for is a gap, never a zero, and every bar's tooltip carries
 * all three for its day.
 */
function ByDayChart({ data, span, end }: { data: HomeActivityResult; span: number; end: Date }) {
  const [chosen, setChosen] = useState<Measure | null>(null)
  const series = useMemo(() => activitySpendSeries(data.days, span, end), [data.days, span, end])
  const bars = useMemo(() => activityDayBars(data.days, span, end), [data.days, span, end])
  // Ninety and more bars share the width: a hairline gap, and a dated tick every couple of weeks.
  const gap = span > 60 ? 'gap-px' : span > 10 ? 'gap-1' : 'gap-2'
  const tickEvery = span <= 120 ? 14 : 30
  const hasCost = series.some((point) => point.cost != null)
  const measure = chosen ?? (hasCost ? 'cost' : 'tasks')
  const values = series.map((point, i) =>
    measure === 'cost' ? point.cost : measure === 'tokens' ? point.tokens : (bars[i]?.runs ?? 0)
  )
  const peak = values.reduce<number>((max, value) => Math.max(max, value ?? 0), 0)
  const peakAt = peak > 0 ? values.indexOf(peak) : -1
  const last = values.length - 1
  const reported = values.some((value) => value != null)
  const total = values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
  // Spend is an estimate when any day's is, or when a day ran tasks nobody priced: the true total is higher.
  const costEstimated = series.some((point) => point.estimated || point.unpriced)
  const title = MEASURE_TITLE[measure]
  const note =
    measure === 'tasks'
      ? `peak ${formatCount(peak)}`
      : reported
        ? `total ${measureText(measure, total)}${measure === 'cost' && costEstimated ? ' est.' : ''}`
        : undefined
  const dayTitle = (i: number): string => {
    const point = series[i]!
    const parts = [bars[i]?.title ?? point.dateLabel]
    if (point.tokens != null) parts.push(`${formatCompactCount(point.tokens)} tokens`)
    if (point.cost != null) parts.push(`${formatUsdCost(point.cost)}${point.estimated ? ' est.' : ''}`)
    else if (point.unpriced) parts.push('no cost reported')
    return parts.join(' · ')
  }

  return (
    <Chart
      title={title}
      note={note}
      trailing={
        <Segmented
          label="Measure"
          value={measure}
          items={[
            { id: 'cost', label: 'Spend' },
            { id: 'tokens', label: 'Tokens' },
            { id: 'tasks', label: 'Tasks' }
          ]}
          onChange={setChosen}
        />
      }
    >
      {!reported ? (
        <p className="flex h-36 items-center justify-center text-xs text-tertiary">
          {measure === 'cost' ? 'No provider reported a cost in these days.' : 'No token usage recorded in these days.'}
        </p>
      ) : (
        <>
          <div
            role="img"
            aria-label={`${title}${note ? `, ${note}` : ''}: ${series
              .map((point, i) => {
                const cost = measure === 'cost'
                const value =
                  values[i] != null
                    ? `${measureText(measure, values[i]!)}${cost && point.estimated ? ' est.' : ''}`
                    : cost && point.unpriced
                      ? 'no cost reported'
                      : '—'
                return `${point.dateLabel} ${value}`
              })
              .join(', ')}`}
            className={cn('flex h-36 items-end', gap)}
          >
            {values.map((value, i) => (
              <div
                key={series[i]!.date}
                title={dayTitle(i)}
                className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5"
              >
                <span className="whitespace-nowrap font-mono text-caption text-tertiary tnum" aria-hidden="true">
                  {value && (span <= 7 || i === peakAt || i === last) ? measureText(measure, value) : ''}
                </span>
                {measure === 'cost' && series[i]!.unpriced ? (
                  // Tasks ran and nobody priced them: unknown, drawn apart from a day that spent nothing.
                  <div data-day-bar data-day-unpriced className="h-0 w-full border-t-2 border-dashed border-border" />
                ) : (
                  <div
                    data-day-bar
                    className={cn('w-full rounded-sm', value ? (i === last ? 'bg-accent' : 'bg-border-strong') : DIVIDER_FILL)}
                    style={{ height: value ? `${Math.max(4, (value / Math.max(1, peak)) * 100)}px` : 2 }}
                  />
                )}
              </div>
            ))}
          </div>
          {span <= 31 ? (
            <div className={cn('mt-1.5 flex text-caption text-tertiary', gap)} aria-hidden="true">
              {series.map((point, i) => (
                <span key={point.date} className="min-w-0 flex-1 text-center" title={point.dateLabel}>
                  {span <= 7 ? weekdayShort(point.date) : i % 5 === 0 || i === last ? point.label : '\u00a0'}
                </span>
              ))}
            </div>
          ) : (
            // Too many days for a label each: dated ticks placed under their bar,
            // the first and last held inside the chart's edges.
            <div className="relative mt-1.5 h-4 text-caption text-tertiary" aria-hidden="true">
              {series.map((point, i) =>
                (i % tickEvery === 0 && last - i >= tickEvery / 2) || i === last ? (
                  <span
                    key={point.date}
                    className={cn(
                      'absolute top-0 whitespace-nowrap',
                      i === 0 ? '' : i === last ? '-translate-x-full' : '-translate-x-1/2'
                    )}
                    style={{ left: i === 0 ? 0 : i === last ? '100%' : `${((i + 0.5) / span) * 100}%` }}
                  >
                    {point.dateLabel}
                  </span>
                ) : null
              )}
            </div>
          )}
        </>
      )}
    </Chart>
  )
}

/** Output tokens per model; the three largest by name, the rest folded. */
function ModelMixChart({ data }: { data: HomeActivityResult }) {
  const slices = useMemo(() => activityModelMix(data.days), [data.days])
  const named = slices.slice(0, 3)
  const rest = slices.slice(3)
  const restRatio = rest.reduce((sum, slice) => sum + slice.ratio, 0)
  const rows = [
    ...named.map((slice) => ({ key: slice.model, label: slice.model, ratio: slice.ratio, brand: brandGuess(slice.model) })),
    ...(rest.length > 0 ? [{ key: 'other', label: `Other (${rest.length})`, ratio: restRatio, brand: null }] : [])
  ]
  return (
    <Chart title="Model mix" note="output tokens">
      {rows.length === 0 ? (
        <p className="text-xs text-tertiary">No run recorded which model it used.</p>
      ) : (
        rows.map((row) => (
          <div key={row.key} className="mb-3">
            <div className="flex items-center gap-2 text-xs">
              {row.brand ? <ProviderLogo id={row.brand} size="xs" className="text-muted" /> : <span className="size-3 shrink-0" />}
              <span className="min-w-0 flex-1 truncate font-mono text-caption text-fg" title={row.label}>
                {row.label}
              </span>
              <span className="font-mono text-caption text-muted tnum">{Math.round(row.ratio * 100)}%</span>
            </div>
            <ProgressBar value={row.ratio} className="mt-1.5 w-full" />
          </div>
        ))
      )}
    </Chart>
  )
}

/** Model families and who makes them — only makers the app has a mark for. */
const MODEL_FAMILY_BRAND: ReadonlyArray<readonly [RegExp, string]> = [
  [/^claude/, 'anthropic'],
  [/^(gpt|chatgpt|o[1-9](-|$))/, 'openai'],
  [/^(gemini|gemma)/, 'gemini'],
  [/^llama/, 'meta'],
  [/^(mistral|mixtral|ministral|codestral|devstral|magistral)/, 'mistral'],
  [/^(qwen|qwq)/, 'qwen'],
  [/^grok/, 'xai'],
  [/^deepseek/, 'deepseek'],
  [/^command/, 'cohere'],
  [/^phi-/, 'microsoft'],
  [/^nemotron/, 'nvidia'],
  [/^sonar/, 'perplexity']
]

/**
 * Who makes a model, from its id alone: the vendor prefix of `vendor/model`,
 * else the family its name starts with. An unknown maker keeps its own first
 * word, which the logo draws as a letter.
 */
function brandGuess(model: string): string {
  const vendor = openRouterSubProvider(model)
  if (vendor) return vendor
  const name = model.toLowerCase()
  // Bedrock: `[profile.]vendor.model` — `global.anthropic.claude-sonnet-5-5`.
  const bedrock = /^(?:(?:global|us|eu|apac|jp|au|ca|us-gov)\.)?(anthropic|amazon|meta|mistral|cohere|deepseek|openai|qwen|xai)\./.exec(name)
  if (bedrock) return bedrock[1]!
  return MODEL_FAMILY_BRAND.find(([family]) => family.test(name))?.[1] ?? name.split(/[-_.:/\s]/)[0]!
}

function ToolFailuresChart({ data, span }: { data: HomeActivityResult; span: number }) {
  const failing = data.attention?.failingTools ?? []
  const calls = data.attention?.toolCalls
  return (
    <Chart title="Tool failures" note={calls ? `of ${formatCount(calls)} calls` : undefined}>
      {failing.length === 0 ? (
        <p className="text-xs text-tertiary">No tool failed in these {span} days.</p>
      ) : (
        failing.map((tool) => (
          <div key={tool.name} className="flex items-baseline gap-2 border-b border-border/60 py-2 text-xs">
            <span className="font-mono text-caption text-fg">{tool.name}</span>
            <span className="min-w-0 flex-1 truncate text-tertiary" title={tool.reason}>
              {tool.reason ?? ''}
            </span>
            <span className="font-mono text-caption text-muted tnum">
              {formatCount(tool.failed)} of {formatCount(tool.ok + tool.failed)}
            </span>
          </div>
        ))
      )}
    </Chart>
  )
}

function UncheckedChart({
  data,
  span,
  onOpenTask
}: {
  data: HomeActivityResult
  span: number
  onOpenTask: (workspacePath: string, runId: string) => void
}) {
  const runs = data.attention?.uncheckedRuns ?? []
  return (
    <Chart title="Unchecked" note="edits with no passing check after">
      {runs.length === 0 ? (
        <p className="text-xs text-tertiary">Every edit in these {span} days was checked after.</p>
      ) : (
        <>
          {runs.map((run) => {
            const title = (run.goal && taskTitleFromGoal(run.goal)) || UNTITLED_TASK
            return (
              <button
                key={run.runId}
                type="button"
                title={`Open ${title}`}
                className="flex w-full items-center gap-2 border-b border-border/60 py-2 text-left text-xs vy-transition hover:bg-surface focus-visible:vy-focus-ring"
                onClick={() => onOpenTask(run.workspacePath, run.runId)}
              >
                <Icon name="warningCircle" size={13} className="shrink-0 text-warning" />
                <span className="min-w-0 flex-1 truncate text-fg">{title}</span>
                <span className="shrink-0 text-tertiary">
                  {run.files} {run.files === 1 ? 'file' : 'files'}
                </span>
              </button>
            )
          })}
          <p className="mt-2 text-xs text-tertiary">Worth a test run before you commit.</p>
        </>
      )}
    </Chart>
  )
}

/** Tasks listed under a workspace before the rest fold behind "Show more". */
const TASKS_PER_GROUP = 8

/** Task · Model · Tokens · Spend — one grid for the header, the anchors and the rows. */
const BREAKDOWN_COLUMNS = 'grid grid-cols-[minmax(0,1fr)_minmax(0,9rem)_4.5rem_5.5rem] items-center gap-3'

function costText(cost: number | null, estimated: boolean): ReactNode {
  if (cost == null) {
    return (
      <span className="text-tertiary" title="No cost reported">
        —
      </span>
    )
  }
  return (
    <>
      {formatUsdCost(cost)}
      {estimated ? <span className="text-tertiary"> est.</span> : null}
    </>
  )
}

function tokensTitle(entry: { billedInputTokens?: number; outputTokens?: number; cachedInputTokens?: number; tokens: number }): string {
  const parts = [`${formatCount(entry.tokens)} tokens`]
  if (entry.billedInputTokens != null && entry.outputTokens != null) {
    parts.push(`${formatCompactCount(entry.billedInputTokens)} in · ${formatCompactCount(entry.outputTokens)} out`)
  }
  if (entry.cachedInputTokens) parts.push(`${formatCompactCount(entry.cachedInputTokens)} from cache`)
  return parts.join(' · ')
}

/**
 * Where the range's spend went: each workspace as an anchor row with its
 * share of the whole, and under it its tasks, costliest first. A task opens
 * on click. Spend is the measure when anything reported one, else tokens.
 */
function BreakdownChart({
  data,
  onOpenTask
}: {
  data: HomeActivityResult
  onOpenTask: (workspacePath: string, runId: string) => void
}) {
  const breakdown = useMemo(() => usageBreakdown(data), [data])
  if (breakdown.groups.length === 0) return null
  return (
    <Chart title="Where it went" note={breakdown.measure === 'cost' ? 'spend by workspace and task' : 'tokens by workspace and task'}>
      <div className={cn(BREAKDOWN_COLUMNS, 'border-b pb-1.5 text-caption text-tertiary', BORDER_DIVIDER)} aria-hidden="true">
        <span>Task</span>
        <span>Model</span>
        <span className="text-right">Tokens</span>
        <span className="text-right">Spend</span>
      </div>
      {breakdown.groups.map((group) => (
        <BreakdownGroupRows key={group.path} group={group} measure={breakdown.measure} onOpenTask={onOpenTask} />
      ))}
      {breakdown.omitted > 0 ? (
        <p className="mt-3 text-xs text-tertiary">
          {formatCount(breakdown.omitted)} smaller {breakdown.omitted === 1 ? 'task is' : 'tasks are'} not listed; Export CSV has every one.
        </p>
      ) : null}
    </Chart>
  )
}

function BreakdownGroupRows({
  group,
  measure,
  onOpenTask
}: {
  group: BreakdownGroup
  measure: 'cost' | 'tokens'
  onOpenTask: (workspacePath: string, runId: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const name = formatWorkspaceName(group.path)
  const shown = expanded ? group.tasks : group.tasks.slice(0, TASKS_PER_GROUP)
  const folded = group.tasks.length - shown.length
  return (
    <div role="group" aria-label={name} data-usage-workspace={group.path} className="mt-4">
      <div className={cn(BREAKDOWN_COLUMNS, 'py-1.5')}>
        <span className="flex min-w-0 items-center gap-2">
          <Icon name="workspace" size={13} className="shrink-0 text-muted" />
          <span className="truncate text-sm font-medium text-fg-strong" title={group.path}>
            {name}
          </span>
          <span className="shrink-0 text-xs text-tertiary">
            {formatCount(group.runs)} {group.runs === 1 ? 'task' : 'tasks'}
          </span>
        </span>
        <span />
        <span className="text-right font-mono text-caption text-muted tnum" title={tokensTitle(group)}>
          {formatCompactCount(group.tokens)}
        </span>
        <span className="text-right font-mono text-caption text-fg tnum">{costText(group.cost, group.estimated)}</span>
      </div>
      <ProgressBar
        value={group.share}
        className="mb-1 w-full"
        label={`${name}: share of ${measure === 'cost' ? 'spend' : 'tokens'}`}
      />
      {shown.map((task) => (
        <BreakdownTaskRow key={task.runId} task={task} onOpenTask={onOpenTask} />
      ))}
      {folded > 0 ? (
        <button
          type="button"
          className={cn('w-full rounded-sm py-1.5 pl-[21px] text-left text-xs text-muted vy-transition focus-visible:vy-focus-ring', ROW_HOVER)}
          onClick={() => setExpanded(true)}
        >
          Show {formatCount(folded)} more
        </button>
      ) : null}
    </div>
  )
}

function BreakdownTaskRow({
  task,
  onOpenTask
}: {
  task: BreakdownTask
  onOpenTask: (workspacePath: string, runId: string) => void
}) {
  const title = (task.goal && taskTitleFromGoal(task.goal)) || UNTITLED_TASK
  return (
    <button
      type="button"
      data-usage-task={task.runId}
      title={`Open ${title}`}
      className={cn(BREAKDOWN_COLUMNS, 'w-full border-b py-1.5 text-left text-xs vy-transition focus-visible:vy-focus-ring', BORDER_DIVIDER, ROW_HOVER)}
      onClick={() => onOpenTask(task.workspacePath, task.runId)}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="w-[13px] shrink-0" aria-hidden="true" />
        <span className="truncate text-fg">{title}</span>
      </span>
      <span className="truncate font-mono text-caption text-tertiary">{task.model ?? ''}</span>
      <span className="text-right font-mono text-caption text-muted tnum" title={tokensTitle(task)}>
        {formatCompactCount(task.tokens)}
      </span>
      <span className="text-right font-mono text-caption text-fg tnum">{costText(task.cost, task.estimated)}</span>
    </button>
  )
}

/** Two dates for a custom range, with why a pair can't be read. */
function CustomRange({
  from,
  to,
  error,
  onFrom,
  onTo
}: {
  from: string
  to: string
  error: string | null
  onFrom: (value: string) => void
  onTo: (value: string) => void
}) {
  const today = todayKey()
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {error ? (
        <span role="alert" className="truncate text-xs text-danger">
          {error}
        </span>
      ) : null}
      <div className="w-[8.5rem] shrink-0">
        <Input
          type="date"
          size="sm"
          aria-label="From"
          value={from}
          max={to && to < today ? to : today}
          aria-invalid={error ? true : undefined}
          onChange={(e) => onFrom(e.target.value)}
        />
      </div>
      <span className="text-xs text-tertiary" aria-hidden="true">
        –
      </span>
      <div className="w-[8.5rem] shrink-0">
        <Input
          type="date"
          size="sm"
          aria-label="To"
          value={to}
          min={from || undefined}
          max={today}
          aria-invalid={error ? true : undefined}
          onChange={(e) => onTo(e.target.value)}
        />
      </div>
    </div>
  )
}

function BigStat({ value, label, detail, title }: { value: string; label: string; detail: string; title?: string }) {
  return (
    <div className="px-5 py-4 first:pl-0" title={title}>
      <div className="text-caption text-tertiary">{label}</div>
      <div className="mt-0.5 font-mono text-display font-medium text-fg-strong tnum">{value}</div>
      <div className="truncate text-xs text-muted">{detail}</div>
    </div>
  )
}

function Chart({ title, note, trailing, children }: { title: string; note?: string; trailing?: ReactNode; children: ReactNode }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="min-w-0">
      <div className="mb-3 flex items-baseline gap-2">
        <h2 id={id} className={SECTION_LABEL}>
          {title}
        </h2>
        {note ? <span className="text-xs text-tertiary">{note}</span> : null}
        {trailing ? <span className="ml-auto self-center">{trailing}</span> : null}
      </div>
      {children}
    </section>
  )
}

function Notice({
  icon,
  title,
  body,
  action
}: {
  icon: 'chart' | 'warning'
  title: string
  body: string
  action?: { label: string; onClick: () => void }
}) {
  return (
    <div className="flex flex-col items-center justify-center px-8 py-16 text-center">
      <span
        className={cn(
          'grid size-10 place-items-center rounded-lg',
          icon === 'warning' ? 'bg-danger-soft text-danger' : 'bg-surface text-muted'
        )}
      >
        <Icon name={icon} size={18} />
      </span>
      <div className="mt-3 text-sm font-medium text-fg-strong">{title}</div>
      <p className="mt-1 max-w-[320px] text-xs leading-[18px] text-muted">{body}</p>
      {action ? (
        <Button size="sm" variant="primary" className="mt-3" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  )
}
