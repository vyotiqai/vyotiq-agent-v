import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { runCostDisplay } from '@shared/utils/costDisplay'
import { relativeTimeAgo } from '@shared/utils/timeFormat'
import { Icon } from '@renderer/lib/icons'
import { MENU_SURFACE, StatusGlyph, cn, type TaskState } from '@renderer/lib/ui'
import { planSegmentFill } from '@renderer/features/task/record/RecordLayout'
import type { NavRow } from './navigatorModel'

const VIEWPORT_PAD = 8
/** From the navigator's edge to the card. */
const GAP = 8

/** Where the card goes: beside the navigator, level with the row. */
export type TaskHoverCardAnchor = { top: number; left: number }

export function hoverCardAnchor(rowEl: HTMLElement): TaskHoverCardAnchor {
  const row = rowEl.getBoundingClientRect()
  const nav = rowEl.closest('nav')?.getBoundingClientRect()
  return { top: row.top - 4, left: (nav?.right ?? row.right) + GAP }
}

/**
 * What a task is, without opening it: beside the navigator, level with the
 * row the pointer rests on. Every line is one the task actually has — a branch
 * only for a worktree, the plan only while it works on one, changes only while
 * edits wait on review, checks then and while it works, a cost only once one
 * was measured. Pointer
 * only and hidden from assistive tech: the row's description already says the
 * same.
 */
export function TaskHoverCard({ row, anchor }: { row: NavRow; anchor: TaskHoverCardAnchor }) {
  const ref = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState(anchor.top)

  // Keep the whole card on screen: a row near the bottom lifts it.
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect()
    if (!box) return
    const max = window.innerHeight - VIEWPORT_PAD - box.height
    setTop(Math.max(VIEWPORT_PAD, Math.min(anchor.top, max)))
  }, [anchor.top])

  const { run } = row
  const cost = runCostDisplay(run)
  const updated = relativeTimeAgo(run.updatedAt)
  const live = row.state === 'running' || row.state === 'needs'
  const steps = live ? row.steps : undefined
  const review = run.review
  // Main reads a run's checks while it works and while its edits wait on review.
  const checks = review || live ? run.checks : undefined
  // Unmet is news only once the work has settled; while it works, it is the plan.
  const checksShort = checks != null && checks.met < checks.total && !live
  const footer = [cost?.text, updated ? `Updated ${updated}` : null].filter(Boolean).join(' · ')
  const left = Math.min(anchor.left, window.innerWidth - VIEWPORT_PAD - 288)

  return createPortal(
    <div
      ref={ref}
      aria-hidden="true"
      data-task-hover-card
      className={cn('pointer-events-none fixed w-72 space-y-2 p-3', MENU_SURFACE)}
      style={{ top, left: Math.max(VIEWPORT_PAD, left) }}
    >
      <p className="line-clamp-3 break-words text-sm font-medium text-fg-strong">{row.title}</p>
      <div className="space-y-1">
        <Line icon={<StatusGlyph state={row.state} size={13} />}>
          <span className="text-fg">{row.stateLabel}</span>
        </Line>
        {steps ? (
          <Line icon={<Icon name="plan" size={13} className="text-tertiary" />}>
            <span className="flex items-center gap-2" data-hover-plan>
              <PlanMeter current={steps.current} total={steps.total} state={row.state} />
              <span className="font-mono text-tertiary tnum">
                {steps.current}/{steps.total}
              </span>
            </span>
          </Line>
        ) : null}
        {run.worktreeBranch ? (
          <Line icon={<Icon name="branch" size={13} className="text-tertiary" />}>
            <span className="font-mono">{run.worktreeBranch}</span>
            <span className="text-tertiary"> · worktree</span>
          </Line>
        ) : null}
        {run.scheduled ? (
          <Line icon={<Icon name="repeat" size={13} className="text-tertiary" />}>
            <span data-hover-scheduled>{run.scheduled.label}</span>
            {run.scheduled.catchUpFrom ? <span className="text-tertiary"> · made up a missed run</span> : null}
          </Line>
        ) : null}
        <Line icon={<Icon name="folder" size={13} className="text-tertiary" />}>{row.workspaceName}</Line>
        {review ? (
          <Line icon={<Icon name="diff" size={13} className="text-tertiary" />}>
            {review.files} {review.files === 1 ? 'file' : 'files'} to review
            {review.add !== undefined && review.del !== undefined ? (
              <span className="font-mono text-tertiary tnum">
                {' '}
                · +{review.add} −{review.del}
              </span>
            ) : null}
          </Line>
        ) : null}
        {checks ? (
          <Line icon={<Icon name="checklist" size={13} className="text-tertiary" />}>
            <span className={checksShort ? 'text-warning' : 'text-muted'} data-hover-checks>
              {checks.met} of {checks.total} {checks.total === 1 ? 'check' : 'checks'} met
            </span>
          </Line>
        ) : null}
      </div>
      {footer ? <p className="text-caption text-tertiary tnum">{footer}</p> : null}
    </div>,
    document.body
  )
}

/**
 * The plan as a short meter, one segment per step: the header's plan rule in
 * small. The steps behind are done, the one it is on stands as the task does.
 */
function PlanMeter({ current, total, state }: { current: number; total: number; state: TaskState }) {
  return (
    <span className="flex h-[3px] w-16 shrink-0 gap-[2px]" aria-hidden>
      {Array.from({ length: total }, (_, i) => {
        const step: TaskState = i < current - 1 ? 'done' : i === current - 1 ? state : 'queued'
        return <span key={i} className={cn('h-full min-w-0 flex-1 rounded-full', planSegmentFill(step))} data-plan-step={step} />
      })}
    </span>
  )
}

function Line({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs text-muted">
      <span className="inline-flex w-[13px] shrink-0 justify-center">{icon}</span>
      <span className="min-w-0 truncate">{children}</span>
    </div>
  )
}
