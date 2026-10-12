import { useEffect } from 'react'

/**
 * Reflect assistive-tech detection on the app chrome: `data-a11y="on"` when a
 * screen reader (or another assistive tool) is detected, `"off"` otherwise.
 * Mount once at the app root. Missing preload APIs are tolerated (tests, web
 * builds) — the flag then stays at its default.
 */
export function useAccessibilitySupport(): void {
  useEffect(() => {
    const apply = (enabled: boolean): void => {
      document.documentElement.dataset.a11y = enabled ? 'on' : 'off'
    }
    let cancelled = false
    const query = window.vyotiq?.getAccessibilitySupportState
    if (typeof query === 'function') {
      void query().then(
        (res) => {
          if (cancelled) return
          if (res?.ok) apply(res.data.enabled)
        },
        () => {
          // Keep the default; assistive tech simply stays undisclosed.
        }
      )
    }
    const subscribe = window.vyotiq?.onAccessibilitySupportChanged
    if (typeof subscribe !== 'function') return () => {
      cancelled = true
    }
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = subscribe(({ enabled }) => {
        apply(enabled)
      })
    } catch {
      unsubscribe = undefined
    }
    return () => {
      cancelled = true
      try {
        unsubscribe?.()
      } catch {
        // Ignore teardown failures.
      }
    }
  }, [])
}
