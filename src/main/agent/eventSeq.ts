/**
 * One order for every agent event, persisted or live.
 *
 * Rows in events.jsonl and the events the renderer receives carry the same
 * `seq`, so a renderer that reloads a run from disk while it streams can tell
 * which of the events that arrived meanwhile the snapshot already holds.
 *
 * Microseconds since the epoch, bumped past the last value handed out: it only
 * grows within a process, and a later process starts past an earlier one's
 * values without reading anything back (it would take a thousand events every
 * millisecond, sustained, to run ahead of the clock). Well inside
 * `Number.MAX_SAFE_INTEGER` until the year 2255.
 */
let last = 0

export function nextEventSeq(): number {
  const floor = Date.now() * 1000
  last = last >= floor ? last + 1 : floor
  return last
}

/** Give an event its `seq` in place, once; the same object is then persisted and sent. */
export function stampEventSeq<T>(event: T): T {
  if (event && typeof event === 'object' && 'type' in event) {
    const row = event as { seq?: unknown }
    if (typeof row.seq !== 'number') row.seq = nextEventSeq()
  }
  return event
}
