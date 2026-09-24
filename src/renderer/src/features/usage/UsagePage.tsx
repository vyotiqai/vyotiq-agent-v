import { useId, useMemo, useState, type ReactNode } from 'react'
import type { HomeActivityResult } from '@shared/ipc'
import { formatUsdCost, runCostDisplay } from '@shared/utils/costDisplay'
import { workspacePathsEqual } from '@shared/workspacePathMatch'
import { Icon } from '@renderer/lib/icons'
import { Button, Menu, ProgressBar, Segmented, cn, type MenuOption } from '@renderer/lib/ui'
import { buildLineSegments } from '@renderer/lib/ui/lineChart'
import { SECTION_LABEL } from '@renderer/lib/utils/layout'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import { stripGoalMarkdown } from '@renderer/app/navigator/runTitle'
import { ProviderLogo } from '@renderer/features/chat/components/composer/ProviderLogo'
import { openRouterSubProvider } from '@renderer/features/chat/components/composer/composerModelUtils'
import {
  activityDayBars,
  activityModelMix,
  activitySpendSeries,
  finishedShare,
  formatCompactCount,
  formatCount,
  weekdayShort
} from '@renderer/features/home/activityView'
import { useHomeActivity, type ActivityWindowDays } from '@renderer/features/home/useHomeActivity'

const ALL = 'all'
const SPEND_W = 300
const SPEND_H = 120

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
  const [windowDays, setWindowDays] = useState<ActivityWindowDays>(7)
  const scoped = scope !== ALL ? openWorkspaces.find((path) => workspacePathsEqual(path, scope)) : undefined
  const paths = useMemo(() => (scoped ? [scoped] : [...openWorkspaces]), [scoped, openWorkspaces])
  const activity = useHomeActivity(paths, windowDays, refreshVersion)
  const data = activity.data

  const scopeOptions: MenuOption[] = [
    { value: ALL, label: 'All workspaces' },
    ...openWorkspaces.map((path) => ({ value: path, label: formatWorkspaceName(path) }))
  ]

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
          bare
          quiet
        />
        <span className="flex-1" />
        <Segmented
          label="Days"
          value={windowDays === 7 ? '7d' : '30d'}
          items={[
            { id: '7d', label: '7 days' },
            { id: '30d', label: '30 days' }
          ]}
          onChange={(id) => setWindowDays(id === '7d' ? 7 : 30)}
        />
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
              title={`No tasks in the last ${windowDays} days`}
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
  windowDays: ActivityWindowDays
  onOpenTask: (workspacePath: string, runId: string) => void
}) {
  const span = data.windowDays ?? windowDays
  const totals = data.totals
  const tokens = totals.billedInputTokens + totals.outputTokens
  const cost = runCostDisplay(totals)
  const finished = finishedShare(data.outcomes)
  const bars = useMemo(() => activityDayBars(data.days, span), [data.days, span])
  const peak = bars.reduce((max, bar) => Math.max(max, bar.runs), 0)

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
      <div className="grid grid-cols-2 divide-border border-y border-border @3xl:grid-cols-4 @3xl:divide-x">
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
          detail={cost ? `${formatUsdCost(cost.cost / totals.runs)} a task` : 'No cost reported'}
          title={cost ? cost.title : 'No provider reported a cost, and none could be estimated'}
        />
        <BigStat
          value={finished ? `${finished.percent}%` : '—'}
          label="Finished"
          detail={endedDetail || (finished ? 'none failed' : 'none ended')}
        />
      </div>

      <div className="mt-8 grid gap-10 @3xl:grid-cols-2">
        <Chart title="Tasks per day" note={`peak ${formatCount(peak)}`}>
          <div role="img" aria-label={`Tasks per day: ${bars.map((bar) => bar.title).join(', ')}`} className="flex h-36 items-end gap-2">
            {bars.map((bar, i) => (
              <div key={bar.date} title={bar.title} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5">
                <span className="font-mono text-caption text-tertiary tnum" aria-hidden="true">
                  {span <= 14 && bar.runs ? bar.runs : ''}
                </span>
                <div
                  className={cn('w-full rounded-sm', i === bars.length - 1 ? 'bg-accent' : bar.runs ? 'bg-border-strong' : 'bg-border')}
                  style={{ height: bar.runs ? `${Math.max(4, (bar.runs / Math.max(1, peak)) * 100)}px` : 2 }}
                />
                <span className="text-caption text-tertiary" aria-hidden="true">
                  {span <= 7 ? weekdayShort(bar.date) : i % 5 === 0 || i === bars.length - 1 ? bar.label : ' '}
                </span>
              </div>
            ))}
          </div>
        </Chart>
        <SpendChart data={data} span={span} />
      </div>

      <div className="mt-10 grid gap-10 @3xl:grid-cols-3">
        <ModelMixChart data={data} />
        <ToolFailuresChart data={data} span={span} />
        <UncheckedChart data={data} span={span} onOpenTask={onOpenTask} />
      </div>
    </>
  )
}

