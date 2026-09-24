import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  beginWriteCheckpoint,
  finalizeWriteCheckpoint,
  getWriteCheckpointMeta,
  planRewindWritesAcrossRuns,
  resetWriteCheckpointsForTests,
  rewindWritesFrom,
  type RewindWritesPlan,
  type RewindWritesPlanFile,
  type RewindWritesResult
} from '@main/agent/checkpoints'

let workspace: string
let runDir: string

const read = (name: string): string => readFileSync(join(workspace, name), 'utf8')
const write = (name: string, text: string): void => writeFileSync(join(workspace, name), text, 'utf8')

beforeEach(() => {
  resetWriteCheckpointsForTests()
  workspace = mkdtempSync(join(tmpdir(), 'vyotiq-rw-walk-ws-'))
  runDir = mkdtempSync(join(tmpdir(), 'vyotiq-rw-walk-run-'))
  write('a.txt', 'a0\n')
  write('b.txt', 'b0\n')
})

afterEach(() => {
  resetWriteCheckpointsForTests()
  rmSync(workspace, { recursive: true, force: true })
  rmSync(runDir, { recursive: true, force: true })
})

type Where = Pick<RewindWritesResult, 'restored' | 'skipped' | 'edited'>

/** What the Rewind dialog shows for a rewind to message 0. */
const preview = (): RewindWritesPlan => planRewindWritesAcrossRuns([{ runDir, selection: 'anchored' }], 0, workspace)

/** Where the preview says the rewind leaves each file, in the result's terms. */
function foreseen(plan: RewindWritesPlan): Where {
  const where = (f: RewindWritesPlanFile): keyof Where => (f.edited ? 'edited' : f.undoable ? 'restored' : 'skipped')
  const of = (kind: keyof Where): string[] => plan.files.filter((f) => where(f) === kind).map((f) => f.path).sort()
  return { restored: of('restored'), skipped: of('skipped'), edited: of('edited') }
}

/** Rewind to message 0: where it left each file. */
function rewind(): Where {
  const result = rewindWritesFrom(runDir, workspace, 0)
  expect(result.undoableRestoreFailed).toBe(false)
  return { restored: [...result.restored].sort(), skipped: [...result.skipped].sort(), edited: [...result.edited].sort() }
}

describe('how far a rewind takes a file back', () => {
  it('keeps your edit under a run that crashed before its checkpoint was finalized', async () => {
    // The run answering message 0 writes a.txt, and the app dies mid-turn:
    // the copy is on disk, but no hash of what the run wrote.
    const crashed = beginWriteCheckpoint(runDir, workspace, 0)
    await crashed.recordPrior('a.txt', 'write')
    write('a.txt', 'a1\n')
    resetWriteCheckpointsForTests()
    expect(getWriteCheckpointMeta(runDir, crashed.id)?.files).toEqual([
      { path: 'a.txt', action: 'modified', undoable: true }
    ])
    const later = beginWriteCheckpoint(runDir, workspace, 2)
    await later.recordPrior('a.txt', 'write')
    write('a.txt', 'a2\n')
    finalizeWriteCheckpoint(runDir)
    write('a.txt', 'mine\n')

    const plan = preview()
    expect(plan.files).toEqual([{ path: 'a.txt', action: 'modified', undoable: true, edited: true }])
    const done = rewind()

    // The dialog said "changed since · left as is". The crashed run's copy
    // then went back over the edit with nothing to check it against, and
    // the toast called a.txt restored.
    expect(read('a.txt')).toBe('mine\n')
    expect(done).toEqual({ restored: [], skipped: [], edited: ['a.txt'] })
    expect(done).toEqual(foreseen(plan))
    const meta = getWriteCheckpointMeta(runDir, crashed.id)
    expect(meta?.resolved).toBe(true)
    expect(meta?.files[0]?.resolved).toBe('kept')
  })

  it('keeps a file a later run changed without a copy, whatever an older run could put back', async () => {
    // The run answering message 0 creates new.txt and crashes: nothing
    // records what it wrote, so its restore would delete the file unchecked.
    const crashed = beginWriteCheckpoint(runDir, workspace, 0)
    await crashed.recordPrior('new.txt', 'write')
    write('new.txt', 'n1\n')
    resetWriteCheckpointsForTests()
    // A command in the next run rewrites it, and no copy is kept.
    const later = beginWriteCheckpoint(runDir, workspace, 2)
    write('new.txt', 'n2\n')
    await later.recordObservedMutation('new.txt', 'modified')
    finalizeWriteCheckpoint(runDir)

    const plan = preview()
    expect(plan.files).toEqual([{ path: 'new.txt', action: 'modified', undoable: false }])
    const done = rewind()

    // "no copy kept · left as is", and the file used to be deleted.
    expect(read('new.txt')).toBe('n2\n')
    expect(done).toEqual({ restored: [], skipped: ['new.txt'], edited: [] })
    expect(done).toEqual(foreseen(plan))
  })

  it('still takes a file back past a write with no copy where that destroys nothing', async () => {
    const first = beginWriteCheckpoint(runDir, workspace, 0)
    await first.recordPrior('a.txt', 'write')
    await first.recordPrior('b.txt', 'write')
    write('a.txt', 'a1\n')
    write('b.txt', 'b1\n')
    finalizeWriteCheckpoint(runDir)
    // Commands in the next run delete a.txt and rewrite b.txt byte for byte,
    // and neither keeps a copy.
    const later = beginWriteCheckpoint(runDir, workspace, 2)
    unlinkSync(join(workspace, 'a.txt'))
    await later.recordObservedMutation('a.txt', 'deleted')
    write('b.txt', 'b1\n')
    await later.recordObservedMutation('b.txt', 'modified')
    finalizeWriteCheckpoint(runDir)

    const plan = preview()
    // The dialog used to say "no copy kept · left as is" for both.
    expect(plan.files).toEqual([
      { path: 'a.txt', action: 'deleted', undoable: true },
      { path: 'b.txt', action: 'modified', undoable: true }
    ])
    const done = rewind()

    expect(read('a.txt')).toBe('a0\n')
    expect(read('b.txt')).toBe('b0\n')
    expect(done).toEqual({ restored: ['a.txt', 'b.txt'], skipped: [], edited: [] })
    expect(done).toEqual(foreseen(plan))
  })
})

