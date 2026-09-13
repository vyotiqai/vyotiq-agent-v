import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent
} from 'react'
import { cn } from './cn'

export type PanelResizeHandleProps = {
  /** Accessible name for the separator. */
  label: string
  /** Current size in px (for ARIA). */
  value: number
  min: number
  max: number
  /**
   * How pointer delta maps to size:
   * - `start`: handle on the leading edge of the panel (e.g. dock left) — move left grows
   * - `end`: handle on the trailing edge (e.g. sidebar right) — move right grows
   */
  edge: 'start' | 'end'
  onChange: (next: number) => void
  /** Optional step for Arrow keys (default 8). Shift multiplies by 5. */
  step?: number
  className?: string
  disabled?: boolean
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)))
}

/**
 * Vertical drag gutter between side-by-side panes.
 * Mouse drag + ARIA separator; keyboard arrows nudge width.
 */
export function PanelResizeHandle({
  label,
  value,
  min,
  max,
  edge,
  onChange,
  step = 8,
  className,
  disabled = false
}: PanelResizeHandleProps) {
  const [dragging, setDragging] = useState(false)
  const valueRef = useRef(value)
  valueRef.current = value
  const edgeRef = useRef(edge)
  edgeRef.current = edge
  const minRef = useRef(min)
  minRef.current = min
  const maxRef = useRef(max)
  maxRef.current = max
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const draggingRef = useRef(false)
  const cleanupDragRef = useRef<(() => void) | null>(null)

  const apply = useCallback((next: number) => {
    onChangeRef.current(clamp(next, minRef.current, maxRef.current))
  }, [])

  const stopDrag = useCallback((): void => {
    cleanupDragRef.current?.()
    cleanupDragRef.current = null
    draggingRef.current = false
    setDragging(false)
  }, [])

  useEffect(() => stopDrag, [stopDrag])

  const startDrag = useCallback(
    (clientX: number, target: HTMLDivElement, pointerId?: number): void => {
      if (disabled || draggingRef.current) return
      draggingRef.current = true
      setDragging(true)
      if (pointerId != null) {
        try {
          target.setPointerCapture(pointerId)
        } catch {
          // Pointer capture can fail when the handle is removed during a drag.
        }
      }

      const startValue = valueRef.current
      const startX = clientX
      const prevUserSelect = document.body.style.userSelect
      const prevCursor = document.body.style.cursor
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'

      const onMove = (event: globalThis.PointerEvent | globalThis.MouseEvent): void => {
        const dx = event.clientX - startX
        const delta = edgeRef.current === 'end' ? dx : -dx
        apply(startValue + delta)
      }
      const onUp = (): void => {
        if (pointerId != null) {
          try {
            target.releasePointerCapture(pointerId)
          } catch {
            // The pointer may already have been released by the browser.
          }
        }
        document.body.style.userSelect = prevUserSelect
        document.body.style.cursor = prevCursor
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        cleanupDragRef.current = null
        draggingRef.current = false
        setDragging(false)
      }

      cleanupDragRef.current = onUp
      if (pointerId != null) {
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onUp)
      } else {
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
      }
    },
    [apply, disabled]
  )

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (disabled || e.button !== 0 || !e.isPrimary) return
    e.preventDefault()
    startDrag(e.clientX, e.currentTarget, e.pointerId)
  }

  const onMouseDown = (e: MouseEvent<HTMLDivElement>): void => {
    if (disabled || e.button !== 0 || draggingRef.current) return
    e.preventDefault()
    startDrag(e.clientX, e.currentTarget)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return
    const mul = e.shiftKey ? 5 : 1
    const amount = step * mul
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      apply(value + (edge === 'end' ? -amount : amount))
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      apply(value + (edge === 'end' ? amount : -amount))
    } else if (e.key === 'Home') {
      e.preventDefault()
      apply(min)
    } else if (e.key === 'End') {
      e.preventDefault()
      apply(max)
    }
  }

  return (
    // ARIA separator is the native semantic for a resizable gutter.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      data-panel-resize-handle
      data-dragging={dragging ? '1' : undefined}
      className={cn(
        'group relative z-sticky w-1.5 shrink-0 touch-none select-none',
        disabled
          ? 'cursor-default'
          : 'cursor-col-resize focus-visible:vy-focus-ring',
        className
      )}
      onPointerDown={onPointerDown}
      onMouseDown={onMouseDown}
      onKeyDown={onKeyDown}
    >
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border/50',
          'group-hover:bg-border-strong group-focus-visible:bg-accent',
          dragging && 'bg-accent'
        )}
      />
    </div>
  )
}
