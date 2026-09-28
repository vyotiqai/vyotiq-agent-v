import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const { renameFaults } = vi.hoisted(() => ({
  /** Paths whose next rename fails with EPERM (a reader holding the file on Windows). */
  renameFaults: new Set<string>()
}))

vi.mock('@main/storage/atomicWrite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/storage/atomicWrite')>()
  return {
    ...actual,
    renameWithRetry: async (from: string, to: string) => {
      if (renameFaults.delete(to)) {
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}'`), {
          code: 'EPERM'
        })
      }
      return actual.renameWithRetry(from, to)
    }
  }
})

import { appendToRunLog, resetRunLogStateForTests } from '@main/agent/jsonlRotation'

const line = (n: number): string => `${JSON.stringify({ n, pad: 'x'.repeat(40) })}\n`

describe('run log append + rotation', () => {
  let dir: string
  let path: string
  let archiveSeq: number

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-runlog-'))
    path = join(dir, 'log.jsonl')
    archiveSeq = 0
    renameFaults.clear()
    resetRunLogStateForTests()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const append = (data: string, extra?: { onRotateFailed?: (err: unknown) => void }) =>
    appendToRunLog({
      path,
      data,
      maxBytes: 300,
      keepBytes: 150,
      nextArchivePath: () => join(dir, `log.archive.${String(++archiveSeq).padStart(3, '0')}.jsonl`),
      ...extra
    })

  /** Every record, archives first, in order. */
  function stitched(): number[] {
    const files = readdirSync(dir)
      .filter((name) => name.startsWith('log.archive.') && name.endsWith('.jsonl'))
      .sort()
      .concat('log.jsonl')
    return files.flatMap((name) =>
      readFileSync(join(dir, name), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((raw) => (JSON.parse(raw) as { n: number }).n)
    )
  }

  it('rotates on a line boundary and keeps every record across archives', async () => {
    for (let i = 0; i < 40; i++) await append(line(i))
    expect(stitched()).toEqual(Array.from({ length: 40 }, (_, i) => i))
    const archives = readdirSync(dir).filter((name) => name.startsWith('log.archive.'))
    // No eviction: every rotation's archive is still there.
    expect(archives.length).toBeGreaterThan(5)
    expect(readdirSync(dir).some((name) => name.endsWith('.tmp'))).toBe(false)
  })

  // The Windows failure: renaming the tail over a live file another reader has
  // open throws EPERM. It used to drop the record being appended and leave the
  // head both archived and live, so stitched history showed it twice.
  it('keeps the record and the log intact when the live swap fails', async () => {
    for (let i = 0; i < 6; i++) await append(line(i))
    renameFaults.add(path)
    const failures: unknown[] = []
    await append(line(6), { onRotateFailed: (err) => failures.push(err) })

    expect(failures).toHaveLength(1)
    expect(stitched()).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(readdirSync(dir).filter((name) => name !== 'log.jsonl')).toEqual([])
  })

  it('backs off after a failed rotation instead of retrying it on every append', async () => {
    for (let i = 0; i < 6; i++) await append(line(i))
    renameFaults.add(path)
    const failures: unknown[] = []
    for (let i = 6; i < 10; i++) await append(line(i), { onRotateFailed: (err) => failures.push(err) })
    expect(failures).toHaveLength(1)
    expect(stitched()).toEqual(Array.from({ length: 10 }, (_, i) => i))
  })

  it('starts a new record on its own line after a torn final line', async () => {
    writeFileSync(path, `${line(0)}{"n":1,"pad":"tor`)
    await append(line(2))
    await append(line(3))
    const rows = readFileSync(path, 'utf8').split('\n').filter(Boolean)
    expect(rows).toHaveLength(4)
    expect(JSON.parse(rows[2]!)).toMatchObject({ n: 2 })
    expect(JSON.parse(rows[3]!)).toMatchObject({ n: 3 })
  })

  it('adds no separator to a clean file', async () => {
    await append(line(0))
    await append(line(1))
    expect(readFileSync(path, 'utf8')).toBe(line(0) + line(1))
  })
})
