import { AgentVSpinner } from '@renderer/lib/brand/AgentVSpinner'
import { cn } from './cn'

/**
 * One state vocabulary for every task, step and instance in the app.
 *
 * Each state is a SHAPE first, then a colour, then (wherever there is room) a
 * word — never hue alone. Only the states that want you are coloured; history
 * is grey.
 *
 *   queued   dashed ring        tertiary
 *   running  the Agent V mark   fg
 *   needs    solid diamond      accent   ← the one thing that pulls the eye
 *   review   ring + check       success
 *   done     disc + check       tertiary
 *   failed   disc + ×           danger
 *   stopped  ring + square      tertiary
 *   paused   ring + bars        muted
 */
export type TaskState = 'queued' | 'running' | 'needs' | 'review' | 'done' | 'failed' | 'stopped' | 'paused'

export const STATE_LABEL: Record<TaskState, string> = {
  queued: 'Queued',
  running: 'Running',
  needs: 'Needs you',
  review: 'Ready for review',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
  paused: 'Paused'
}

const TONE: Record<Exclude<TaskState, 'running'>, string> = {
  queued: 'text-tertiary',
  needs: 'text-accent',
  review: 'text-success',
  done: 'text-tertiary',
  failed: 'text-danger',
  stopped: 'text-tertiary',
  paused: 'text-muted'
}

export function StatusGlyph({
  state,
  size = 14,
  className,
  label = false
}: {
  state: TaskState
  size?: number
  className?: string
  /** Give it an accessible name when no visible word sits beside it. */
  label?: boolean
}) {
  const a11y = label ? { role: 'img' as const, 'aria-label': STATE_LABEL[state] } : { 'aria-hidden': true as const }
  if (state === 'running') {
    return (
      <span
        className={cn('inline-grid shrink-0 place-items-center text-fg', className)}
        style={{ width: size, height: size }}
        data-state={state}
        {...a11y}
      >
        <AgentVSpinner size={Math.round(size * 0.86)} />
      </span>
    )
  }
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={cn('shrink-0', TONE[state], className)}
      data-state={state}
      {...a11y}
    >
      {state === 'queued' ? (
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.4 2.2" />
      ) : null}
      {state === 'needs' ? (
        <rect x="3.2" y="3.2" width="9.6" height="9.6" rx="1.6" transform="rotate(45 8 8)" fill="currentColor" />
      ) : null}
      {state === 'review' ? (
        <>
          <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M5.3 8.2l1.8 1.8 3.6-3.8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : null}
      {state === 'done' ? (
        <>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path
            d="M5.2 8.2l1.9 1.9 3.8-4"
            fill="none"
            stroke="var(--vy-bg)"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : null}
      {state === 'failed' ? (
        <>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" stroke="var(--vy-bg)" strokeWidth="1.7" strokeLinecap="round" />
        </>
      ) : null}
      {state === 'stopped' ? (
        <>
          <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <rect x="5.9" y="5.9" width="4.2" height="4.2" rx="0.6" fill="currentColor" />
        </>
      ) : null}
      {state === 'paused' ? (
        <>
          <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6.6 5.9v4.2M9.4 5.9v4.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </>
      ) : null}
    </svg>
  )
}

/** Step markers inside a record: numbered while pending, the glyph once it moves. */
export function StepMarker({ state, n }: { state: TaskState; n: number }) {
  if (state === 'queued') {
    return (
      <span className="inline-grid size-[18px] shrink-0 place-items-center rounded-full border border-border-strong font-mono text-2xs text-tertiary">
        {n}
      </span>
    )
  }
  return (
    <span className="inline-grid size-[18px] shrink-0 place-items-center">
      <StatusGlyph state={state} size={16} />
    </span>
  )
}
