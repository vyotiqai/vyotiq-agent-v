import { useEffect, useState } from 'react'
import type { RunGoal, RunLoop } from '@shared/ipc'
import { Button, Tooltip, cn } from '@renderer/lib/ui'
import { Icon } from '@renderer/lib/icons'
import { formatLoopInterval } from '@shared/goalRuntime'

function nextTickLabel(loop: RunLoop, now: number): string {
  const target = Date.parse(loop.nextAt)
  if (!Number.isFinite(target)) return formatLoopInterval(loop.intervalMs)
  const remain = Math.max(0, target - now)
  if (remain < 1000) return 'now'
  return `in ${formatLoopInterval(remain < 30_000 ? Math.max(1000, remain) : remain)}`
}

export function GoalRunBanner({
  goal,
  loop,
  running,
  onPause,
  onResume,
  onComplete,
  onStopLoop,
  onStopRun
}: {
  goal: RunGoal | null
  loop: RunLoop | null
  running: boolean
  onPause: () => void | Promise<boolean>
  onResume: () => void | Promise<boolean>
  onComplete: () => void | Promise<boolean>
  onStopLoop: () => void | Promise<boolean>
  onStopRun?: () => void
}) {
  const [now, setNow] = useState(() => Date.now())
  const armed = loop?.status === 'armed'
  useEffect(() => {
    if (!armed) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [armed])

  if (!goal || goal.status === 'complete') return null

  const paused = goal.status === 'paused'
  return (
    <div
      data-goal-banner=""
      data-goal-status={goal.status}
      role="region"
      aria-label={paused ? 'Goal paused' : 'Active goal'}
      className={cn(
        'flex items-center gap-2 rounded-md border px-2 py-1',
        paused ? 'border-border bg-surface' : 'border-accent/30 bg-accent/5'
      )}
    >
      <Icon
        name="flag"
        size={13}
        className={cn('shrink-0', paused ? 'text-muted' : 'text-accent')}
        aria-hidden
      />
      <Tooltip content={goal.objective}>
        <span className="min-w-0 flex-1 truncate text-xs text-fg [overflow-wrap:anywhere]">
          {goal.objective}
        </span>
      </Tooltip>
      {armed && loop ? (
        <span className="hidden shrink-0 text-[11px] text-muted sm:inline">
          Loop {formatLoopInterval(loop.intervalMs)} · {nextTickLabel(loop, now)}
        </span>
      ) : null}
      <div className="flex shrink-0 items-center gap-1">
        {paused ? (
          <Button type="button" variant="subtle" onClick={() => void onResume()}>
            Resume
          </Button>
        ) : (
          <Button
            type="button"
            variant="subtle"
            onClick={() => {
              // Always pause the goal via the dedicated, idempotent IPC path.
              // Stopping the live run is a secondary action so the goal is paused
              // even if `running` is stale or onStopRun is a no-op.
              void onPause()
              if (running) void onStopRun?.()
            }}
          >
            Pause
          </Button>
        )}
        <Button type="button" variant="subtle" onClick={() => void onComplete()}>
          Mark complete
        </Button>
        {armed ? (
          <Button type="button" variant="ghost" onClick={() => void onStopLoop()}>
            Stop loop
          </Button>
        ) : null}
      </div>
    </div>
  )
}
