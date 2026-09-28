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
