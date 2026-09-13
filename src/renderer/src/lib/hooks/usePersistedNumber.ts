import { useCallback, useRef, useState } from 'react'

/** Persist a finite number in localStorage; falls back to `initial` when missing/invalid. */
export function usePersistedNumber(
  key: string,
  initial: number,
  clamp?: (n: number) => number
): [number, (next: number | ((prev: number) => number)) => void] {
  const clampRef = useRef(clamp ?? ((n: number) => n))
  clampRef.current = clamp ?? ((n: number) => n)

  const [value, setValue] = useState(() => {
    const clampFn = clampRef.current
    try {
      const raw = localStorage.getItem(key)
      if (raw != null && raw !== '') {
        const parsed = Number(raw)
        if (Number.isFinite(parsed)) return clampFn(parsed)
      }
    } catch {
      /* private mode / blocked storage */
    }
    return clampFn(initial)
  })
  const valueRef = useRef(value)
  valueRef.current = value

  const setPersisted = useCallback(
    (next: number | ((prev: number) => number)) => {
      const resolved = clampRef.current(
        typeof next === 'function' ? next(valueRef.current) : next
      )
      if (Object.is(valueRef.current, resolved)) return
      valueRef.current = resolved
      setValue(resolved)
      try {
        localStorage.setItem(key, String(resolved))
      } catch {
        /* ignore */
      }
    },
    [key]
  )

  return [value, setPersisted]
}
