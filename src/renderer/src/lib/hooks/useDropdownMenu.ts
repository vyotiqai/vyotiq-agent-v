import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject
} from 'react'
import { getFocusableElements } from '@renderer/lib/a11y'

const DROPDOWN_GAP_PX = 6
const VIEWPORT_PAD_PX = 8
/** Fallback when the panel has not measured yet. */
const DEFAULT_MENU_HEIGHT_PX = 120

export type DropdownPlacement = 'up' | 'down'
export type DropdownAlign = 'start' | 'end'

export type DropdownPosition = {
  top: number
  left: number
  width: number
  minWidth: number
  /** Preferred placement after viewport collision flip. */
  placement: DropdownPlacement
}

export function useDropdownMenu({
  open,
  onOpenChange,
  triggerRef,
  panelRef,
  placement = 'up',
  align = 'start',
  disabled,
  trapFocus = false,
  autoFocusFirst = false
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  triggerRef: RefObject<HTMLElement | null>
  panelRef?: RefObject<HTMLElement | null>
  placement?: DropdownPlacement
  align?: DropdownAlign
  disabled?: boolean
  /** Keep Tab focus inside the open menu panel. */
  trapFocus?: boolean
  /** Focus the first focusable control when the menu opens. */
  autoFocusFirst?: boolean
}): {
  position: DropdownPosition | null
  close: (restoreFocus?: boolean) => void
} {
  const [position, setPosition] = useState<DropdownPosition | null>(null)
  const preferredPlacement = useRef(placement)
  preferredPlacement.current = placement

  const close = useCallback(
    (restoreFocus = false) => {
      onOpenChange(false)
      if (restoreFocus) {
        window.setTimeout(() => triggerRef.current?.focus(), 0)
      }
    },
    [onOpenChange, triggerRef]
  )

  const updatePosition = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const panelH = panelRef?.current?.offsetHeight || DEFAULT_MENU_HEIGHT_PX
    let resolved = preferredPlacement.current

    if (resolved === 'down') {
      if (rect.bottom + DROPDOWN_GAP_PX + panelH > window.innerHeight - VIEWPORT_PAD_PX) {
        resolved = 'up'
      }
    } else if (rect.top - DROPDOWN_GAP_PX - panelH < VIEWPORT_PAD_PX) {
      resolved = 'down'
    }

    setPosition({
      top: resolved === 'up' ? rect.top - DROPDOWN_GAP_PX : rect.bottom + DROPDOWN_GAP_PX,
      left: align === 'end' ? rect.right : rect.left,
      width: Math.min(300, window.innerWidth - 32),
      minWidth: Math.max(rect.width, 188),
      placement: resolved
    })
  }, [triggerRef, panelRef, align])

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    updatePosition()
    // Remeasure after the panel paints so flip uses real height.
    const raf = window.requestAnimationFrame(() => updatePosition())
    const onLayout = (): void => updatePosition()
    window.addEventListener('resize', onLayout)
    window.addEventListener('scroll', onLayout, true)
    return () => {
      window.cancelAnimationFrame(raf)
      window.removeEventListener('resize', onLayout)
      window.removeEventListener('scroll', onLayout, true)
    }
  }, [open, updatePosition])

  useEffect(() => {
    if (disabled && open) close(false)
  }, [disabled, open, close])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target)) return
      if (panelRef?.current?.contains(target)) return
      close(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        // Back to the trigger only from inside the panel: a panel that opened
        // on its own must not pull focus out of whatever you were typing in.
        close(panelRef?.current?.contains(document.activeElement) ?? true)
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close, triggerRef, panelRef])

  useEffect(() => {
    if (!open || !autoFocusFirst) return
    const t = window.setTimeout(() => {
      const panel = panelRef?.current
      if (!panel) return
      const focusable = getFocusableElements(panel)
      if (focusable.length > 0) focusable[0]!.focus()
      else panel.focus()
    }, 0)
    return () => window.clearTimeout(t)
  }, [open, autoFocusFirst, panelRef])

  useEffect(() => {
    if (!open || !trapFocus || !panelRef?.current) return
    const panel = panelRef.current
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      const focusable = getFocusableElements(panel)
      if (focusable.length === 0) return
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, trapFocus, panelRef])

  return { position, close }
}

export { DROPDOWN_GAP_PX }
