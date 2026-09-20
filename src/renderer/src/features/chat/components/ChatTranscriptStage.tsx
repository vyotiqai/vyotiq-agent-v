import type { ReactNode } from 'react'
import { InlineInstanceGateBanner } from './InlineInstanceGateBanner'
import { GoalRunBanner } from './GoalRunBanner'
import type { InlineInstanceGate } from '../hooks/useInlineInstanceUi'
import type { RunGoal, RunLoop } from '@shared/ipc'
import { CHAT_COLUMN, CHAT_GUTTER, CHAT_STAGE_INSET } from '@renderer/lib/utils/layout'
import { cn } from '@renderer/lib/ui/cn'

export function ChatTranscriptStage({
  sideRailPad = false,
  pendingGates,
  onOpenInstance,
  goal,
  loop,
  running = false,
  onGoalPause,
  onGoalResume,
  onGoalComplete,
  onGoalActivate,
  onGoalDismiss,
  onStopLoop,
  onStopRun,
  transcript,
  composer
}: {
  sideRailPad?: boolean
  pendingGates: InlineInstanceGate[]
  onOpenInstance: (instanceRunId: string) => void
  goal?: RunGoal | null
  loop?: RunLoop | null
  running?: boolean
  onGoalPause?: () => void | Promise<boolean>
  onGoalResume?: () => void | Promise<boolean>
  onGoalComplete?: () => void | Promise<boolean>
  onGoalActivate?: () => void | Promise<boolean>
  onGoalDismiss?: () => void | Promise<boolean>
  onStopLoop?: () => void | Promise<boolean>
  onStopRun?: () => void
  transcript: ReactNode
  composer?: ReactNode
}) {
  const showGoal = Boolean(goal && goal.status !== 'complete' && onGoalPause && onGoalResume && onGoalComplete)
  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-chat-stage>
      {pendingGates.length > 0 ? (
        <div className={cn('shrink-0 pt-2', sideRailPad ? CHAT_STAGE_INSET : CHAT_GUTTER)}>
          <div className={CHAT_COLUMN}>
            <InlineInstanceGateBanner gates={pendingGates} onOpenInstance={onOpenInstance} />
          </div>
        </div>
      ) : null}
      <div className="relative flex min-h-0 flex-1 flex-col">{transcript}</div>
      {showGoal && goal ? (
        // Attached above the docked composer: same gutter + centered column so it
        // lines up with the input, but keeps its own border plus a small gap
        // (`pb-1.5` vs the composer's `pt-1`) so the two never read as one block.
        <div
          className={cn(
            // Mirror the dock's own gutter bookkeeping so the centered column of
            // the banner matches the composer's even with classic scrollbars.
            'shrink-0 overflow-x-hidden overflow-y-hidden pb-1.5 [scrollbar-gutter:stable]',
            sideRailPad ? CHAT_STAGE_INSET : CHAT_GUTTER
          )}
        >
          <div className={CHAT_COLUMN}>
            <GoalRunBanner
              goal={goal}
              loop={loop ?? null}
              running={running}
              onPause={onGoalPause!}
              onResume={onGoalResume!}
              onComplete={onGoalComplete!}
              onActivate={onGoalActivate}
              onDismiss={onGoalDismiss}
              onStopLoop={onStopLoop ?? (async () => false)}
              onStopRun={onStopRun}
            />
          </div>
        </div>
      ) : null}
      {composer}
    </div>
  )
}
