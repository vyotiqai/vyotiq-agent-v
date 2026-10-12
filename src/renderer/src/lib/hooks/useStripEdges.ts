import { useEffect, useState, type RefObject } from 'react'

export type StripEdges = { start: boolean; end: boolean }

/**
 * Which ends of a sideways-scrolling strip hide items. A strip that fits is
 * kept at its start (a scroll left over from a narrower width cut "Changes"
 * to "anges" with room to spare), and the current item is kept in view as
 * it changes and as the strip resizes.
 *
 * `strip` finds the scroller inside `wrapRef` (omit it when the wrapper is the
 * scroller); `current` finds the item to keep in view.
 */
export function useStripEdges(
  wrapRef: RefObject<HTMLElement | null>,
  active: string,
  { strip: stripSelector, current: currentSelector }: { strip?: string; current: string }
): StripEdges {
  const [edges, setEdges] = useState<StripEdges>({ start: false, end: false })
  useEffect(() => {
    const wrap = wrapRef.current
    const strip = stripSelector ? wrap?.querySelector<HTMLElement>(stripSelector) : wrap
    if (!strip) return
    const sync = (): void => {
      if (strip.scrollWidth <= strip.clientWidth + 1) strip.scrollLeft = 0
      const start = strip.scrollLeft > 1
      const end = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1
      setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }))
    }
    const reveal = (): void => {
      const current = strip.querySelector<HTMLElement>(currentSelector)
      if (!current) return
      const box = strip.getBoundingClientRect()
      const at = current.getBoundingClientRect()
      // Clear of the fade, unless the strip is too narrow to spare it.
      const margin = Math.max(0, Math.min(20, (box.width - at.width) / 2))
      if (at.left < box.left) strip.scrollLeft -= box.left - at.left + margin
      else if (at.right > box.right) strip.scrollLeft += at.right - box.right + margin
    }
    reveal()
    sync()
    // A resize can push the current item out (a narrower pane, the inspector
    // opening); a scroll is the reader looking, so it only moves the fades.
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            reveal()
            sync()
          })
    observer?.observe(strip)
    strip.addEventListener('scroll', sync, { passive: true })
    return () => {
      observer?.disconnect()
      strip.removeEventListener('scroll', sync)
    }
  }, [wrapRef, active, stripSelector, currentSelector])
  return edges
}

/** The fade for whichever ends hide items — one class, never two. */
export function stripEdgeMask(edges: StripEdges): string {
  return edges.start && edges.end ? 'mask-fade-x' : edges.start ? 'mask-fade-start' : edges.end ? 'mask-fade-end' : ''
}
