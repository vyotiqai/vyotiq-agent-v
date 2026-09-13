import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TranscriptRow } from '../utils/transcriptRows'

/** Band must show at least this many CSS pixels to count as on-screen. */
export const TASKS_ANCHOR_MIN_VISIBLE_PX = 24

/** Row index of the task-owning user prompt, or null when absent. */
export function resolveTasksAnchorRowIndex(
  displayRows: readonly TranscriptRow[],
  tasksAnchorUserId: string | null
): number | null {
  if (!tasksAnchorUserId) return null
  const idx = displayRows.findIndex(
    (row) => row.kind === 'user' && row.item.id === tasksAnchorUserId
  )
  return idx < 0 ? null : idx
}

/** Whether `element` overlaps the scrollport of `root` by a usable amount. */
export function isElementVisibleInRoot(
  element: HTMLElement,
  root: HTMLElement,
  minVisiblePx = TASKS_ANCHOR_MIN_VISIBLE_PX
): boolean {
  const rootRect = root.getBoundingClientRect()
  const rect = element.getBoundingClientRect()
  const visiblePx =
    Math.min(rect.bottom, rootRect.bottom) - Math.max(rect.top, rootRect.top)
  return visiblePx >= Math.min(minVisiblePx, rect.height)
}

/**
 * Whether the inline tasks ceiling band is visible. Prefer band DOM geometry
 * whenever the band is mounted; otherwise the strip is off-screen.
 */
export function measureTasksAnchorVisible(root: HTMLElement | null): boolean {
  if (!root) return true
  const band = root.querySelector('[data-tasks-ceiling]')
  if (band instanceof HTMLElement) {
    return isElementVisibleInRoot(band, root)
  }
  return false
}

/**
 * Tracks whether the inline tasks ceiling band is visible in the transcript
 * scrollport. Uses band DOM geometry when mounted; scroll unmounts virtualized
 * rows so a scroll listener is enough (no MutationObserver on the transcript).
 */
export function useTasksAnchorVisible(opts: {
  containerRef: React.RefObject<HTMLDivElement | null>
  displayRows: readonly TranscriptRow[]
  tasksAnchorUserId: string | null
}): boolean {
  const { containerRef, displayRows, tasksAnchorUserId } = opts

  const anchorRowIndex = useMemo(
    () => resolveTasksAnchorRowIndex(displayRows, tasksAnchorUserId),
    [displayRows, tasksAnchorUserId]
  )

  const [anchorVisible, setAnchorVisible] = useState(true)
  const rafRef = useRef<number | null>(null)

  const measure = useCallback(() => {
    if (anchorRowIndex == null) {
      setAnchorVisible(false)
      return
    }
    setAnchorVisible(measureTasksAnchorVisible(containerRef.current))
  }, [anchorRowIndex, containerRef])

  const scheduleMeasure = useCallback(() => {
    if (rafRef.current != null) return
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null
      measure()
    })
  }, [measure])

  useEffect(() => {
    measure()
  }, [measure, displayRows])

  useEffect(() => {
    const root = containerRef.current
    if (!root || anchorRowIndex == null) return

    root.addEventListener('scroll', scheduleMeasure, { passive: true })
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(scheduleMeasure) : null
    ro?.observe(root)

    return () => {
      root.removeEventListener('scroll', scheduleMeasure)
      ro?.disconnect()
      if (rafRef.current != null) {
        window.cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [anchorRowIndex, containerRef, scheduleMeasure])

  return anchorVisible
}
