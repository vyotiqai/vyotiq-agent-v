import { useState, type ReactNode, type Ref } from 'react'
import { STATE_LABEL, Tooltip, cn, type TaskState } from '@renderer/lib/ui'
import { DIVIDER_FILL, RECORD_MAX, SECTION_LABEL } from '@renderer/lib/utils/layout'
import { plainLine } from './plainText'

/** Keys that move along the plan line, and where each one goes. */
const PLAN_KEYS: Record<string, (at: number, last: number) => number> = {
  ArrowRight: (at, last) => Math.min(at + 1, last),
  ArrowLeft: (at) => Math.max(at - 1, 0),
  Home: () => 0,
  End: (_at, last) => last
}

/**
 * The plan as one rule: one segment per step, so progress costs no row. Done
 * steps are quiet ink, the live one breathes in the accent, one that needs you
 * is solid accent, a failed one is the danger hue. A plan with nothing left to
 * do draws nothing.
 *
 * With `onStep`, each segment is the way to its step in a long record: one
 * stop in the tab order (the live step's, else the first), the arrow keys
 * along it, and a press a few pixels taller than the rule it draws.
 */
export function PlanLine({
  steps,
  onStep
}: {
  steps: ReadonlyArray<{ title: string; state: TaskState }>
  onStep?: (index: number) => void
}) {
  const [focusAt, setFocusAt] = useState<number | null>(null)
  if (steps.length === 0 || steps.every((s) => s.state === 'done' || s.state === 'review')) return null
  const at = steps.findIndex((s) => s.state === 'running' || s.state === 'needs')
  const done = steps.filter((s) => s.state === 'done' || s.state === 'review').length
  const summary = at >= 0 ? `Step ${at + 1} of ${steps.length}` : `${done} of ${steps.length} steps done`
  const stop = Math.min(focusAt ?? Math.max(at, 0), steps.length - 1)
  const line = 'absolute inset-x-0 -bottom-px z-sticky flex h-[3px] gap-[3px]'
  const segments = steps.map((s, i) => {
    // Words, not markdown: a step names `inputs` and **bold** the way its plan wrote them.
    const label = `${i + 1}. ${plainLine(s.title)}`
    return (
      <Tooltip key={i} content={label} describeChild={false}>
        {onStep ? (
          <button
            type="button"
            tabIndex={i === stop ? 0 : -1}
            aria-label={`Go to step ${label}, ${STATE_LABEL[s.state].toLowerCase()}`}
            onClick={() => onStep(i)}
            onFocus={() => setFocusAt(i)}
            // The press reaches 6px above the rule it draws, so it is a stop
            // you can hit rather than a hairline you have to find.
            className={cn(
              'relative h-full min-w-0 flex-1 rounded-full after:absolute after:inset-x-0 after:-top-1.5 after:bottom-0 focus-visible:vy-focus-ring',
              planSegmentFill(s.state)
            )}
            data-plan-step={s.state}
          />
        ) : (
          <span className={cn('h-full min-w-0 flex-1 rounded-full', planSegmentFill(s.state))} data-plan-step={s.state} />
        )}
      </Tooltip>
    )
  })
  if (!onStep) {
    return (
      <div className={line} role="img" aria-label={summary} data-plan-line>
        {segments}
      </div>
    )
  }
  return (
    <div
      className={line}
      role="toolbar"
      aria-label={`Plan · ${summary}`}
      onKeyDown={(e) => {
        const move = PLAN_KEYS[e.key]
        if (!move) return
        e.preventDefault()
        const next = move(stop, steps.length - 1)
        setFocusAt(next)
        e.currentTarget.querySelectorAll<HTMLElement>('[data-plan-step]')[next]?.focus()
      }}
      data-plan-line
    >
      {segments}
    </div>
  )
}

/** A plan step's segment, by how the step stands; the navigator's hover card draws the same. */
export function planSegmentFill(state: TaskState): string {
  switch (state) {
    case 'done':
    case 'review':
      return 'bg-muted'
    case 'running':
      return 'animate-live bg-accent'
    case 'needs':
      return 'bg-accent'
    case 'failed':
      return 'bg-danger'
    case 'stopped':
      return 'bg-border-strong'
    default:
      return DIVIDER_FILL
  }
}

/**
 * One block of the record, on one content edge. No label gutter: the brief,
 * the work and the receipt say what they are by their shape. A heading appears
 * only where the content cannot name itself — Done when, Result, History.
 */
export function RecordRow({
  label,
  meta,
  children,
  className,
  id
}: {
  label?: string
  meta?: ReactNode
  children: ReactNode
  className?: string
  id?: string
}) {
  return (
    <section id={id} aria-label={label} className={cn('py-3', className)}>
      {label ? (
        <h2 className={cn('mb-2 flex items-baseline gap-2', SECTION_LABEL)}>
          {label}
          {meta ? <span className="font-mono font-normal normal-case tracking-normal text-tertiary tnum">{meta}</span> : null}
        </h2>
      ) : null}
      {children}
    </section>
  )
}

/** Scroll body of the record: one centred column. */
export function RecordBody({
  children,
  className,
  scrollRef,
  contentRef,
  onScroll,
  onActivate
}: {
  children: ReactNode
  className?: string
  scrollRef?: Ref<HTMLDivElement>
  /** The column itself — what grows while a run streams. */
  contentRef?: Ref<HTMLDivElement>
  onScroll?: () => void
  /** Pointer or focus inside the record focuses its pane. */
  onActivate?: () => void
}) {
  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      onPointerDownCapture={onActivate}
      onFocus={onActivate}
      className="@container/record scroll-thin min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
      data-record-scroll
      data-transcript-scroll
    >
      <div ref={contentRef} className={cn('mx-auto w-full px-4 pb-10 pt-3', RECORD_MAX, className)}>
        {children}
      </div>
    </div>
  )
}

/** Divider between runs: one caps label on the rule. */
export function RunDivider({ n, at }: { n: number; at?: string }) {
  return (
    <div className="flex items-center gap-3 pb-1 pt-6" data-run-divider={n}>
      <span className={cn('shrink-0', SECTION_LABEL)}>
        Run {n}
        {at ? <span className="ml-2 font-mono font-normal normal-case tracking-normal tnum">{at}</span> : null}
      </span>
      <span className={cn('h-px flex-1', DIVIDER_FILL)} />
    </div>
  )
}
