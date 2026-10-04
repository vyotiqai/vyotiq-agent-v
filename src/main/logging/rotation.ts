/**
 * Log rotation plan — pure, so the generation-selection logic is unit-testable
 * without touching the filesystem (it must never be exercised against the real
 * `%APPDATA%\vyotiq\logs`).
 *
 * electron-log's default `archiveLogFn`
 * (node_modules/electron-log/src/node/transports/file/index.js) renames the
 * live file to `<name>.old<ext>`, so every rotation overwrites the previous
 * archive and exactly two generations ever survive: the second rotation
 * destroys the generation before it. A support case that needs
 * yesterday-and-before was unrecoverable from disk. Keeping numbered
 * generations costs a bounded, constant amount of disk and is the only reason
 * this module exists.
 */
import { join, parse } from 'path'

/**
 * Rotated generations retained beside the live log. 5 x 5 MB caps the log
 * footprint at a constant 30 MB. Two would be the old electron-log default and
 * are the defect; anything unbounded would trade a logging bug for a disk bug.
 */
export const LOG_ARCHIVE_GENERATIONS = 5

/**
 * Archive paths for `logPath`, newest generation first:
 * `vyotiq.log` -> `vyotiq.old.1.log` … `vyotiq.old.5.log`.
 */
export function logArchivePaths(logPath: string): string[] {
  const { dir, name, ext } = parse(logPath)
  return Array.from(
    { length: LOG_ARCHIVE_GENERATIONS },
    (_unused, i) => join(dir, `${name}.old.${i + 1}${ext}`)
  )
}

export type LogRotationPlan = {
  /** Where the live file goes. */
  target: string
  /**
   * Renames to apply, in execution order. Highest generation first, so a
   * generation is moved out of the way before its successor's slot is reused —
   * ascending order would clobber generation N before moving it to N+1 and
   * silently lose a generation on every rotation.
   */
  shifts: Array<{ from: string; to: string }>
  /** Oldest generation, dropped to make room. */
  evict: string
}

/**
 * Plan one rotation. `existing` is the set of archive paths already on disk —
 * normally `logArchivePaths(logPath).filter(existsSync)` — in the same absolute
 * form. Pure: nothing here reads or writes the filesystem.
 */
export function planLogRotation(logPath: string, existing: readonly string[]): LogRotationPlan {
  const archives = logArchivePaths(logPath)
  const present = new Set(existing)
  const shifts: Array<{ from: string; to: string }> = []
  // Descending generation order — see LogRotationPlan.shifts.
  for (let i = archives.length - 2; i >= 0; i--) {
    const from = archives[i]
    const to = archives[i + 1]
    if (from == null || to == null) continue
    if (!present.has(from)) continue
    shifts.push({ from, to })
  }
  return {
    target: archives[0] as string,
    shifts,
    evict: archives[archives.length - 1] as string
  }
}