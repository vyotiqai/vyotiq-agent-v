import { useCallback, useEffect, useRef } from 'react'
import { focusComposerMessage } from '@renderer/lib/shortcuts'

/** Attempts after the first one, a macrotask apart. */
const FOCUS_RETRIES = 10

/**
 * Focus the composer once it mounts. A view switch, or a workspace switch whose
 * IPC runs first, renders the composer a few ticks later, so a single attempt
 * is too early (the AppShell search-focus pattern). One retry chain at a time,
 * and it stops when the caller unmounts: a chain still queued when App went
 * away fired into a torn-down document (a ReferenceError in
 * tests/renderer/app/appSetup on a CI runner).
 */
export function useFocusComposerSoon(): () => void {
  const timerRef = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = null
    },
    []
  )
  return useCallback((): void => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    let attempts = 0
    const tryFocus = (): void => {
      timerRef.current = null
      if (focusComposerMessage()) return
      if (attempts++ < FOCUS_RETRIES) timerRef.current = window.setTimeout(tryFocus, 0)
    }
    timerRef.current = window.setTimeout(tryFocus, 0)
  }, [])
}
