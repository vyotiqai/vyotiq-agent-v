import type { ReactNode, Ref } from 'react'
import { STATE_LABEL, StatusGlyph, Tooltip, cn, type TaskState } from '@renderer/lib/ui'
import { DIVIDER_FILL, RECORD_MAX, SECTION_LABEL } from '@renderer/lib/utils/layout'

/**
 * The task header is one 40px row — the height of the inspector's tab strip,
 * so every pane starts on one shared rule. Glyph, title, where the work lives,
 * actions. The step count is in the step list and the workspace is in the
 * navigator, so neither is repeated here.
 */
export function TaskHeader({
  state,
  stateLabel,
  title,
  editor,
  facts,
  actions,
  plan
}: {
  /** None for a task that has not started. */
  state?: TaskState | null
  stateLabel?: string
  title: string
  /** While renaming, an input takes the title's place. */
  editor?: ReactNode
  facts?: Array<{ text: ReactNode; mono?: boolean; title?: string }>
  actions?: ReactNode
  /** The latest plan's steps, drawn over the header's bottom rule. */
  plan?: ReadonlyArray<{ title: string; state: TaskState }>
}) {
  return (
    <header
      className="relative flex h-10 shrink-0 items-center gap-2.5 border-b border-border pl-4 pr-2"
      data-task-header
    >
      {state ? (
        <span title={stateLabel ?? STATE_LABEL[state]} className="shrink-0" data-task-state={state}>
          <StatusGlyph state={state} size={14} label />
        </span>
      ) : null}
      {editor ?? (
        <h1
          tabIndex={-1}
          title={title}
          className="min-w-0 truncate text-sm font-semibold text-fg-strong outline-none"
        >
          {title}
        </h1>
      )}
      {(facts ?? []).map((f, i) => (
        <span key={i} title={f.title} className={cn('min-w-0 shrink truncate text-xs text-tertiary', f.mono && 'font-mono')}>
          {f.text}
        </span>
      ))}
      <span className="flex-1" />
      {actions ? <div className="flex shrink-0 items-center gap-0.5">{actions}</div> : null}
      {plan ? <PlanLine steps={plan} /> : null}
    </header>
  )
}

/**
 * The plan as the header's bottom rule: one segment per step, so progress
 * costs no row. Done steps are quiet ink, the live one breathes in the
 * accent, one that needs you is solid accent, a failed one is the danger hue.
 * A plan with nothing left to do draws nothing.
 */
export function PlanLine({ steps }: { steps: ReadonlyArray<{ title: string; state: TaskState }> }) {
  if (steps.length === 0 || steps.every((s) => s.state === 'done' || s.state === 'review')) return null
  const at = steps.findIndex((s) => s.state === 'running' || s.state === 'needs')
  const done = steps.filter((s) => s.state === 'done' || s.state === 'review').length
  return (
    <div
      className="absolute inset-x-0 -bottom-px z-sticky flex h-[3px] gap-[3px]"
      role="img"
      aria-label={at >= 0 ? `Step ${at + 1} of ${steps.length}` : `${done} of ${steps.length} steps done`}
      data-plan-line
    >
      {steps.map((s, i) => (
        <Tooltip key={i} content={`${i + 1}. ${s.title}`} describeChild={false}>
          <span className={cn('h-full min-w-0 flex-1 rounded-full', planSegmentFill(s.state))} data-plan-step={s.state} />
        </Tooltip>
      ))}
    </div>
  )
}

function planSegmentFill(state: TaskState): string {
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
      <div ref={contentRef} className={cn('mx-auto w-full px-6 pb-10 pt-3', RECORD_MAX, className)}>
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
