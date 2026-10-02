import {
  Children,
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type PointerEvent,
  type ReactElement,
  type Ref
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from './cn'

type Side = 'top' | 'bottom' | 'left' | 'right'
type OpenedBy = 'hover' | 'focus'

function assignRef<T>(ref: Ref<T> | undefined, node: T | null): void {
  if (!ref) return
  if (typeof ref === 'function') ref(node)
  else ref.current = node
}

const VIEWPORT_PAD = 8
/** Trigger-to-tip gap; drawn as the wrapper's `pb-1.5` / `pt-1.5`, so keep them equal. */
const TIP_GAP = 6
/** Consecutive tips (toolbar scan) skip the delay when the previous one just closed. */
const FAST_REOPEN_MS = 300
/** Keyboard focus (Tab) opens tips; clicks and programmatic focus do not. */
const KEY_FOCUS_MS = 1000
/**
 * How long a tip waits after the pointer leaves its trigger, so the pointer can
 * cross onto the tip itself (WCAG 1.4.13: hover content must be hoverable).
 */
const HOVER_GRACE_MS = 120

let lastTipClosedAt = 0
let lastTipClosedByPointer = false
let lastTipLeftAt = 0
let lastAnyKeydownAt = 0
/** The one open tip's hide — opening another closes it, so a toolbar scan shows one tip. */
let closeOpenTip: (() => void) | null = null

/** True when the previous tip closed, or is closing, via pointer within the fast-reopen window. */
function justClosedByPointer(): boolean {
  const now = Date.now()
  return (lastTipClosedByPointer && now - lastTipClosedAt < FAST_REOPEN_MS) || now - lastTipLeftAt < FAST_REOPEN_MS
}

/** Keyboard focus (Tab) opens tips; clicks and programmatic focus do not. */
function recentAnyKeydown(): boolean {
  return Date.now() - lastAnyKeydownAt < KEY_FOCUS_MS
}

const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }

