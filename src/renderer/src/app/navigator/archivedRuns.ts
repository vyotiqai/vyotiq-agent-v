/**
 * Archived tasks: put out of the navigator's way without deleting anything.
 * Keys are `pinnedRunKey`s, kept in settings beside the pins.
 */

/** Settings cap — past it the oldest archive entries drop, and those tasks come back. */
export const ARCHIVED_RUNS_CAP = 500

/** Archive or unarchive a task; archiving beyond the cap drops the oldest entries. */
export function toggleArchivedRun(keys: readonly string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key].slice(-ARCHIVED_RUNS_CAP)
}

/**
 * Archive several tasks in one write. Returns the new list and how many of
 * the oldest entries the cap pushed out — those tasks come back into view.
 */
export function archiveRuns(
  keys: readonly string[],
  add: readonly string[]
): { next: string[]; added: string[]; dropped: number } {
  const have = new Set(keys)
  const added = [...new Set(add)].filter((key) => !have.has(key))
  const all = [...keys, ...added]
  const next = all.slice(-ARCHIVED_RUNS_CAP)
  return { next, added, dropped: all.length - next.length }
}
