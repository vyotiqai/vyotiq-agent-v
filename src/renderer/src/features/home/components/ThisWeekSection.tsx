import { useMemo } from 'react'
import type { HomeActivityResult } from '@shared/ipc'
import { runCostDisplay } from '@shared/utils/costDisplay'
import { Sparkbars } from '@renderer/lib/ui'
import { activityDayBars, finishedShare, formatCompactCount, formatCount, weekdayShort } from '../activityView'
import { HomeLink, HomeSection } from './HomeBlocks'

/**
 * The last seven days in four numbers and a bar per day, read from run
 * receipts and usage ledgers. The full picture — thirty days, spend, models,
 * failing tools — is on Usage.
 */
export function ThisWeekSection({
  data,
  loading,
  error,
  onRetry,
  onOpenUsage
}: {
  data: HomeActivityResult | null
  loading: boolean
  error: string | null
  onRetry: () => void
  onOpenUsage: () => void
}) {
  const bars = useMemo(() => (data ? activityDayBars(data.days, 7) : []), [data])
  const trailing = <HomeLink onClick={onOpenUsage}>Usage</HomeLink>

  if (error || !data) {
    return (
      <HomeSection id="home-this-week" label="This week" trailing={trailing}>
        <li className="pt-3 text-xs text-muted">
          {error ? (
            <>
              Couldn’t read this week’s receipts.{' '}
              <button
                type="button"
                className="rounded-sm underline underline-offset-2 vy-transition hover:text-fg focus-visible:vy-focus-ring"
                onClick={onRetry}
              >
                Retry
              </button>
            </>
          ) : loading ? (
            'Reading receipts…'
          ) : (
            'Usage is unavailable.'
          )}
        </li>
      </HomeSection>
    )
  }

  const totals = data.totals
  const tokens = totals.billedInputTokens + totals.outputTokens
  const cost = runCostDisplay(totals)
  const finished = finishedShare(data.outcomes)
  const perDay = bars.map((bar) => bar.runs)

  return (
    <HomeSection id="home-this-week" label="This week" trailing={trailing}>
      <li className="pt-3">
        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          <Stat value={formatCount(totals.runs)} label="tasks" />
          <Stat
            value={cost ? cost.text : '—'}
            label="spent"
            title={cost ? cost.title : 'No provider reported a cost, and none could be estimated'}
          />
          <Stat value={formatCompactCount(tokens)} label="tokens" title={`${formatCount(tokens)} input and output tokens`} />
          <Stat
            value={finished ? `${finished.percent}%` : '—'}
            label="finished"
            title={finished ? `${finished.done} of ${finished.ended} tasks that ended finished` : 'No task has ended this week'}
          />
        </div>
        <div role="img" aria-label={`Tasks per day: ${bars.map((bar) => `${bar.title}`).join(', ')}`}>
          <Sparkbars values={perDay} className="mt-4" />
          <div className="mt-1 flex justify-between font-mono text-2xs text-tertiary" aria-hidden="true">
            {bars.map((bar) => (
              <span key={bar.date} className="w-full text-center">
                {weekdayShort(bar.date)}
              </span>
            ))}
          </div>
        </div>
      </li>
    </HomeSection>
  )
}

function Stat({ value, label, title }: { value: string; label: string; title?: string }) {
  return (
    <div title={title}>
      <div className="font-mono text-heading font-medium text-fg-strong tnum">{value}</div>
      <div className="text-caption text-tertiary">{label}</div>
    </div>
  )
}