function isVertical(side: Side): boolean {
  return side === 'top' || side === 'bottom'
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** The room between the trigger and the viewport edge on one side. */
function spaceOn(rect: DOMRect, side: Side): number {
  switch (side) {
    case 'top':
      return rect.top
    case 'bottom':
      return window.innerHeight - rect.bottom
    case 'left':
      return rect.left
    case 'right':
      return window.innerWidth - rect.right
  }
}

/** Where the wrapper's anchor sits: the trigger's edge on that side, centred along it. */
function anchorOn(rect: DOMRect, side: Side): { top: number; left: number } {
  if (isVertical(side)) {
    return {
      top: side === 'top' ? rect.top : rect.bottom,
      left: clamp(rect.left + rect.width / 2, VIEWPORT_PAD, window.innerWidth - VIEWPORT_PAD)
    }
  }
  return {
    top: clamp(rect.top + rect.height / 2, VIEWPORT_PAD, window.innerHeight - VIEWPORT_PAD),
    left: side === 'left' ? rect.left : rect.right
  }
}

function placeCoords(
  rect: DOMRect,
  preferred: Side
): { top: number; left: number; side: Side } {
  // A tip above or below needs one line of room; one beside needs its width.
  const wants = isVertical(preferred) ? 40 : 160
  const other = OPPOSITE[preferred]
  const side = spaceOn(rect, preferred) < wants && spaceOn(rect, other) > spaceOn(rect, preferred) ? other : preferred
  return { side, ...anchorOn(rect, side) }
}

/** The wrapper's offset from its anchor, with the gap drawn as padding on the trigger's side. */
const SIDE_CLASS: Record<Side, string> = {
  top: '-translate-x-1/2 -translate-y-full pb-1.5',
  bottom: '-translate-x-1/2 pt-1.5',
  left: '-translate-x-full -translate-y-1/2 pr-1.5',
  right: '-translate-y-1/2 pl-1.5'
}

export function Tooltip({
  content,
  children,
  delayMs = 400,
  side = 'top',
  describeChild = true
}: {
  content: string
  children: ReactElement
  delayMs?: number
  side?: Side
  /** Disable the tooltip's accessible description when the child already names itself. */
  describeChild?: boolean
}) {
  const tooltipId = useId()
  const [open, setOpen] = useState(false)
  const [openedBy, setOpenedBy] = useState<OpenedBy | null>(null)
  const [coords, setCoords] = useState<{ top: number; left: number; side: Side } | null>(
    null
  )
  const [adjust, setAdjust] = useState<{ dx: number; dy: number } | null>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const tipRef = useRef<HTMLDivElement | null>(null)
  const timerRef = useRef<number | null>(null)
  const hideTimerRef = useRef<number | null>(null)
  const openedByRef = useRef<OpenedBy | null>(null)
  const preferredSideRef = useRef(side)
  preferredSideRef.current = side

  const clearTimer = (): void => {
    if (timerRef.current == null) return
    window.clearTimeout(timerRef.current)
    timerRef.current = null
  }

  const clearHideTimer = (): void => {
    if (hideTimerRef.current == null) return
    window.clearTimeout(hideTimerRef.current)
    hideTimerRef.current = null
  }

  /** This instance's `hide`, for comparing against the shared `closeOpenTip`. */
  const hideRef = useRef<(() => void) | null>(null)

  const hide = useCallback((byPointer = false): void => {
    clearTimer()
    clearHideTimer()
    if (closeOpenTip === hideRef.current) closeOpenTip = null
    if (openedByRef.current != null) lastTipClosedAt = Date.now()
    lastTipClosedByPointer = byPointer
    openedByRef.current = null
    setOpenedBy(null)
    setAdjust(null)
    setOpen(false)
  }, [])

  hideRef.current = hide

  /** Pointer left the trigger or the tip: close unless it lands on the other one. */
  const hideSoon = useCallback((): void => {
    if (hideTimerRef.current != null) window.clearTimeout(hideTimerRef.current)
    if (openedByRef.current != null) lastTipLeftAt = Date.now()
    hideTimerRef.current = window.setTimeout(() => hide(true), HOVER_GRACE_MS)
  }, [hide])

  const show = (via: OpenedBy): void => {
    if (!content) return
    clearHideTimer()
    if (open) {
      // Already open (hover→focus handoff): switch the opened-by state without
      // re-arming the delay timer.
      clearTimer()
      openedByRef.current = via
      setOpenedBy(via)
      return
    }
    clearTimer()
    // Fast re-open only for hover scanning a toolbar — never for focus.
    const instant = via === 'hover' && justClosedByPointer()
    timerRef.current = window.setTimeout(
      () => {
        const el = triggerRef.current
        if (!el) return
        const placed = placeCoords(el.getBoundingClientRect(), preferredSideRef.current)
        if (closeOpenTip && closeOpenTip !== hideRef.current) closeOpenTip()
        closeOpenTip = hideRef.current
        openedByRef.current = via
        setOpenedBy(via)
        setAdjust(null)
        setCoords(placed)
        setOpen(true)
      },
      instant ? 0 : delayMs
    )
  }

  useEffect(
    () => () => {
      clearTimer()
      clearHideTimer()
      if (closeOpenTip === hideRef.current) closeOpenTip = null
    },
    []
  )

  // Track keyboard activity (Tab focus opens tips) and cancel pending show
  // even before the tip mounts.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      lastAnyKeydownAt = Date.now()
      if (e.key !== 'Escape') return
      if (timerRef.current == null) return
      clearTimer()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Dismiss open tip — focus-opened claims Esc; hover tips hide quietly
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (openedByRef.current === 'focus') {
        e.preventDefault()
      }
      hide()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, hide])

  // Any scroll or resize dismisses the tip — it never follows its trigger
  // around the screen.
  useEffect(() => {
    if (!open) return
    const onDismiss = (): void => {
      hide()
    }
    window.addEventListener('scroll', onDismiss, true)
    window.addEventListener('resize', onDismiss)
    return () => {
      window.removeEventListener('scroll', onDismiss, true)
      window.removeEventListener('resize', onDismiss)
    }
  }, [open, hide])

  // The tip is hoverable: entering it keeps it open, leaving it closes it. A
  // portal still bubbles React events to the trigger's ancestors, so presses on
  // the tip stop here natively — selecting its text must not click the row behind.
  useEffect(() => {
    if (!open) return
    const tip = tipRef.current
    if (!tip) return
    const onEnter = (): void => {
      if (hideTimerRef.current == null) return
      window.clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
    const stop = (e: Event): void => e.stopPropagation()
    const presses = ['pointerdown', 'mousedown', 'click'] as const
    tip.addEventListener('pointerenter', onEnter)
    tip.addEventListener('pointerleave', hideSoon)
    for (const type of presses) tip.addEventListener(type, stop)
    return () => {
      tip.removeEventListener('pointerenter', onEnter)
      tip.removeEventListener('pointerleave', hideSoon)
      for (const type of presses) tip.removeEventListener(type, stop)
    }
  }, [open, hideSoon])

  // placeCoords only knows the trigger rect, not the tip size — measure the
  // mounted tip and clamp its actual box against the viewport: flip to the
  // opposite side when it fits there, shift otherwise.
  useLayoutEffect(() => {
    if (!open || !coords) return
    const tip = tipRef.current
    if (!tip) return
    const box = tip.getBoundingClientRect()
    const trigger = triggerRef.current?.getBoundingClientRect()
    const innerWidth = window.innerWidth
    const innerHeight = window.innerHeight
    const tipSide = coords.side
    const vertical = isVertical(tipSide)

    // Across the tip's axis it only ever shifts: sideways for a tip above or
    // below, up or down for one beside.
    let dx = 0
    let dy = 0
    if (vertical) {
      if (box.left < VIEWPORT_PAD) dx = VIEWPORT_PAD - box.left
      else if (box.right > innerWidth - VIEWPORT_PAD) dx = innerWidth - VIEWPORT_PAD - box.right
    } else if (box.top < VIEWPORT_PAD) dy = VIEWPORT_PAD - box.top
    else if (box.bottom > innerHeight - VIEWPORT_PAD) dy = innerHeight - VIEWPORT_PAD - box.bottom

    // Along it, how far the box spills past the viewport edge it points at.
    const spill =
      tipSide === 'top'
        ? VIEWPORT_PAD - box.top
        : tipSide === 'bottom'
          ? box.bottom - (innerHeight - VIEWPORT_PAD)
          : tipSide === 'left'
            ? VIEWPORT_PAD - box.left
            : box.right - (innerWidth - VIEWPORT_PAD)

    if (spill > 0) {
      const other = OPPOSITE[tipSide]
      // The measured box already includes the gap (it is the wrapper's padding).
      if (trigger && spaceOn(trigger, other) > (vertical ? box.height : box.width) + TIP_GAP) {
        setCoords((prev) => (prev ? { side: other, ...anchorOn(trigger, other) } : prev))
        setAdjust(null)
        return
      }
      const back = tipSide === 'top' || tipSide === 'left' ? spill : -spill
      setAdjust(vertical ? { dx, dy: back } : { dx: back, dy })
      return
    }
    if (dx !== 0 || dy !== 0) setAdjust((prev) => (prev?.dx === dx && prev?.dy === dy ? prev : { dx, dy }))
    else setAdjust(null)
  }, [open, coords])

  const child = Children.only(children) as ReactElement<{
    ref?: Ref<HTMLElement>
    'aria-describedby'?: string
    onPointerEnter?: (e: PointerEvent) => void
    onPointerLeave?: (e: PointerEvent) => void
    onFocus?: (e: FocusEvent) => void
    onBlur?: (e: FocusEvent) => void
  }>

  const describedBy = [child.props['aria-describedby'], describeChild && open ? tooltipId : null]
    .filter(Boolean)
    .join(' ')

  const trigger = cloneElement(child, {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node
      assignRef(child.props.ref, node)
    },
    'aria-describedby': describedBy || undefined,
    onPointerEnter: (e: PointerEvent) => {
      show('hover')
      child.props.onPointerEnter?.(e)
    },
    onPointerLeave: (e: PointerEvent) => {
      // Tips never persist without the pointer — even focus-opened ones — but
      // the pointer may cross onto the tip first.
      if (open) hideSoon()
      else hide(true)
      child.props.onPointerLeave?.(e)
    },
    onFocus: (e: FocusEvent) => {
      // Keyboard-initiated focus (Tab) opens the tip; clicks, autofocus, and
      // programmatic focus do not.
      if (recentAnyKeydown()) show('focus')
      child.props.onFocus?.(e)
    },
    onBlur: (e: FocusEvent) => {
      hide()
      child.props.onBlur?.(e)
    }
  })

  const tipSide = coords?.side ?? side
  const style: CSSProperties | undefined = coords
    ? {
        // The wrapper starts at the trigger's edge; its padding is the gap, so the
        // pointer never crosses a strip that belongs to neither.
        top: coords.top + (adjust?.dy ?? 0),
        left: coords.left + (adjust?.dx ?? 0)
      }
    : undefined

  const tip =
    open && coords && content
      ? createPortal(
          <div
            ref={tipRef}
            id={tooltipId}
            role="tooltip"
            data-opened-by={openedBy ?? undefined}
            className={cn('fixed z-tooltip max-w-xs', SIDE_CLASS[tipSide])}
            style={style}
          >
            <div className="whitespace-pre-line break-words rounded-md border border-border bg-card px-2 py-1 text-xs text-fg shadow-menu animate-tip-in">
              {content}
            </div>
          </div>,
          document.body
        )
      : null

  return (
    <>
      {trigger}
      {tip}
    </>
  )
}
