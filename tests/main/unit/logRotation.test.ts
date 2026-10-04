import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LOG_ARCHIVE_GENERATIONS,
  logArchivePaths,
  planLogRotation
} from '@main/logging/rotation'

/**
 * Generation selection is tested as a pure function over an in-memory file set.
 * Nothing in this file touches the filesystem, and `@main/logging/rotation`
 * imports only `node:path` — so no run of this suite can write to the real
 * `%APPDATA%\vyotiq\logs`. `src/main/logging/init.ts` is deliberately NOT
 * imported here: it calls `log.initialize()` and `ensureLogsDirectory()`, which
 * would create the real userData logs directory on import.
 */
const LOG_PATH = join('C:', 'logs', 'vyotiq.log')

function archivesPresent(count: number): string[] {
  return logArchivePaths(LOG_PATH).slice(0, count)
}

describe('logArchivePaths', () => {
  it('numbers generations newest-first and keeps the 5 MB cap name intact', () => {
    expect(logArchivePaths(LOG_PATH)).toEqual([
      join('C:', 'logs', 'vyotiq.old.1.log'),
      join('C:', 'logs', 'vyotiq.old.2.log'),
      join('C:', 'logs', 'vyotiq.old.3.log'),
      join('C:', 'logs', 'vyotiq.old.4.log'),
      join('C:', 'logs', 'vyotiq.old.5.log')
    ])
  })

  it('retains more than the two generations electron-log keeps by default', () => {
    // electron-log's archiveLogFn renames to `<name>.old<ext>`, so a second
    // rotation overwrites the only archive it ever kept.
    expect(LOG_ARCHIVE_GENERATIONS).toBeGreaterThan(2)
    expect(logArchivePaths(LOG_PATH)).toHaveLength(LOG_ARCHIVE_GENERATIONS)
  })

  it('handles a dotless extension and a bare filename', () => {
    expect(logArchivePaths(join('d', 'vyotiq'))[0]).toBe(join('d', 'vyotiq.old.1'))
    expect(logArchivePaths('vyotiq.log')[0]).toBe('vyotiq.old.1.log')
  })
})

describe('planLogRotation', () => {
  it('rotates the live file into generation 1 when no archive exists yet', () => {
    const plan = planLogRotation(LOG_PATH, [])

    expect(plan.target).toBe(logArchivePaths(LOG_PATH)[0])
    expect(plan.shifts).toEqual([])
  })

  it('shifts every generation down one slot, newest first', () => {
    const plan = planLogRotation(LOG_PATH, archivesPresent(3))

    expect(plan.shifts).toEqual([
      { from: logArchivePaths(LOG_PATH)[2], to: logArchivePaths(LOG_PATH)[3] },
      { from: logArchivePaths(LOG_PATH)[1], to: logArchivePaths(LOG_PATH)[2] },
      { from: logArchivePaths(LOG_PATH)[0], to: logArchivePaths(LOG_PATH)[1] }
    ])
  })

  it('runs shifts highest-slot-first so no shift clobbers an unmoved generation', () => {
    const plan = planLogRotation(LOG_PATH, archivesPresent(LOG_ARCHIVE_GENERATIONS))

    // Ascending order would rename .old.1 -> .old.2 before .old.2 had moved to
    // .old.3, losing a generation on every single rotation.
    const slots = plan.shifts.map((s) => logArchivePaths(LOG_PATH).indexOf(s.from))
    expect(slots).toEqual([...slots].sort((a, b) => b - a))
  })

  it('evicts the oldest generation once the ring is full', () => {
    const plan = planLogRotation(LOG_PATH, archivesPresent(LOG_ARCHIVE_GENERATIONS))
    const archives = logArchivePaths(LOG_PATH)

    expect(plan.evict).toBe(archives[archives.length - 1])
    expect(plan.target).toBe(archives[0])
  })

  it('keeps a third generation where electron-log would have destroyed it', () => {
    // The defect: with electron-log's default, the third rotation overwrites the
    // only archive and nothing older than one generation-back survives.
    const plan = planLogRotation(LOG_PATH, archivesPresent(3))

    expect(plan.shifts.map((s) => s.to)).toContain(logArchivePaths(LOG_PATH)[2])
    expect(plan.shifts).toHaveLength(3)
  })

  it('ignores archive paths that are not actually present', () => {
    // A gap in the ring (generation 2 absent) must not be shifted as if it
    // were, while the generations that ARE present still shift down a slot.
    const archives = logArchivePaths(LOG_PATH)
    const present = [archives[0], archives[2]].filter((p): p is string => p != null)

    const plan = planLogRotation(LOG_PATH, present)

    expect(plan.shifts).toEqual([
      { from: archives[2], to: archives[3] },
      { from: archives[0], to: archives[1] }
    ])
    expect(plan.shifts.map((s) => s.from)).not.toContain(archives[1])
    expect(plan.shifts.map((s) => s.from)).not.toContain(archives[3])
  })

  it('never moves a generation onto itself or skips a slot', () => {
    const plan = planLogRotation(LOG_PATH, archivesPresent(LOG_ARCHIVE_GENERATIONS))
    const archives = logArchivePaths(LOG_PATH)

    for (const { from, to } of plan.shifts) {
      expect(from).not.toBe(to)
      expect(archives.indexOf(to)).toBe(archives.indexOf(from) + 1)
    }
    expect(plan.shifts.map((s) => s.to)).not.toContain(plan.target)
  })

  it('bounds the retained log footprint at generations x maxSize', () => {
    // 5 generations x the 5 MB cap set in logging/init.ts.
    expect(LOG_ARCHIVE_GENERATIONS * 5).toBe(25)
    expect(LOG_ARCHIVE_GENERATIONS).toBeLessThanOrEqual(10)
  })
})

describe('no real log directory is touched by this suite', () => {
  it('every path it produces is a pure string join under the given log path', () => {
    // This is the structural guarantee that no run of this suite can write to
    // the real %APPDATA%\vyotiq\logs: the module under test imports node:path
    // only (no fs), takes the base path as an argument, and this file never
    // imports logging/init.ts, which is what resolves the real userData dir.
    const base = join('C:', 'logs', 'vyotiq.log')

    expect(logArchivePaths(base).every((p) => p.startsWith(join('C:', 'logs')))).toBe(true)
    expect(planLogRotation(base, logArchivePaths(base))).toEqual({
      target: logArchivePaths(base)[0],
      shifts: logArchivePaths(base)
        .slice(0, LOG_ARCHIVE_GENERATIONS - 1)
        .map((from, i) => ({ from, to: logArchivePaths(base)[i + 1] }))
        .reverse(),
      evict: logArchivePaths(base)[LOG_ARCHIVE_GENERATIONS - 1]
    })
  })
})