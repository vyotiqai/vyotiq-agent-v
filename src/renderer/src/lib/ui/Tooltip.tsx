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

type Side = 'top' | 'bottom'
type OpenedBy = 'hover' | 'focus'

function assignRef<T>(ref: Ref<T> | undefined, node: T | null): void {
  if (!ref) return
  if (typeof ref === 'function') ref(node)
  else ref.current = node
}

const VIEWPORT_PAD = 8
const TIP_GAP = 6
/** Consecutive tips (toolbar scan) skip the delay when the previous one just closed. */
const FAST_REOPEN_MS = 300

let lastTipClosedAt = 0

/** True when the previous tip closed within the fast-reopen window. */
function justClosed(): boolean {
  return Date.now() - lastTipClosedAt < FAST_REOPEN_MS
}

function placeCoords(
  rect: DOMRect,
  preferred: Side
): { top: number; left: number; side: Side } {
  const spaceAbove = rect.top
  const spaceBelow = window.innerHeight - rect.bottom
  let side = preferred
  if (preferred === 'top' && spaceAbove < 40 && spaceBelow > spaceAbove) side = 'bottom'
  if (preferred === 'bottom' && spaceBelow < 40 && spaceAbove > spaceBelow) side = 'top'

  let left = rect.left + rect.width / 2
  left = Math.min(window.innerWidth - VIEWPORT_PAD, Math.max(VIEWPORT_PAD, left))

  return {
    side,
    top: side === 'top' ? rect.top : rect.bottom,
    left
  }
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
  const openedByRef = useRef<OpenedBy | null>(null)
  const preferredSideRef = useRef(side)
  preferredSideRef.current = side

  const clearTimer = (): void => {
    if (timerRef.current == null) return
    window.clearTimeout(timerRef.current)
    timerRef.current = null
  }

  const hide = useCallback((): void => {
    clearTimer()
    if (openedByRef.current != null) lastTipClosedAt = Date.now()
    openedByRef.current = null
    setOpenedBy(null)
    setAdjust(null)
    setOpen(false)
  }, [])

  const show = (via: OpenedBy): void => {
    if (!content) return
    if (open) {
      // Already open (hover→focus handoff): switch the opened-by state without
      // re-arming the delay timer.
      clearTimer()
      openedByRef.current = via
      setOpenedBy(via)
      return
    }
    clearTimer()
    const instant = justClosed()
    timerRef.current = window.setTimeout(
      () => {
        const el = triggerRef.current
        if (!el) return
        const placed = placeCoords(el.getBoundingClientRect(), preferredSideRef.current)
        openedByRef.current = via
        setOpenedBy(via)
        setAdjust(null)
        setCoords(placed)
        setOpen(true)
      },
      instant ? 0 : delayMs
    )
  }

  useEffect(() => () => clearTimer(), [])

  // Cancel pending show even before the tip mounts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
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

  // Follow the trigger on scroll/resize instead of hiding; only give up when
  // the trigger itself leaves the viewport.
  useEffect(() => {
    if (!open) return
    const onReposition = (): void => {
      const el = triggerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      if (
        rect.bottom < 0 ||
        rect.top > window.innerHeight ||
        rect.right < 0 ||
        rect.left > window.innerWidth
      ) {
        hide()
        return
      }
      const next = placeCoords(rect, preferredSideRef.current)
      setCoords((prev) =>
        prev && prev.side === next.side && prev.top === next.top && prev.left === next.left
          ? prev
          : next
      )
    }
    window.addEventListener('scroll', onReposition, true)
    window.addEventListener('resize', onReposition)
    return () => {
      window.removeEventListener('scroll', onReposition, true)
      window.removeEventListener('resize', onReposition)
    }
  }, [open, hide])

  // placeCoords only knows the trigger rect, not the tip size — measure the
  // mounted tip and clamp its actual box against the viewport: flip vertically
  // when the other side fits, shift otherwise.
  useLayoutEffect(() => {
    if (!open || !coords) return
    const tip = tipRef.current
    if (!tip) return
    const box = tip.getBoundingClientRect()
    const trigger = triggerRef.current?.getBoundingClientRect()
    const innerWidth = window.innerWidth
    const innerHeight = window.innerHeight
    const tipSide = coords.side

    let dx = 0
    if (box.left < VIEWPORT_PAD) dx = VIEWPORT_PAD - box.left
    else if (box.right > innerWidth - VIEWPORT_PAD) dx = innerWidth - VIEWPORT_PAD - box.right

    const otherFits = (other: Side): boolean => {
      if (!trigger) return false
      const space = other === 'bottom' ? innerHeight - trigger.bottom : trigger.top
      return space > box.height + TIP_GAP * 2
    }
    const flip = (other: Side): void => {
      setCoords((prev) =>
        prev && trigger
          ? {
              side: other,
              top: other === 'top' ? trigger.top : trigger.bottom,
              left: prev.left
            }
          : prev
      )
      setAdjust(null)
    }

    if (tipSide === 'top' && box.top < VIEWPORT_PAD) {
      if (otherFits('bottom')) flip('bottom')
      else setAdjust({ dx, dy: VIEWPORT_PAD - box.top })
      return
    }
    if (tipSide === 'bottom' && box.bottom > innerHeight - VIEWPORT_PAD) {
      if (otherFits('top')) flip('top')
      else setAdjust({ dx, dy: innerHeight - VIEWPORT_PAD - box.bottom })
      return
    }
    if (dx !== 0) setAdjust((prev) => (prev?.dx === dx && prev?.dy === 0 ? prev : { dx, dy: 0 }))
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
      const el = triggerRef.current
      // Focus-opened tip: a pointer graze doesn't close it while it holds focus.
      if (!(openedByRef.current === 'focus' && el && document.activeElement === el)) hide()
      child.props.onPointerLeave?.(e)
    },
    onFocus: (e: FocusEvent) => {
      show('focus')
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
        top: (tipSide === 'top' ? coords.top - TIP_GAP : coords.top + TIP_GAP) + (adjust?.dy ?? 0),
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
            className={cn(
              'pointer-events-none fixed z-tooltip max-w-xs -translate-x-1/2',
              tipSide === 'top' ? '-translate-y-full' : undefined
            )}
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
