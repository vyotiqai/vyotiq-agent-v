import { useCallback, useEffect, useId, useRef, type JSX } from 'react'

type AnnouncePriority = 'polite' | 'assertive'

let globalAnnounce: ((message: string, priority?: AnnouncePriority) => void) | null = null

/** Imperative announce for non-React callers (e.g. toast store). */
export function announceLive(message: string, priority: AnnouncePriority = 'polite'): void {
  globalAnnounce?.(message, priority)
}

/**
 * Mount once at app root. Returns `announce` for child components.
 * Clears text briefly before re-announcing so repeated messages are read.
 */
export function useLiveAnnouncer(): {
  announce: (message: string, priority?: AnnouncePriority) => void
  LiveRegion: () => JSX.Element
} {
  const politeId = useId()
  const assertiveId = useId()
  const politeRef = useRef<HTMLDivElement>(null)
  const assertiveRef = useRef<HTMLDivElement>(null)

  const announce = useCallback((message: string, priority: AnnouncePriority = 'polite') => {
    const el = priority === 'assertive' ? assertiveRef.current : politeRef.current
    if (!el || !message.trim()) return
    el.textContent = ''
    window.requestAnimationFrame(() => {
      if (el) el.textContent = message
    })
  }, [])

  useEffect(() => {
    globalAnnounce = announce
    return () => {
      if (globalAnnounce === announce) globalAnnounce = null
    }
  }, [announce])

  const LiveRegion = useCallback(
    function LiveRegion() {
      return (
        <>
          <div
            id={politeId}
            ref={politeRef}
            className="sr-only"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          />
          <div
            id={assertiveId}
            ref={assertiveRef}
            className="sr-only"
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
          />
        </>
      )
    },
    [assertiveId, politeId]
  )

  return { announce, LiveRegion }
}
