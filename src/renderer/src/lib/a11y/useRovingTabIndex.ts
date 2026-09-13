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

  const focusIndex = useCallback(
    (index: number): void => {
      if (index < 0 || index >= count) return
      const target = refs.current[index]
      if (!target || target.getAttribute('aria-disabled') === 'true') return
      target.focus()
      onActiveIndexChange(index)
      onSelect?.(index)
    },
    [count, onActiveIndexChange, onSelect]
  )

  const onContainerKeyDown = useCallback(
    (event: KeyboardEvent): void => {
      if (count === 0) return
      if (event.key === 'Home') {
        event.preventDefault()
        focusIndex(0)
        return
      }
      if (event.key === 'End') {
        event.preventDefault()
        focusIndex(count - 1)
        return
      }
      const delta = isNextKey(event.key, orientation)
        ? 1
        : isPrevKey(event.key, orientation)
          ? -1
          : 0
      if (delta === 0) return
      const current = refs.current.findIndex((el) => el === document.activeElement)
      if (current < 0 && activeIndex >= 0) {
        event.preventDefault()
        focusIndex(activeIndex)
        return
      }
      if (current < 0) return
      event.preventDefault()
      let next = current + delta
      if (loop) {
        next = (next + count) % count
      } else {
        next = Math.max(0, Math.min(count - 1, next))
      }
      focusIndex(next)
    },
    [activeIndex, count, focusIndex, loop, orientation]
  )

  return { tabIndexFor, setOptionRef, onContainerKeyDown }
}
