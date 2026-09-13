import { useCallback, useEffect, useRef, useState, type TransitionEvent } from 'react'
import { prefersReducedMotion } from '@renderer/lib/utils/motion'

/** Slightly above --vy-duration so a missed transitionend still unmounts. */
export const EXPAND_CLOSE_FALLBACK_MS = 220

/**
 * Mount on open, animate height via data-open, unmount after close transition.
 * Reduced-motion syncs mount to `open` with no delay.
 */
export function useExpandMotion(open: boolean): {
  mounted: boolean
  dataOpen: boolean
  onTransitionEnd: (event: TransitionEvent<HTMLElement>) => void
} {
  const reduced = prefersReducedMotion()
  const [mounted, setMounted] = useState(open)
  const [dataOpen, setDataOpen] = useState(open)
  const openRef = useRef(open)
  openRef.current = open
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current != null) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (reduced) {
      clearCloseTimer()
      setMounted(open)
      setDataOpen(open)
      return
    }

    if (open) {
      clearCloseTimer()
      setMounted(true)
      const id = requestAnimationFrame(() => {
        if (openRef.current) setDataOpen(true)
      })
      return () => cancelAnimationFrame(id)
    }

    setDataOpen(false)
    clearCloseTimer()
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null
      if (!openRef.current) setMounted(false)
    }, EXPAND_CLOSE_FALLBACK_MS)
    return clearCloseTimer
  }, [open, reduced, clearCloseTimer])

  const onTransitionEnd = useCallback(
    (event: TransitionEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget) return
      // Ignore sibling chrome transitions (chevron transform, color morphs).
      const name = event.propertyName
      if (name && name !== 'grid-template-rows') return
      if (openRef.current) return
      clearCloseTimer()
      setMounted(false)
    },
    [clearCloseTimer]
  )

  return { mounted, dataOpen, onTransitionEnd }
}
