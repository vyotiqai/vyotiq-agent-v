import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@renderer/lib/icons'
import { cn } from '@renderer/lib/ui'
import { useRunTodos } from '../hooks/useRunTodos'
import { pickCurrentTask, type TodoParsed } from '../toolUi/parsers/todo'
import { TodoStatusIcon } from './TodoChecklist'
import { TodoProgressBar } from './TasksCeilingBand'

const HOVER_OPEN_MS = 150
const HOVER_CLOSE_MS = 150
/** Fallbacks while the card has not measured yet. */
const CARD_WIDTH_FALLBACK_PX = 288
const CARD_HEIGHT_FALLBACK_PX = 180
const VIEWPORT_PAD_PX = 12
const CARD_GAP_PX = 8
/** Capture-phase scroll listener: passive (never preventDefault) + capturing. */
const SCROLL_LISTENER: AddEventListenerOptions = { capture: true, passive: true }

type CardCoords = { top: number; left: number }

/** Constrained card width: shrinks on narrow windows, capped at w-72. */
const cardWidthClass = 'w-[min(18rem,calc(100vw-1.5rem))]'

/**
 * The live plan control itself: status icon + done/total badge, with the
 * full task list streaming in a pop-up card. Todo data is passed in
 * so the rail's single poll feeds both the icon and the card.
 *
 * The card opens on hover as before, and also opens itself when the host
 * signals that the agent just created todos (see PlanRailRow's transition
 * detection — a rail that mounted onto an existing run never pops the card).
 */
