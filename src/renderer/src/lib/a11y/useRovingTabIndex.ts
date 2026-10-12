import { useCallback, useRef, type KeyboardEvent, type RefCallback } from 'react'

export type RovingOrientation = 'vertical' | 'horizontal' | 'both'

function isNextKey(key: string, orientation: RovingOrientation): boolean {
  if (orientation === 'horizontal') return key === 'ArrowRight'
  if (orientation === 'vertical') return key === 'ArrowDown'
  return key === 'ArrowDown' || key === 'ArrowRight'
}

function isPrevKey(key: string, orientation: RovingOrientation): boolean {
  if (orientation === 'horizontal') return key === 'ArrowLeft'
  if (orientation === 'vertical') return key === 'ArrowUp'
  return key === 'ArrowUp' || key === 'ArrowLeft'
}

export function useRovingTabIndex({
  count,
  activeIndex,
  onActiveIndexChange,
  orientation = 'vertical',
  loop = true,
  onSelect
}: {
  count: number
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  orientation?: RovingOrientation
  loop?: boolean
  /** Called when arrow navigation should also update selection (e.g. radio groups). */
  onSelect?: (index: number) => void
}): {
  tabIndexFor: (index: number) => number
  setOptionRef: (index: number) => RefCallback<HTMLElement>
  onContainerKeyDown: (event: KeyboardEvent) => void
} {
  const refs = useRef<(HTMLElement | null)[]>([])

  const tabIndexFor = useCallback(
    (index: number): number => (index === activeIndex ? 0 : -1),
    [activeIndex]
  )

  const setOptionRef = useCallback(
    (index: number): RefCallback<HTMLElement> =>
      (el) => {
        refs.current[index] = el
      },
    []
  )

  const isDisabled = useCallback(
    (index: number): boolean => {
      const el = refs.current[index]
      if (!el) return true
      if (el.hasAttribute('disabled')) return true
      return el.getAttribute('aria-disabled') === 'true'
    },
    []
  )

  const focusIndex = useCallback(
    (index: number): boolean => {
      if (index < 0 || index >= count) return false
      const target = refs.current[index]
      if (!target || target.getAttribute('aria-disabled') === 'true' || target.hasAttribute('disabled')) return false
      target.focus()
      onActiveIndexChange(index)
      onSelect?.(index)
      return true
    },
    [count, onActiveIndexChange, onSelect]
  )

  const findFirstEnabled = useCallback((): number => {
    for (let i = 0; i < count; i += 1) {
      if (!isDisabled(i)) return i
    }
    return -1
  }, [count, isDisabled])

  const findLastEnabled = useCallback((): number => {
    for (let i = count - 1; i >= 0; i -= 1) {
      if (!isDisabled(i)) return i
    }
    return -1
  }, [count, isDisabled])

  const findNextEnabled = useCallback(
    (from: number, delta: 1 | -1): number => {
      if (count === 0) return -1
      if (loop) {
        for (let step = 1; step <= count; step += 1) {
          const cand = (from + delta * step + count * step) % count
          if (!isDisabled(cand)) return cand
        }
        return -1
      }
      let cand = from + delta
      while (cand >= 0 && cand < count) {
        if (!isDisabled(cand)) return cand
        cand += delta
      }
      return -1
    },
    [count, isDisabled, loop]
  )

  const onContainerKeyDown = useCallback(
    (event: KeyboardEvent): void => {
      if (count === 0) return
      if (event.key === 'Home') {
        const first = findFirstEnabled()
        if (first >= 0 && focusIndex(first)) event.preventDefault()
        return
      }
      if (event.key === 'End') {
        const last = findLastEnabled()
        if (last >= 0 && focusIndex(last)) event.preventDefault()
        return
      }
      const delta = isNextKey(event.key, orientation)
        ? 1
        : isPrevKey(event.key, orientation)
          ? -1
          : 0
      if (delta === 0) return
      const current = refs.current.findIndex((el) => el === document.activeElement)
      const origin = current >= 0 ? current : activeIndex
      if (origin < 0 || origin >= count) return
      if (!isDisabled(origin) && current < 0) {
        if (focusIndex(origin)) event.preventDefault()
        return
      }
      const next = findNextEnabled(origin, delta as 1 | -1)
      if (next >= 0 && focusIndex(next)) event.preventDefault()
    },
    [activeIndex, count, focusIndex, findFirstEnabled, findLastEnabled, findNextEnabled, isDisabled, orientation]
  )

  return { tabIndexFor, setOptionRef, onContainerKeyDown }
}
