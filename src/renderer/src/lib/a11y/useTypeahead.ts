import { useCallback, useRef } from 'react'

/** Idle gap after which the typeahead buffer resets. */
export const TYPEAHEAD_RESET_MS = 800

/**
 * Shared menu typeahead: accumulates printable characters into a prefix
 * buffer that resets after ~800ms of idle time. A buffer of one repeated
 * character cycles through the labels starting with that character instead
 * of searching for the doubled prefix ("pp" still matches "Project").
 */
export function useTypeahead({ resetMs = TYPEAHEAD_RESET_MS }: { resetMs?: number } = {}): {
  search: (char: string, labels: readonly string[], activePos?: number) => number
  reset: () => void
} {
  const bufferRef = useRef('')
  const lastTimeRef = useRef(0)

  const reset = useCallback((): void => {
    bufferRef.current = ''
    lastTimeRef.current = 0
  }, [])

  const search = useCallback(
    (char: string, labels: readonly string[], activePos = -1): number => {
      if (char.length !== 1) return -1
      const now = Date.now()
      if (now - lastTimeRef.current > resetMs) bufferRef.current = ''
      lastTimeRef.current = now
      const lower = char.toLowerCase()
      const nextBuffer = bufferRef.current + lower
      const isRepeat = [...nextBuffer].every((c) => c === lower)
      if (isRepeat) {
        bufferRef.current = lower
        const matches: number[] = []
        for (let i = 0; i < labels.length; i += 1) {
          if (labels[i]!.toLowerCase().startsWith(lower)) matches.push(i)
        }
        if (matches.length === 0) return -1
        for (const m of matches) {
          if (m > activePos) return m
        }
        return matches[0]!
      }
      bufferRef.current = nextBuffer
      for (let i = 0; i < labels.length; i += 1) {
        if (labels[i]!.toLowerCase().startsWith(bufferRef.current)) return i
      }
      return -1
    },
    [resetMs]
  )

  return { search, reset }
}

/** True for a printable typeahead key (single char, no modifiers). */
export function isTypeaheadKey(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): boolean {
  if (e.key.length !== 1) return false
  if (e.ctrlKey || e.metaKey || e.altKey) return false
  return true
}
