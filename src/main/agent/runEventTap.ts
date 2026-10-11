/**
 * A read-only side channel for a run's events, for listeners in main that
 * need them as they happen, before IPC batching and UI gating (voice mode
 * speaks a reply even when its task isn't on screen; docs/voice-mode.md §7.3).
 *
 * A tap must never slow or break a run: listeners are called synchronously
 * with each event, and one that throws is dropped from that event silently.
 */
import type { AgentEvent } from '../../shared/ipc'

type Tap = (event: AgentEvent) => void

const taps = new Map<string, Set<Tap>>()

export function addRunEventTap(runId: string, tap: Tap): () => void {
  let set = taps.get(runId)
  if (!set) {
    set = new Set()
    taps.set(runId, set)
  }
  set.add(tap)
  return () => {
    const current = taps.get(runId)
    if (!current) return
    current.delete(tap)
    if (current.size === 0) taps.delete(runId)
  }
}

/** Called by the run loop's event pump for every event. */
export function tapRunEvent(event: AgentEvent): void {
  const set = taps.get(event.runId)
  if (!set) return
  for (const tap of [...set]) {
    try {
      tap(event)
    } catch {
      /* a listener's failure is its own */
    }
  }
}
