import { useCallback, useEffect, useRef } from 'react'
import type { AppView } from './viewReturn'

/** Where the window was: a view, and for the task view the task in front. */
export type NavLocation = { view: AppView; workspacePath: string | null; runId: string | null }

/** Steps kept; the oldest go first. */
const HISTORY_CAP = 50

function sameLocation(a: NavLocation, b: NavLocation): boolean {
  return a.view === b.view && a.workspacePath === b.workspacePath && a.runId === b.runId
}

/** A history step: the trail of places and where in it the window stands. */
export type NavTrail = { entries: NavLocation[]; index: number }

/** Record a move to `next`: forward steps are dropped, a repeat is not a step. */
export function recordNav(trail: NavTrail, next: NavLocation): NavTrail {
  const here = trail.entries[trail.index]
  if (here && sameLocation(here, next)) return trail
  const entries = [...trail.entries.slice(0, trail.index + 1), next].slice(-HISTORY_CAP)
  return { entries, index: entries.length - 1 }
}

/**
 * Back and Forward across views and tasks (Alt ← / Alt →, and a mouse's own
 * buttons). Every move the window makes is recorded; a move made by stepping
 * through the history is not recorded again, so Forward stays available.
 */
export function useNavHistory(
  location: NavLocation,
  go: (target: NavLocation) => void
): { back: () => void; forward: () => void } {
  const trail = useRef<NavTrail>({ entries: [], index: -1 })
  /** The place a step is heading to; arriving there is not a new move. */
  const stepping = useRef<NavLocation | null>(null)

  useEffect(() => {
    if (stepping.current && sameLocation(stepping.current, location)) {
      stepping.current = null
      return
    }
    stepping.current = null
    trail.current = recordNav(trail.current, location)
  }, [location])

  const step = useCallback(
    (delta: -1 | 1) => {
      const { entries, index } = trail.current
      const nextIndex = index + delta
      const target = entries[nextIndex]
      if (!target) return
      trail.current = { entries, index: nextIndex }
      stepping.current = target
      go(target)
    },
    [go]
  )

  const back = useCallback(() => step(-1), [step])
  const forward = useCallback(() => step(1), [step])

  // A mouse's back and forward buttons, anywhere in the window.
  useEffect(() => {
    const onMouseUp = (e: MouseEvent): void => {
      if (e.button === 3) {
        e.preventDefault()
        back()
      } else if (e.button === 4) {
        e.preventDefault()
        forward()
      }
    }
    window.addEventListener('mouseup', onMouseUp)
    return () => window.removeEventListener('mouseup', onMouseUp)
  }, [back, forward])

  return { back, forward }
}
