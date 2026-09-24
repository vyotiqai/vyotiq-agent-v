import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  beginWriteCheckpoint,
  finalizeWriteCheckpoint,
  planRewindWritesAcrossRuns,
  resetWriteCheckpointsForTests,
  rewindWritesFrom
} from '@main/agent/checkpoints'

let workspace: string
let runDir: string

const read = (name: string): string => readFileSync(join(workspace, name), 'utf8')
const write = (name: string, text: string): void => writeFileSync(join(workspace, name), text, 'utf8')

beforeEach(() => {
  resetWriteCheckpointsForTests()
  workspace = mkdtempSync(join(tmpdir(), 'vyotiq-rw-once-ws-'))
  runDir = mkdtempSync(join(tmpdir(), 'vyotiq-rw-once-run-'))
  write('a.txt', 'a0\n')
  write('b.txt', 'b0\n')
})

afterEach(() => {
  resetWriteCheckpointsForTests()
  rmSync(workspace, { recursive: true, force: true })
  rmSync(runDir, { recursive: true, force: true })
})

/** What the rewind dialog offers to put back, from main's preview. */
function offered(): string[] {
  const plan = planRewindWritesAcrossRuns([{ runDir, selection: 'anchored' }], 0, workspace)
  return plan.files.filter((f) => f.undoable && !f.edited).map((f) => f.path)
}

/**
 * The run answering message 0 changes a.txt; the run answering message 2
 * changes it again, and b.txt. `between` runs after the first.
 */
async function twoRunsChangeA(between?: () => void): Promise<void> {
  const first = beginWriteCheckpoint(runDir, workspace, 0)
  await first.recordPrior('a.txt', 'write')
  write('a.txt', 'a1\n')
  finalizeWriteCheckpoint(runDir)
  between?.()
  const second = beginWriteCheckpoint(runDir, workspace, 2)
  await second.recordPrior('a.txt', 'write')
  await second.recordPrior('b.txt', 'write')
  write('a.txt', 'a2\n')
  write('b.txt', 'b2\n')
  finalizeWriteCheckpoint(runDir)
}

describe('rewinding runs that changed the same file', () => {
  it('counts each file once, as the preview does', async () => {
    await twoRunsChangeA()
    const dialog = offered()
    expect(dialog).toEqual(['a.txt', 'b.txt'])

    const result = rewindWritesFrom(runDir, workspace, 0)

    // Newest first. a.txt used to be listed once per run that changed it, so
    // the dialog said "Rewind 2 files" and the toast "3 files restored".
    expect(result.restored).toEqual(['b.txt', 'a.txt'])
    expect([...result.restored].sort()).toEqual(dialog)
    expect(read('a.txt')).toBe('a0\n')
    expect(read('b.txt')).toBe('b0\n')
  })

  it('reports a file you changed between the runs as left as you changed it, not also restored', async () => {
    await twoRunsChangeA(() => write('a.txt', 'mine\n'))

    const result = rewindWritesFrom(runDir, workspace, 0)

    // The second run's change comes off and yours stays, so a.txt is not
    // back to how it was before the first run.
    expect(read('a.txt')).toBe('mine\n')
    expect(read('b.txt')).toBe('b0\n')
    expect(result.restored).toEqual(['b.txt'])
    expect(result.edited).toEqual(['a.txt'])
  })

  it('reports a file the later run changed without a copy as not restored, and nothing else', async () => {
    const first = beginWriteCheckpoint(runDir, workspace, 0)
    await first.recordPrior('a.txt', 'write')
    write('a.txt', 'a1\n')
    finalizeWriteCheckpoint(runDir)
    // A command in the second run rewrote a.txt, and no copy was kept.
    const second = beginWriteCheckpoint(runDir, workspace, 2)
    write('a.txt', 'a2\n')
    await second.recordObservedMutation('a.txt', 'modified')
    finalizeWriteCheckpoint(runDir)

    const result = rewindWritesFrom(runDir, workspace, 0)

    // The first run's restore then finds a.txt changed since its write. That
    // used to list it as changed by you as well, for a file only the task touched.
    expect(read('a.txt')).toBe('a2\n')
    expect(result.skipped).toEqual(['a.txt'])
    expect(result.edited).toEqual([])
    expect(result.restored).toEqual([])
  })

  it('lists a file neither run kept a copy of once', async () => {
    for (const [anchor, text] of [[0, 'b1\n'], [2, 'b2\n']] as const) {
      const cp = beginWriteCheckpoint(runDir, workspace, anchor)
      write('b.txt', text)
      await cp.recordObservedMutation('b.txt', 'modified')
      finalizeWriteCheckpoint(runDir)
    }

    expect(rewindWritesFrom(runDir, workspace, 0).skipped).toEqual(['b.txt'])
  })
})
