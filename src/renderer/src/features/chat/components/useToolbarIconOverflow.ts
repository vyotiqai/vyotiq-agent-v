import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

/** `size-7` quick-launch slots in the dock titlebar. */
export const DOCK_TOOLBAR_ICON_SLOT_PX = 28
export const DOCK_TOOLBAR_ICON_GAP_PX = 2

function rowWidth(iconCount: number, gapPx: number, slotPx: number): number {
  if (iconCount <= 0) return 0
  return iconCount * slotPx + Math.max(0, iconCount - 1) * gapPx
}

/** How many leading icons fit before an overflow affordance is required. */
export function toolbarVisibleIconCount(
  width: number,
  total: number,
  slotPx = DOCK_TOOLBAR_ICON_SLOT_PX,
  gapPx = DOCK_TOOLBAR_ICON_GAP_PX
): number {
  if (total <= 0 || width <= 0) return 0
  if (width >= rowWidth(total, gapPx, slotPx)) return total

  for (let visible = total - 1; visible >= 0; visible -= 1) {
    const used =
      rowWidth(visible, gapPx, slotPx) +
      (visible > 0 ? gapPx : 0) +
      slotPx
    if (width >= used) return visible
  }
  return 0
}

export function useToolbarIconOverflow(
  itemCount: number,
  slotPx = DOCK_TOOLBAR_ICON_SLOT_PX,
  gapPx = DOCK_TOOLBAR_ICON_GAP_PX
): { ref: RefObject<HTMLDivElement | null>; visibleCount: number } {
  const ref = useRef<HTMLDivElement>(null)
  const [visibleCount, setVisibleCount] = useState(itemCount)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return

    const measure = (): void => {
      const width = el.clientWidth
      if (width <= 0) return
      setVisibleCount(toolbarVisibleIconCount(width, itemCount, slotPx, gapPx))
    }

    measure()

    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [gapPx, itemCount, slotPx])

  return { ref, visibleCount }
}