export function TasksRailButton({
  data,
  running = false,
  autoOpen = false,
  onOpenPlan,
  pressed,
  labelSuffix,
  className
}: {
  data: TodoParsed | null
  running?: boolean
  /** Momentary signal: the host saw todos appear (agent created them). */
  autoOpen?: boolean
  onOpenPlan: () => void
  /** True while the plan dock panel is open (rail hosts that stay visible). */
  pressed?: boolean
  /** Appended to the accessible name, e.g. " · Show plan panel (Alt+6)". */
  labelSuffix?: string
  className?: string
}) {
  const cardId = useId()
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<CardCoords | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const openTimerRef = useRef<number | null>(null)
  const closeTimerRef = useRef<number | null>(null)

  const items = data?.items ?? []
  const done = data?.done ?? 0
  const total = data?.total ?? 0
  const cancelled = items.filter((item) => item.status === 'cancelled').length
  // Finished means nothing left to do: every task completed or skipped, with
  // at least one completion so an all-cancelled (interrupted) run stays neutral.
  const allDone = total > 0 && done > 0 && done + cancelled === total
  const current = pickCurrentTask(items)
  const hasActive = current?.status === 'in_progress'
  const count = `${done}/${total}`

  // One constant glyph; state is carried by color only (secondary / accent /
  // success). The count sits under the icon inside the button — no floating
  // badge outside its bounds.
  const statusClass = hasActive ? 'text-accent' : allDone ? 'text-success' : 'text-secondary'

  const ariaLabel = `Tasks ${done} of ${total}${current ? `. ${current.content}` : ''}${labelSuffix ?? ''}`

  const clearTimers = useCallback(() => {
    if (openTimerRef.current != null) {
      window.clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const closeNow = useCallback(() => {
    clearTimers()
    setOpen(false)
  }, [clearTimers])

  const scheduleOpen = useCallback(() => {
    clearTimers()
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null
      setOpen(true)
    }, HOVER_OPEN_MS)
  }, [clearTimers])

  const scheduleClose = useCallback(() => {
    clearTimers()
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      setOpen(false)
    }, HOVER_CLOSE_MS)
  }, [clearTimers])

  const measure = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const cardW = cardRef.current?.offsetWidth || CARD_WIDTH_FALLBACK_PX
    const cardH = cardRef.current?.offsetHeight || CARD_HEIGHT_FALLBACK_PX
    const left = Math.max(VIEWPORT_PAD_PX, rect.left - CARD_GAP_PX - cardW)
    const maxTop = Math.max(VIEWPORT_PAD_PX, window.innerHeight - cardH - VIEWPORT_PAD_PX)
    const top = Math.min(
      Math.max(VIEWPORT_PAD_PX, rect.top + rect.height / 2 - cardH / 2),
      maxTop
    )
    setCoords((prev) => (prev?.top === top && prev?.left === left ? prev : { top, left }))
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    measure()
    const raf = window.requestAnimationFrame(measure)
    return () => window.cancelAnimationFrame(raf)
  }, [open, measure, items.length])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (e.defaultPrevented) return
      e.preventDefault()
      closeNow()
    }
    const onDocMouseDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target)) return
      if (cardRef.current?.contains(target)) return
      closeNow()
    }
    const onReposition = (e: Event): void => {
      const target = e.target
      if (target instanceof Node) {
        // The card's own scrollable list and the trigger are not page reflows.
        if (cardRef.current?.contains(target)) return
        if (triggerRef.current?.contains(target)) return
      }
      closeNow()
    }
    window.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onDocMouseDown)
    window.addEventListener('scroll', onReposition, SCROLL_LISTENER)
    window.addEventListener('resize', onReposition)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onDocMouseDown)
      window.removeEventListener('scroll', onReposition, SCROLL_LISTENER)
      window.removeEventListener('resize', onReposition)
    }
  }, [open, closeNow])

  useEffect(() => clearTimers, [clearTimers])

  // Auto-open signal from the host: the rail detects the 0 -> N transition,
  // so re-mounts and app restarts onto an existing batch stay quiet.
  useEffect(() => {
    if (autoOpen) setOpen(true)
  }, [autoOpen])

  if (!data || items.length === 0) return null

  const card =
    open && coords ? (
      createPortal(
        <div
          ref={cardRef}
          id={cardId}
          role="dialog"
          aria-label={`Tasks ${done} of ${total}`}
          data-tasks-popover-card
          className={cn(
            'pointer-events-auto fixed z-tooltip rounded-xl border border-border bg-card p-3 shadow-menu animate-tip-in',
            cardWidthClass
          )}
          style={{ top: coords.top, left: coords.left }}
          onPointerEnter={clearTimers}
          onPointerLeave={scheduleClose}
        >
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="text-xs font-semibold text-fg">Tasks</span>
            {running ? (
              <span
                className="inline-flex shrink-0 items-center rounded-full bg-accent/10 px-1.5 py-px text-2xs font-medium text-accent"
                data-tasks-popover-live
              >
                Live
              </span>
            ) : null}
            <span className="ml-auto shrink-0 tabular-nums text-caption text-muted">
              {count}
            </span>
          </div>
          <TodoProgressBar done={done} total={total} className="mt-2" />
          <ul
            className="m-0 mt-2 max-h-[min(14rem,max(6rem,calc(100vh-18rem)))] list-none space-y-1 overflow-y-auto p-0"
            data-tasks-popover-list
          >
            {items.map((item, index) => (
              <li
                key={item.id ?? index}
                className={cn(
                  'flex min-w-0 items-start gap-1.5 text-2xs leading-snug text-secondary',
                  item.status === 'in_progress' && 'font-medium text-fg',
                  item.status === 'completed' && 'text-muted',
                  item.status === 'cancelled' && 'text-muted line-through'
                )}
              >
                <TodoStatusIcon status={item.status} size={12} className="mt-px" />
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{item.content}</span>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-center justify-end gap-2 border-t border-border/40 pt-2">
            <button
              type="button"
              className="shrink-0 rounded-md px-1.5 py-0.5 text-2xs font-medium text-fg vy-transition hover:bg-surface"
              data-tasks-popover-open
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                closeNow()
                onOpenPlan()
              }}
            >
              Open plan panel
            </button>
          </div>
        </div>,
        document.body
      )
    ) : null

  return (
    <>
      {/* Outside the button: role=status is stripped from button descendants
          (ARIA presentational children), so the announcement must live here. */}
      <span className="sr-only" role="status" aria-live="polite">
        {`Tasks ${done} of ${total}${current ? `. ${current.content}` : ''}${running ? '. Run in progress' : ''}`}
      </span>
      <button
        ref={triggerRef}
        type="button"
        data-tasks-floating
        data-tasks-floating-chip
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? cardId : undefined}
        aria-label={ariaLabel}
        aria-pressed={pressed}
        className={cn(
          'relative inline-grid size-7 place-items-center rounded-md text-muted vy-transition hover:bg-surface hover:text-fg active:bg-surface-2',
          (open || pressed) && 'bg-surface text-fg ring-1 ring-inset ring-border/50',
          className
        )}
        onClick={() => {
          closeNow()
          onOpenPlan()
        }}
        onPointerEnter={scheduleOpen}
        onPointerLeave={scheduleClose}
      >
        <Icon name="listTodo" size={15} className={cn('shrink-0', statusClass)} />
        <span
          data-tasks-floating-count
          className={cn(
            'text-[9px] font-semibold leading-none tabular-nums',
            allDone ? 'text-success' : 'text-muted'
          )}
        >
          {count}
        </span>
      </button>
      {card}
    </>
  )
}

/** Self-polling wrapper for standalone use (rail-less hosts, tests). */
export function TasksRailChip({
  workspacePath,
  runId,
  running = false,
  onOpenPlan,
  labelSuffix,
  className
}: {
  workspacePath: string | null
  runId: string | null
  running?: boolean
  onOpenPlan: () => void
  labelSuffix?: string
  className?: string
}) {
  const { data } = useRunTodos({
    workspacePath,
    runId,
    running,
    active: Boolean(workspacePath && runId),
    live: true
  })

  return (
    <TasksRailButton
      data={data}
      running={running}
      onOpenPlan={onOpenPlan}
      labelSuffix={labelSuffix}
      className={className}
    />
  )
}
