import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  beginWriteCheckpoint,
  finalizeWriteCheckpoint,
  resetWriteCheckpointsForTests,
  resolveWrites
} from '@main/agent/checkpoints'
import {
  applyWatchDiffToCheckpoint,
  diffSince,
  disposeWatch,
  setSnapshotFileCapForTests,
  startWatch
} from '@main/agent/workspaceMutationWatch'

/**
 * The snapshot walk stops at a file cap. Both walks (pre and post) stop at
 * their own boundary, so deleting a file before the boundary pulls a
 * previously-unseen file into the second walk's window. Classified `created`,
 * that pre-existing file is deleted by Undo.
 */
describe('workspaceMutationWatch under walk truncation', () => {
  let workspace: string
  let runDir: string

  beforeEach(() => {
    resetWriteCheckpointsForTests()
    setSnapshotFileCapForTests(4)
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-cap-ws-'))
    runDir = mkdtempSync(join(tmpdir(), 'vyotiq-cap-run-'))
  })

  afterEach(() => {
    setSnapshotFileCapForTests(null)
    resetWriteCheckpointsForTests()
    rmSync(workspace, { recursive: true, force: true })
    rmSync(runDir, { recursive: true, force: true })
  })

  it('never reports a pre-existing file beyond the cap as created', async () => {
    // Five pre-existing files; the cap admits only four.
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']) {
      writeFileSync(join(workspace, name), `${name}\n`, 'utf8')
    }
    beginWriteCheckpoint(runDir, workspace)
    const snap = await startWatch(workspace)
    // The step deletes one file inside the window; e.txt now fits.
    unlinkSync(join(workspace, 'a.txt'))

    const diff = await diffSince(snap)
    expect(diff.created).not.toContain('e.txt')

    await applyWatchDiffToCheckpoint(snap, diff, { runDir })
    await disposeWatch(snap)
    const meta = finalizeWriteCheckpoint(runDir)
    resolveWrites(runDir, workspace, { checkpointId: meta!.id, action: 'discard' })
    // Undo must not destroy a file the agent never created.
    expect(existsSync(join(workspace, 'e.txt'))).toBe(true)
  })

  it('never reports a still-present file beyond the cap as deleted', async () => {
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) {
      writeFileSync(join(workspace, name), `${name}\n`, 'utf8')
    }
    beginWriteCheckpoint(runDir, workspace)
    const snap = await startWatch(workspace)
    // A new file sorts ahead of d.txt and pushes it out of the second window.
    writeFileSync(join(workspace, 'aa-new.txt'), 'new\n', 'utf8')

    const diff = await diffSince(snap)
    expect(diff.deleted).not.toContain('d.txt')
  })

  it('still catches a modification inside the covered prefix while truncated', async () => {
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']) {
      writeFileSync(join(workspace, name), `${name}\n`, 'utf8')
    }
    const snap = await startWatch(workspace)
    // b.txt is inside both windows, so the walks stay comparable for it.
    writeFileSync(join(workspace, 'b.txt'), 'changed\n', 'utf8')
    const diff = await diffSince(snap)
    expect(diff.modified).toContain('b.txt')
  })

  it('still catches a genuine create while truncated', async () => {
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      writeFileSync(join(workspace, name), `${name}\n`, 'utf8')
    }
    const snap = await startWatch(workspace)
    writeFileSync(join(workspace, 'zz-made.txt'), 'made\n', 'utf8')
    const diff = await diffSince(snap)
    expect(diff.created).toContain('zz-made.txt')
  })
})