describe('the rewind preview walks each file as the rewind does', () => {
  it('says a file you changed between two runs goes back only partway', async () => {
    const first = beginWriteCheckpoint(runDir, workspace, 0)
    await first.recordPrior('a.txt', 'write')
    write('a.txt', 'a1\n')
    finalizeWriteCheckpoint(runDir)
    write('a.txt', 'mine\n')
    const second = beginWriteCheckpoint(runDir, workspace, 2)
    await second.recordPrior('a.txt', 'write')
    await second.recordPrior('b.txt', 'write')
    write('a.txt', 'a2\n')
    write('b.txt', 'b2\n')
    finalizeWriteCheckpoint(runDir)

    const plan = preview()
    // Judged by the second run alone, a.txt was offered as going back, and
    // the dialog said "Rewind 2 files" for a rewind that restores one.
    expect(plan.files).toEqual([
      { path: 'a.txt', action: 'modified', undoable: true, edited: true, partway: true },
      { path: 'b.txt', action: 'modified', undoable: true }
    ])
    expect(read('a.txt')).toBe('a2\n')
    const done = rewind()

    // The second run's write comes off, and yours stays.
    expect(read('a.txt')).toBe('mine\n')
    expect(read('b.txt')).toBe('b0\n')
    expect(done).toEqual(foreseen(plan))
  })

  it('says a file goes back partway, to a write that kept no copy', async () => {
    // A command in the first run rewrites a.txt, and no copy is kept.
    const first = beginWriteCheckpoint(runDir, workspace, 0)
    write('a.txt', 'a1\n')
    await first.recordObservedMutation('a.txt', 'modified')
    finalizeWriteCheckpoint(runDir)
    const second = beginWriteCheckpoint(runDir, workspace, 2)
    await second.recordPrior('a.txt', 'write')
    write('a.txt', 'a2\n')
    finalizeWriteCheckpoint(runDir)

    const plan = preview()
    expect(plan.files).toEqual([{ path: 'a.txt', action: 'modified', undoable: false, partway: true }])
    const done = rewind()

    expect(read('a.txt')).toBe('a1\n')
    expect(done).toEqual({ restored: [], skipped: ['a.txt'], edited: [] })
    expect(done).toEqual(foreseen(plan))
  })

  it('letters each file by what the rewind undoes across the runs', async () => {
    // The first run creates c.txt and deletes b.txt; the second changes
    // c.txt and writes a new b.txt.
    const first = beginWriteCheckpoint(runDir, workspace, 0)
    await first.recordPrior('c.txt', 'write')
    write('c.txt', 'c1\n')
    await first.recordPrior('b.txt', 'delete')
    unlinkSync(join(workspace, 'b.txt'))
    finalizeWriteCheckpoint(runDir)
    const second = beginWriteCheckpoint(runDir, workspace, 2)
    await second.recordPrior('c.txt', 'write')
    write('c.txt', 'c2\n')
    await second.recordPrior('b.txt', 'write')
    write('b.txt', 'b2\n')
    finalizeWriteCheckpoint(runDir)

    const plan = preview()
    // By the second run alone, b.txt read A (removed) and c.txt M (put back).
    expect(plan.files).toEqual([
      { path: 'b.txt', action: 'modified', undoable: true },
      { path: 'c.txt', action: 'created', undoable: true }
    ])
    const done = rewind()

    expect(read('b.txt')).toBe('b0\n')
    expect(existsSync(join(workspace, 'c.txt'))).toBe(false)
    expect(done).toEqual({ restored: ['b.txt', 'c.txt'], skipped: [], edited: [] })
    expect(done).toEqual(foreseen(plan))
  })
})
