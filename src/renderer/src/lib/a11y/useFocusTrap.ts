import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { getFocusableElements } from './focusable'

export function useFocusTrap({
  active,
  containerRef,
  initialFocusRef,
  returnFocusRef,
  contain = true
}: {
  active: boolean
  containerRef: RefObject<HTMLElement | null>
  initialFocusRef?: RefObject<HTMLElement | null>
  returnFocusRef?: RefObject<HTMLElement | null>
  /** When true, Tab wraps within the container. */
  contain?: boolean
}): void {
  const previousFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!active) return
    previousFocus.current = document.activeElement as HTMLElement | null

    const focusTarget = initialFocusRef?.current ?? containerRef.current
    if (focusTarget) {
      if (initialFocusRef?.current) {
        initialFocusRef.current.focus()
      } else {
        const focusable = getFocusableElements(containerRef.current!)
        if (focusable.length > 0) focusable[0]!.focus()
        else containerRef.current?.focus()
      }
    }

    return () => {
      const restore = returnFocusRef?.current ?? previousFocus.current
      restore?.focus?.()
    }
  }, [active, containerRef, initialFocusRef, returnFocusRef])

  useEffect(() => {
    if (!active || !contain) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      const container = containerRef.current
      if (!container) return
      const focusable = getFocusableElements(container)
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
  }, [active, contain, containerRef])
}
