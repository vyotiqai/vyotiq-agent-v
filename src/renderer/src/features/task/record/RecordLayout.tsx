import type { ReactNode, Ref } from 'react'
import { STATE_LABEL, StatusGlyph, cn, type TaskState } from '@renderer/lib/ui'
import { RECORD_MAX, SECTION_LABEL } from '@renderer/lib/utils/layout'

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
  headingRef
}: {
  /** None for a task that has not started. */
  state?: TaskState | null
  stateLabel?: string
  title: string
  /** While renaming, an input takes the title's place. */
  editor?: ReactNode
  facts?: Array<{ text: ReactNode; mono?: boolean; title?: string }>
  actions?: ReactNode
  headingRef?: Ref<HTMLHeadingElement>
}) {
  return (
    <header
      className="flex h-10 shrink-0 items-center gap-2.5 border-b border-border pl-4 pr-2"
      data-task-header
    >
      {state ? (
        <span title={stateLabel ?? STATE_LABEL[state]} className="shrink-0" data-task-state={state}>
          <StatusGlyph state={state} size={14} label />
        </span>
      ) : null}
      {editor ?? (
        <h1
          ref={headingRef}
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
    </header>
  )
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
      <span className="h-px flex-1 bg-border" />
    </div>
  )
}