/** Spend per day as an area, or tokens when no cost was reported. Gaps are days nobody reported. */
function SpendChart({ data, span }: { data: HomeActivityResult; span: number }) {
  const [chosen, setChosen] = useState<'cost' | 'tokens' | null>(null)
  const series = useMemo(() => activitySpendSeries(data.days, span), [data.days, span])
  const hasCost = series.some((point) => point.cost != null)
  const metric = chosen ?? (hasCost ? 'cost' : 'tokens')
  const values = series.map((point) => (metric === 'cost' ? point.cost : point.tokens))
  const { segments, total } = buildLineSegments(values, SPEND_W, SPEND_H)
  const totalText = segments.length === 0 ? '—' : metric === 'cost' ? formatUsdCost(total) : formatCompactCount(total)
  const title = metric === 'cost' ? 'Spend per day' : 'Tokens per day'
  const base = SPEND_H - 2

  return (
    <Chart
      title={title}
      note={segments.length === 0 ? undefined : `total ${totalText}`}
      trailing={
        <Segmented
          label="Measure"
          value={metric}
          items={[
            { id: 'cost', label: 'Spend' },
            { id: 'tokens', label: 'Tokens' }
          ]}
          onChange={setChosen}
        />
      }
    >
      {segments.length === 0 ? (
        <p className="flex h-36 items-center justify-center text-xs text-tertiary">
          {metric === 'cost' ? 'No provider reported a cost in these days.' : 'No token usage recorded in these days.'}
        </p>
      ) : (
        <>
          <svg
            viewBox={`0 0 ${SPEND_W} ${SPEND_H}`}
            preserveAspectRatio="none"
            className="h-36 w-full"
            role="img"
            aria-label={`${title}, total ${totalText}`}
          >
            {segments.map((segment, index) => {
              const line = segment.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ')
              const first = segment[0]!
              const last = segment[segment.length - 1]!
              return (
                <g key={index}>
                  <path
                    d={`${line} L${last.x.toFixed(2)} ${base} L${first.x.toFixed(2)} ${base} Z`}
                    fill="var(--vy-accent-soft)"
                  />
                  <path d={line} fill="none" stroke="var(--vy-accent)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
                </g>
              )
            })}
          </svg>
          <div className="mt-1.5 flex text-caption text-tertiary" aria-hidden="true">
            {series.map((point, i) => (
              <span key={point.date} className="min-w-0 flex-1 text-center" title={point.dateLabel}>
                {span <= 7 ? weekdayShort(point.date) : i % 5 === 0 || i === series.length - 1 ? point.label : ''}
              </span>
            ))}
          </div>
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
          <div key={tool.name} className="flex items-baseline gap-2 border-b border-border py-2 text-xs">
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
            const title = (run.goal && stripGoalMarkdown(run.goal)) || 'Untitled task'
            return (
              <button
                key={run.runId}
                type="button"
                title={`Open ${title}`}
                className="flex w-full items-center gap-2 border-b border-border py-2 text-left text-xs vy-transition hover:bg-surface focus-visible:vy-focus-ring"
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
