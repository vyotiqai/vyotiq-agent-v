import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  mkdirSync
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null
}))

// A restore that fails partway. The fs builtin namespace is frozen in ESM, so
// a hoisted module mock with a test-controlled route is the repo pattern
// (editTools.test.ts). Unrouted calls go straight through.
const { fsRoute } = vi.hoisted(() => ({
  fsRoute: {
    /** Fail the copy whose source ends with this — a restore from a checkpoint copy. */
    failCopyFrom: null as string | null,
    code: 'EBUSY',
    /** What the failing copy leaves at its destination first, as a full disk does. */
    partial: null as string | null,
    /** Each copy and removal, by the name of the file it wrote or removed. */
    ops: [] as string[]
  }
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const name = (p: import('fs').PathLike): string => String(p).split(/[\\/]/).pop() ?? ''
  return {
    ...actual,
    copyFileSync: (src: import('fs').PathLike, dest: import('fs').PathLike, mode?: number): void => {
      fsRoute.ops.push(`copy ${name(dest)}`)
      if (fsRoute.failCopyFrom != null && String(src).replace(/\\/g, '/').endsWith(fsRoute.failCopyFrom)) {
        if (fsRoute.partial != null) actual.writeFileSync(dest, fsRoute.partial)
        throw Object.assign(new Error(`${fsRoute.code}: simulated, copyfile`), { code: fsRoute.code })
      }
      actual.copyFileSync(src, dest, mode)
    },
    rmSync: (path: import('fs').PathLike, options?: import('fs').RmOptions): void => {
      fsRoute.ops.push(`rm ${name(path)}`)
      actual.rmSync(path, options)
    }
  }
})

import {
  beginWriteCheckpoint,
  discardWriteCheckpoint,
  finalizeWriteCheckpoint,
  getWriteCheckpoint,
  getWriteCheckpointMeta,
  resetWriteCheckpointsForTests,
  planRewindWrites,
  resolveWrites,
  rewindWritesFrom,
  setRewindUndoMemoryBytesForTests
} from '@main/agent/checkpoints'
import { executeTool } from '@main/agent/tools'
import { toolTodoWrite } from '@main/agent/tools/todo'

let workspace: string
let runDir: string

beforeEach(() => {
  resetWriteCheckpointsForTests()
  workspace = mkdtempSync(join(tmpdir(), 'vyotiq-cp-ws-'))
  runDir = mkdtempSync(join(tmpdir(), 'vyotiq-cp-run-'))
  writeFileSync(join(workspace, 'a.txt'), 'hello\n', 'utf8')
  toolTodoWrite(runDir, [{ id: '1', content: 'Apply the workspace write', status: 'in_progress' }])
})

afterEach(() => {
  resetWriteCheckpointsForTests()
  rmSync(workspace, { recursive: true, force: true })
  rmSync(runDir, { recursive: true, force: true })
})

describe('write checkpoints', async () => {
  it('snapshots priors and restores via undo', async () => {
    beginWriteCheckpoint(runDir, workspace)
    const signal = new AbortController().signal
    const result = await executeTool(
      'str_replace',
      JSON.stringify({ path: 'a.txt', old_string: 'hello', new_string: 'world' }),
      workspace,
      signal,
      { runDir }
    )
    expect(result.ok).toBe(true)
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('world\n')

    const meta = finalizeWriteCheckpoint(runDir)
    expect(meta).toBeTruthy()
    expect(meta!.files).toEqual([
      expect.objectContaining({
        path: 'a.txt',
        action: 'modified',
        undoable: true,
        hash: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
    ])

    const undone = resolveWrites(runDir, workspace, {
      checkpointId: meta!.id,
      action: 'discard'
    })
    expect(undone.discarded).toEqual(['a.txt'])
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('hello\n')
  })

  it('undoes created files by deleting them', async () => {
    beginWriteCheckpoint(runDir, workspace)
    const signal = new AbortController().signal
    await executeTool(
      'edit',
      JSON.stringify({ path: 'new.txt', contents: 'fresh\n' }),
      workspace,
      signal,
      { runDir }
    )
    const meta = finalizeWriteCheckpoint(runDir)
    expect(meta!.files[0]?.action).toBe('created')
    expect(existsSync(join(workspace, 'new.txt'))).toBe(true)

    resolveWrites(runDir, workspace, { action: 'discard' })
    expect(existsSync(join(workspace, 'new.txt'))).toBe(false)
  })

  it('keeps first prior when the same path is written twice', async () => {
    const cp = beginWriteCheckpoint(runDir, workspace)
    await cp.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'mid\n', 'utf8')
    await cp.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'end\n', 'utf8')
    const meta = finalizeWriteCheckpoint(runDir)
    expect(meta!.files).toHaveLength(1)
    resolveWrites(runDir, workspace, { checkpointId: meta!.id, action: 'discard' })
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('hello\n')
  })

  it('snapshots recursive directory deletes so they are undoable', async () => {
    mkdirSync(join(workspace, 'dir'), { recursive: true })
    writeFileSync(join(workspace, 'dir', 'x.txt'), 'x', 'utf8')
    const cp = beginWriteCheckpoint(runDir, workspace)
    await cp.recordPrior('dir', 'delete', { recursiveDir: true })
    const meta = cp.finalize()
    discardWriteCheckpoint(runDir)
    // The directory is snapshotted file-by-file; each child is individually undoable.
    expect(meta!.files).toHaveLength(1)
    expect(meta!.files[0]).toMatchObject({
      path: 'dir/x.txt',
      action: 'deleted',
      undoable: true
    })

    // Undo recreates the file (and thus the directory tree).
    rmSync(join(workspace, 'dir'), { recursive: true, force: true })
    const undone = resolveWrites(runDir, workspace, {
      checkpointId: meta!.id,
      action: 'discard'
    })
    expect(undone.discarded).toContain('dir/x.txt')
    expect(readFileSync(join(workspace, 'dir', 'x.txt'), 'utf8')).toBe('x')
  })

  it('resolving undoable files also marks leftover non-undoable on disk', async () => {
    mkdirSync(join(workspace, 'dir'), { recursive: true })
    writeFileSync(join(workspace, 'dir', 'x.txt'), 'x', 'utf8')
    const cp = beginWriteCheckpoint(runDir, workspace)
    await cp.recordPrior('a.txt', 'write')
    await cp.recordPrior('dir', 'delete', { recursiveDir: true })
    writeFileSync(join(workspace, 'a.txt'), 'changed\n', 'utf8')
    const meta = finalizeWriteCheckpoint(runDir)
    expect(meta!.files.map((f) => f.path).sort()).toEqual(['a.txt', 'dir/x.txt'])

    const result = resolveWrites(runDir, workspace, {
      checkpointId: meta!.id,
      action: 'keep',
      paths: ['a.txt', 'dir/x.txt']
    })
    expect(result.fullyResolved).toBe(true)
    const disk = getWriteCheckpointMeta(runDir, meta!.id)
    expect(disk?.resolved).toBe(true)
    expect(disk?.files.find((f) => f.path === 'a.txt')?.resolved).toBe('kept')
    expect(disk?.files.find((f) => f.path === 'dir/x.txt')?.resolved).toBe('kept')
  })

  it('getWriteCheckpoint is empty without begin', async () => {
    expect(getWriteCheckpoint(runDir)).toBeUndefined()
  })

  it('discards one path and keeps another', async () => {
    writeFileSync(join(workspace, 'b.txt'), 'beta\n', 'utf8')
    const cp = beginWriteCheckpoint(runDir, workspace)
    await cp.recordPrior('a.txt', 'write')
    await cp.recordPrior('b.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'A\n', 'utf8')
    writeFileSync(join(workspace, 'b.txt'), 'B\n', 'utf8')
    const meta = finalizeWriteCheckpoint(runDir)
    expect(meta!.files).toHaveLength(2)

    const discarded = resolveWrites(runDir, workspace, {
      checkpointId: meta!.id,
      action: 'discard',
      paths: ['a.txt']
    })
    expect(discarded.discarded).toEqual(['a.txt'])
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('hello\n')
    expect(readFileSync(join(workspace, 'b.txt'), 'utf8')).toBe('B\n')

    const kept = resolveWrites(runDir, workspace, {
      checkpointId: meta!.id,
      action: 'keep',
      paths: ['b.txt']
    })
    expect(kept.kept).toEqual(['b.txt'])
    expect(kept.fullyResolved).toBe(true)
    expect(readFileSync(join(workspace, 'b.txt'), 'utf8')).toBe('B\n')
  })

  it('matches Keep/Discard when given an absolute workspace path', async () => {
    const cp = beginWriteCheckpoint(runDir, workspace)
    await cp.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'A\n', 'utf8')
    const meta = finalizeWriteCheckpoint(runDir)
    const kept = resolveWrites(runDir, workspace, {
      checkpointId: meta!.id,
      action: 'keep',
      paths: [join(workspace, 'a.txt')]
    })
    expect(kept.kept).toEqual(['a.txt'])
    expect(kept.fullyResolved).toBe(true)
  })

  it('keep all resolves without touching disk', async () => {
    const cp = beginWriteCheckpoint(runDir, workspace)
    await cp.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'changed\n', 'utf8')
    const meta = finalizeWriteCheckpoint(runDir)
    const result = resolveWrites(runDir, workspace, {
      checkpointId: meta!.id,
      action: 'keep'
    })
    expect(result.kept).toEqual(['a.txt'])
    expect(result.fullyResolved).toBe(true)
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('changed\n')
  })

  it('keeps prior unresolved checkpoint revertible when a newer write turn finalizes', async () => {
    const first = beginWriteCheckpoint(runDir, workspace)
    await first.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'turn1\n', 'utf8')
    const meta1 = finalizeWriteCheckpoint(runDir)
    expect(meta1).not.toBeNull()

    writeFileSync(join(workspace, 'b.txt'), 'seed\n', 'utf8')
    const second = beginWriteCheckpoint(runDir, workspace)
    await second.recordPrior('b.txt', 'write')
    writeFileSync(join(workspace, 'b.txt'), 'turn2\n', 'utf8')
    const meta2 = finalizeWriteCheckpoint(runDir)
    expect(meta2).not.toBeNull()

    // Older turn stays unresolved (still revertible) — not auto-kept.
    expect(getWriteCheckpointMeta(runDir, meta1!.id)?.resolved).not.toBe(true)

    // Per-file discard resolves the path within its own (older) checkpoint even
    // without an explicit checkpointId.
    const discarded = resolveWrites(runDir, workspace, {
      action: 'discard',
      paths: ['a.txt']
    })
    expect(discarded.discarded).toEqual(['a.txt'])
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('hello\n')
    // The newer turn is untouched.
    expect(readFileSync(join(workspace, 'b.txt'), 'utf8')).toBe('turn2\n')

    // Explicitly targeting the older checkpoint now throws (already resolved).
    expect(() =>
      resolveWrites(runDir, workspace, { checkpointId: meta1!.id, action: 'discard' })
    ).toThrow(/already resolved/)

    // Latest turn still actionable on its own.
    const discarded2 = resolveWrites(runDir, workspace, {
      checkpointId: meta2!.id,
      action: 'discard',
      paths: ['b.txt']
    })
    expect(discarded2.discarded).toEqual(['b.txt'])
    expect(readFileSync(join(workspace, 'b.txt'), 'utf8')).toBe('seed\n')
  })

  it('rewindWritesFrom restores multi-turn writes newest-first including UI-kept', async () => {
    writeFileSync(join(workspace, 'b.txt'), 'b0\n', 'utf8')

    const first = beginWriteCheckpoint(runDir, workspace, 0)
    await first.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'a1\n', 'utf8')
    const meta1 = finalizeWriteCheckpoint(runDir)
    expect(meta1?.anchorUserMessageIndex).toBe(0)

    const second = beginWriteCheckpoint(runDir, workspace, 2)
    await second.recordPrior('a.txt', 'write')
    await second.recordPrior('b.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'a2\n', 'utf8')
    writeFileSync(join(workspace, 'b.txt'), 'b2\n', 'utf8')
    const meta2 = finalizeWriteCheckpoint(runDir)
    expect(meta2?.anchorUserMessageIndex).toBe(2)

    // meta1 stays unresolved (not auto-kept) so it remains individually revertible;
    // rewind still restores it when asked.
    expect(getWriteCheckpointMeta(runDir, meta1!.id)?.resolved).not.toBe(true)

    const result = rewindWritesFrom(runDir, workspace, 2)
    expect(result.checkpointIds).toEqual([meta2!.id])
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('a1\n')
    expect(readFileSync(join(workspace, 'b.txt'), 'utf8')).toBe('b0\n')

    const resultEarlier = rewindWritesFrom(runDir, workspace, 0)
    expect(resultEarlier.checkpointIds).toContain(meta1!.id)
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('hello\n')
  })

  it('rewindWritesFrom skips legacy unanchored checkpoints on mid-history rewind', async () => {
    writeFileSync(join(workspace, 'b.txt'), 'b0\n', 'utf8')

    const legacy = beginWriteCheckpoint(runDir, workspace)
    await legacy.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'legacy\n', 'utf8')
    const metaLegacy = finalizeWriteCheckpoint(runDir)
    expect(metaLegacy?.anchorUserMessageIndex).toBeUndefined()

    const later = beginWriteCheckpoint(runDir, workspace, 2)
    await later.recordPrior('b.txt', 'write')
    writeFileSync(join(workspace, 'b.txt'), 'b2\n', 'utf8')
    const metaLater = finalizeWriteCheckpoint(runDir)
    expect(metaLater?.anchorUserMessageIndex).toBe(2)

    const mid = rewindWritesFrom(runDir, workspace, 2)
    expect(mid.checkpointIds).toEqual([metaLater!.id])
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('legacy\n')
    expect(readFileSync(join(workspace, 'b.txt'), 'utf8')).toBe('b0\n')

    const full = rewindWritesFrom(runDir, workspace, 0)
    expect(full.checkpointIds).toContain(metaLegacy!.id)
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('hello\n')
  })

  it('rewind restores concurrent tool writes recorded on the same runDir checkpoint', async () => {
    // Multiple edits in one invoke share the parent's active InvokeWriteCheckpoint session.
    beginWriteCheckpoint(runDir, workspace, 0)
    const signal = new AbortController().signal
    const parentEdit = await executeTool(
      'edit',
      JSON.stringify({ path: 'a.txt', contents: 'parent\n' }),
      workspace,
      signal,
      { runDir }
    )
    expect(parentEdit.ok).toBe(true)

    const nestedEdit = await executeTool(
      'edit',
      JSON.stringify({ path: 'sub.txt', contents: 'from-sibling\n' }),
      workspace,
      signal,
      { runDir }
    )
    expect(nestedEdit.ok).toBe(true)
    expect(existsSync(join(workspace, 'sub.txt'))).toBe(true)

    const meta = finalizeWriteCheckpoint(runDir)
    expect(meta?.anchorUserMessageIndex).toBe(0)
    expect(meta?.files.map((f) => f.path).sort()).toEqual(['a.txt', 'sub.txt'])

    const rewound = rewindWritesFrom(runDir, workspace, 0)
    expect(rewound.checkpointIds).toEqual([meta!.id])
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('hello\n')
    expect(existsSync(join(workspace, 'sub.txt'))).toBe(false)
  })

  it('leaves checkpoint unresolved when a restore fails (missing prior blob)', async () => {
    writeFileSync(join(workspace, 'b.txt'), 'beta\n', 'utf8')
    const cp = beginWriteCheckpoint(runDir, workspace)
    await cp.recordPrior('a.txt', 'write')
    await cp.recordPrior('b.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'A\n', 'utf8')
    writeFileSync(join(workspace, 'b.txt'), 'B\n', 'utf8')
    const meta = finalizeWriteCheckpoint(runDir)
    expect(meta).not.toBeNull()

    rmSync(join(runDir, 'checkpoints', meta!.id, 'files', 'a.txt'), { force: true })

    const result = resolveWrites(runDir, workspace, {
      checkpointId: meta!.id,
      action: 'discard'
    })
    expect(result.discarded).toEqual(['b.txt'])
    expect(result.skipped).toContain('a.txt')
    expect(result.fullyResolved).toBe(false)

    const persisted = getWriteCheckpointMeta(runDir, meta!.id)
    expect(persisted?.resolved).not.toBe(true)
    expect(persisted?.undone).not.toBe(true)
    expect(persisted?.files.find((f) => f.path === 'a.txt')?.resolved).toBeUndefined()
    expect(persisted?.files.find((f) => f.path === 'b.txt')?.resolved).toBe('discarded')
  })

  it('getWriteCheckpointMeta returns null for empty/invalid ids without throwing', async () => {
    expect(getWriteCheckpointMeta(runDir, '')).toBeNull()
    expect(getWriteCheckpointMeta(runDir, 'not-a-uuid')).toBeNull()
  })

  it('resolveWrites soft no-op with no checkpoint returns empty id safely', async () => {
    const result = resolveWrites(runDir, workspace, { action: 'keep' })
    expect(result.checkpointId).toBe('')
    expect(result.fullyResolved).toBe(true)
    expect(getWriteCheckpointMeta(runDir, result.checkpointId)).toBeNull()
  })

  it('stores a post-write hash and reports a conflict when current content differs', async () => {
    const cp = beginWriteCheckpoint(runDir, workspace)
    await cp.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'agent\n', 'utf8')
    const meta = finalizeWriteCheckpoint(runDir)
    expect(meta!.files[0]?.hash).toMatch(/^[a-f0-9]{64}$/)

    writeFileSync(join(workspace, 'a.txt'), 'user-edit\n', 'utf8')
    const result = resolveWrites(runDir, workspace, {
      checkpointId: meta!.id,
      action: 'discard'
    })
    expect(result.discarded).toEqual([])
    expect(result.conflicted).toEqual(['a.txt'])
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('user-edit\n')

    const persisted = getWriteCheckpointMeta(runDir, meta!.id)
    expect(persisted?.resolved).not.toBe(true)
    expect(persisted?.undone).not.toBe(true)
    expect(persisted?.files.find((f) => f.path === 'a.txt')?.conflicted).toBe(true)
  })

  it('rewindWritesFrom leaves the checkpoint unresolved on an undoable restore failure', async () => {
    const cp = beginWriteCheckpoint(runDir, workspace, 0)
    await cp.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'agent\n', 'utf8')
    const meta = finalizeWriteCheckpoint(runDir)

    // The copy to restore from is gone. (A file you changed since is left
    // alone instead — see rewindLeavesEdits.test.ts.)
    rmSync(join(runDir, 'checkpoints', meta!.id, 'files', 'a.txt'))
    const result = rewindWritesFrom(runDir, workspace, 0)
    expect(result.undoableRestoreFailed).toBe(true)
    expect(result.restored).toEqual([])
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('agent\n')

    const persisted = getWriteCheckpointMeta(runDir, meta!.id)
    expect(persisted?.resolved).not.toBe(true)
    expect(persisted?.undone).not.toBe(true)
  })

  it('restores a nested directory tree on undo (recreating subdirs and files)', async () => {
    mkdirSync(join(workspace, 'tree', 'sub'), { recursive: true })
    writeFileSync(join(workspace, 'tree', 'top.txt'), 't', 'utf8')
    writeFileSync(join(workspace, 'tree', 'sub', 'nested.txt'), 'n', 'utf8')

    const cp = beginWriteCheckpoint(runDir, workspace)
    await cp.recordPrior('tree', 'delete', { recursiveDir: true })
    const meta = cp.finalize()
    discardWriteCheckpoint(runDir)
    // Two files snapshotted under their original relative paths.
    expect(meta!.files.map((f) => f.path).sort()).toEqual([
      'tree/sub/nested.txt',
      'tree/top.txt'
    ])
    expect(meta!.files.every((f) => f.undoable)).toBe(true)

    // Simulate the agent having removed the tree.
    rmSync(join(workspace, 'tree'), { recursive: true, force: true })
    const undone = resolveWrites(runDir, workspace, {
      checkpointId: meta!.id,
      action: 'discard'
    })
    expect(undone.discarded.sort()).toEqual(['tree/sub/nested.txt', 'tree/top.txt'])
    expect(readFileSync(join(workspace, 'tree', 'top.txt'), 'utf8')).toBe('t')
    expect(readFileSync(join(workspace, 'tree', 'sub', 'nested.txt'), 'utf8')).toBe('n')
  })

  it('restores a modified file that was deleted after the agent write', async () => {
    const cp = beginWriteCheckpoint(runDir, workspace)
    await cp.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'agent\n', 'utf8')
    const meta = finalizeWriteCheckpoint(runDir)

    // Simulate the user (or another tool) deleting the modified file.
    rmSync(join(workspace, 'a.txt'), { force: true })
    expect(existsSync(join(workspace, 'a.txt'))).toBe(false)

    const undone = resolveWrites(runDir, workspace, {
      checkpointId: meta!.id,
      action: 'discard'
    })
    expect(undone.discarded).toEqual(['a.txt'])
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('hello\n')
  })

  it('resolves a path within its own (newest) checkpoint without a checkpointId', async () => {
    const first = beginWriteCheckpoint(runDir, workspace)
    await first.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 't1\n', 'utf8')
    const meta1 = finalizeWriteCheckpoint(runDir)

    const second = beginWriteCheckpoint(runDir, workspace)
    await second.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 't2\n', 'utf8')
    const meta2 = finalizeWriteCheckpoint(runDir)

    // Discard the newest change (turn 2) without an explicit checkpointId.
    const discarded = resolveWrites(runDir, workspace, { action: 'discard', paths: ['a.txt'] })
    expect(discarded.discarded).toEqual(['a.txt'])
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('t1\n')

    // Turn 1 checkpoint is still unresolved and individually revertible.
    expect(getWriteCheckpointMeta(runDir, meta1!.id)?.resolved).not.toBe(true)

    // Discard again resolves the older turn, restoring the original content.
    const discarded2 = resolveWrites(runDir, workspace, { action: 'discard', paths: ['a.txt'] })
    expect(discarded2.discarded).toEqual(['a.txt'])
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('hello\n')
  })

  it('reports a conflict instead of a false discard when the user edited a created file', async () => {
    const cp = beginWriteCheckpoint(runDir, workspace)
    await cp.recordPrior('new.txt', 'write')
    writeFileSync(join(workspace, 'new.txt'), 'agent\n', 'utf8')
    const meta = finalizeWriteCheckpoint(runDir)
    // User edits the agent-created file after the write.
    writeFileSync(join(workspace, 'new.txt'), 'user-edit\n', 'utf8')

    const result = resolveWrites(runDir, workspace, {
      checkpointId: meta!.id,
      action: 'discard',
      paths: ['new.txt']
    })
    expect(result.discarded).toEqual([])
    expect(result.conflicted).toEqual(['new.txt'])
    // The file is preserved with the user's content.
    expect(readFileSync(join(workspace, 'new.txt'), 'utf8')).toBe('user-edit\n')
    // The checkpoint stays unresolved so the UI can surface the conflict.
    const disk = getWriteCheckpointMeta(runDir, meta!.id)
    expect(disk?.files.find((f) => f.path === 'new.txt')?.resolved).toBeUndefined()
    expect(disk?.files.find((f) => f.path === 'new.txt')?.conflicted).toBe(true)
  })

  it('reports a conflict for a modified file edited after the agent write', async () => {
    const cp = beginWriteCheckpoint(runDir, workspace)
    await cp.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'agent\n', 'utf8')
    const meta = finalizeWriteCheckpoint(runDir)
    writeFileSync(join(workspace, 'a.txt'), 'user-edit\n', 'utf8')

    const result = resolveWrites(runDir, workspace, {
      checkpointId: meta!.id,
      action: 'discard',
      paths: ['a.txt']
    })
    expect(result.discarded).toEqual([])
    expect(result.conflicted).toEqual(['a.txt'])
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('user-edit\n')
  })

  it('planRewindWrites previews the exact rewind set without mutating anything', async () => {
    writeFileSync(join(workspace, 'b.txt'), 'b0\n', 'utf8')

    const first = beginWriteCheckpoint(runDir, workspace, 0)
    await first.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'a1\n', 'utf8')
    const meta1 = finalizeWriteCheckpoint(runDir)

    const second = beginWriteCheckpoint(runDir, workspace, 2)
    await second.recordPrior('a.txt', 'write')
    await second.recordPrior('b.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'a2\n', 'utf8')
    writeFileSync(join(workspace, 'b.txt'), 'b2\n', 'utf8')
    const meta2 = finalizeWriteCheckpoint(runDir)

    const plan = planRewindWrites(runDir, 2)
    expect(plan.checkpointIds).toEqual([meta2!.id])
    expect(plan.files.map((f) => f.path).sort()).toEqual(['a.txt', 'b.txt'])
    // Newest checkpoint wins per path.
    expect(plan.files.find((f) => f.path === 'a.txt')).toMatchObject({
      action: 'modified',
      undoable: true
    })

    // Planning is read-only: no disk mutation, no resolution stamping.
    const again = planRewindWrites(runDir, 2)
    expect(again).toEqual(plan)
    expect(getWriteCheckpointMeta(runDir, meta2!.id)?.resolved).not.toBe(true)
    expect(getWriteCheckpointMeta(runDir, meta1!.id)?.resolved).not.toBe(true)
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('a2\n')
    expect(readFileSync(join(workspace, 'b.txt'), 'utf8')).toBe('b2\n')

    // Rewind at the full-user-message index still includes the older checkpoint.
    const earlier = planRewindWrites(runDir, 0)
    expect(earlier.checkpointIds).toEqual([meta2!.id, meta1!.id])
  })

  it('planRewindWrites matches rewindWritesFrom selection for legacy unanchored checkpoints', async () => {
    writeFileSync(join(workspace, 'b.txt'), 'b0\n', 'utf8')

    const legacy = beginWriteCheckpoint(runDir, workspace)
    await legacy.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'legacy\n', 'utf8')
    finalizeWriteCheckpoint(runDir)

    const later = beginWriteCheckpoint(runDir, workspace, 2)
    await later.recordPrior('b.txt', 'write')
    writeFileSync(join(workspace, 'b.txt'), 'b2\n', 'utf8')
    const metaLater = finalizeWriteCheckpoint(runDir)

    const mid = planRewindWrites(runDir, 2)
    expect(mid.checkpointIds).toEqual([metaLater!.id])
    expect(mid.files.map((f) => f.path).sort()).toEqual(['b.txt'])

    const full = planRewindWrites(runDir, 0)
    expect(full.checkpointIds).toHaveLength(2)
    expect(full.files.map((f) => f.path).sort()).toEqual(['a.txt', 'b.txt'])
  })
})

/**
 * Run 874dad8f: `str_replace index.md` failed with "File not found", but
 * `recordPrior` had already run — it has to, since the prior content must be
 * captured before the write. The speculative entry stayed, so the finalized
 * checkpoint carried `index.md` as created and undoable for a file that never
 * existed. The receipt reported it in `wroteFiles`, and Undo deletes what a
 * `created` entry names.
 */
describe('write checkpoint drops entries nothing changed', () => {
  const signal = new AbortController().signal

  it('does not record a created entry for a failed edit of a missing file', async () => {
    beginWriteCheckpoint(runDir, workspace)
    const result = await executeTool(
      'str_replace',
      JSON.stringify({ path: 'index.md', old_string: 'a', new_string: 'b' }),
      workspace,
      signal,
      { runDir }
    )
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/File not found/)
    expect(finalizeWriteCheckpoint(runDir)).toBeNull()
    expect(existsSync(join(workspace, 'index.md'))).toBe(false)
  })

  it('keeps a real write recorded alongside a failed one', async () => {
    beginWriteCheckpoint(runDir, workspace)
    await executeTool(
      'str_replace',
      JSON.stringify({ path: 'index.md', old_string: 'a', new_string: 'b' }),
      workspace,
      signal,
      { runDir }
    )
    const ok = await executeTool(
      'edit',
      JSON.stringify({ path: 'real.txt', contents: 'written\n' }),
      workspace,
      signal,
      { runDir }
    )
    expect(ok.ok).toBe(true)
    const meta = finalizeWriteCheckpoint(runDir)
    expect(meta).not.toBeNull()
    expect(meta!.files.map((f) => f.path)).toEqual(['real.txt'])
  })

  it('drops a modified entry when every edit of that file failed', async () => {
    beginWriteCheckpoint(runDir, workspace)
    const before = readFileSync(join(workspace, 'a.txt'), 'utf8')
    const result = await executeTool(
      'str_replace',
      JSON.stringify({ path: 'a.txt', old_string: 'nowhere in the file', new_string: 'x' }),
      workspace,
      signal,
      { runDir }
    )
    expect(result.ok).toBe(false)
    expect(finalizeWriteCheckpoint(runDir)).toBeNull()
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe(before)
  })

  it('leaves no index entry behind when every entry was a phantom', async () => {
    beginWriteCheckpoint(runDir, workspace)
    await executeTool(
      'str_replace',
      JSON.stringify({ path: 'index.md', old_string: 'a', new_string: 'b' }),
      workspace,
      signal,
      { runDir }
    )
    finalizeWriteCheckpoint(runDir)
    const indexPath = join(runDir, 'checkpoints', 'index.json')
    if (!existsSync(indexPath)) return
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as {
      checkpoints: { id: string }[]
    }
    expect(index.checkpoints).toEqual([])
  })
})

/**
 * A restore throws partway through a rewind (EBUSY, EPERM, a full disk). The
 * files restored before it used to stay restored while the rewind reported
 * failure and kept the history: a half-rewound workspace.
 */
describe('a rewind that fails partway', () => {
  const read = (name: string): string => readFileSync(join(workspace, name), 'utf8')

  beforeEach(() => {
    fsRoute.failCopyFrom = null
    fsRoute.code = 'EBUSY'
    fsRoute.partial = null
  })

  afterEach(() => {
    fsRoute.failCopyFrom = null
    fsRoute.partial = null
  })

  /** The turn at user message 2 changes a, b and c; a rewind restores c, then b, then a. */
  async function changeThreeFiles(): Promise<string> {
    const names = ['a', 'b', 'c']
    for (const n of names) writeFileSync(join(workspace, `${n}.txt`), `${n}0\n`, 'utf8')
    const cp = beginWriteCheckpoint(runDir, workspace, 2)
    for (const n of names) await cp.recordPrior(`${n}.txt`, 'write')
    for (const n of names) writeFileSync(join(workspace, `${n}.txt`), `${n}2\n`, 'utf8')
    const id = finalizeWriteCheckpoint(runDir)!.id
    fsRoute.ops = []
    return id
  }

  it('puts the first file back when the second cannot be written', async () => {
    const id = await changeThreeFiles()
    fsRoute.failCopyFrom = 'files/b.txt'

    const result = rewindWritesFrom(runDir, workspace, 2)

    // c.txt really was restored before b.txt failed.
    expect(fsRoute.ops).toEqual(['copy c.txt', 'copy b.txt'])
    expect(read('c.txt')).toBe('c2\n')
    expect(read('b.txt')).toBe('b2\n')
    expect(read('a.txt')).toBe('a2\n')
    expect(result).toEqual({
      checkpointIds: [],
      restored: [],
      skipped: [],
      edited: [],
      undoableRestoreFailed: true,
      failure: { path: 'b.txt', reason: 'EBUSY' }
    })
    // Nothing is marked, so Keep and Undo still offer every file.
    const meta = getWriteCheckpointMeta(runDir, id)
    expect(meta?.undone).not.toBe(true)
    expect(meta?.files.map((f) => f.resolved)).toEqual([undefined, undefined, undefined])
  })

  it('puts back the file whose copy failed partway', async () => {
    await changeThreeFiles()
    fsRoute.failCopyFrom = 'files/b.txt'
    fsRoute.code = 'ENOSPC'
    fsRoute.partial = 'b'

    const result = rewindWritesFrom(runDir, workspace, 2)

    expect(result.failure).toEqual({ path: 'b.txt', reason: 'ENOSPC' })
    expect(read('b.txt')).toBe('b2\n')
    expect(read('c.txt')).toBe('c2\n')
  })

  it('deletes what it brought back, restores what it deleted, and removes the folders it made', async () => {
    writeFileSync(join(workspace, 'b.txt'), 'b0\n', 'utf8')
    mkdirSync(join(workspace, 'gone', 'deep'), { recursive: true })
    writeFileSync(join(workspace, 'gone', 'deep', 'old.txt'), 'old\n', 'utf8')
    const cp = beginWriteCheckpoint(runDir, workspace, 2)
    await cp.recordPrior('b.txt', 'write')
    await cp.recordPrior('gone', 'delete', { recursiveDir: true })
    await cp.recordPrior('new.txt', 'write')
    writeFileSync(join(workspace, 'b.txt'), 'b2\n', 'utf8')
    rmSync(join(workspace, 'gone'), { recursive: true })
    writeFileSync(join(workspace, 'new.txt'), 'made by the agent\n', 'utf8')
    finalizeWriteCheckpoint(runDir)
    fsRoute.ops = []
    fsRoute.failCopyFrom = 'files/b.txt'

    const result = rewindWritesFrom(runDir, workspace, 2)

    // new.txt went and gone/deep/old.txt came back before b.txt failed.
    expect(fsRoute.ops.slice(0, 3)).toEqual(['rm new.txt', 'copy old.txt', 'copy b.txt'])
    expect(result.failure?.path).toBe('b.txt')
    expect(read('new.txt')).toBe('made by the agent\n')
    expect(existsSync(join(workspace, 'gone'))).toBe(false)
    expect(read('b.txt')).toBe('b2\n')
  })

  it('leaves a newer turn unmarked when an older one fails, and a retry finishes', async () => {
    writeFileSync(join(workspace, 'b.txt'), 'b0\n', 'utf8')
    const older = beginWriteCheckpoint(runDir, workspace, 0)
    await older.recordPrior('b.txt', 'write')
    writeFileSync(join(workspace, 'b.txt'), 'b1\n', 'utf8')
    const olderId = finalizeWriteCheckpoint(runDir)!.id
    const newer = beginWriteCheckpoint(runDir, workspace, 2)
    await newer.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'a2\n', 'utf8')
    const newerId = finalizeWriteCheckpoint(runDir)!.id
    fsRoute.failCopyFrom = `${olderId}/files/b.txt`

    expect(rewindWritesFrom(runDir, workspace, 0).undoableRestoreFailed).toBe(true)
    // The newer turn used to be marked undone before the older one failed.
    expect(read('a.txt')).toBe('a2\n')
    expect(read('b.txt')).toBe('b1\n')
    expect(getWriteCheckpointMeta(runDir, newerId)?.undone).not.toBe(true)
    expect(getWriteCheckpointMeta(runDir, olderId)?.undone).not.toBe(true)

    fsRoute.failCopyFrom = null
    const retried = rewindWritesFrom(runDir, workspace, 0)
    expect(retried.undoableRestoreFailed).toBe(false)
    expect(retried.checkpointIds).toEqual([newerId, olderId])
    expect(read('a.txt')).toBe('hello\n')
    expect(read('b.txt')).toBe('b0\n')
    expect(getWriteCheckpointMeta(runDir, newerId)?.undone).toBe(true)
    expect(getWriteCheckpointMeta(runDir, olderId)?.undone).toBe(true)
  })

  it('past its memory budget, puts back from copies on disk and then removes them', async () => {
    const copyDirs = (): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith('vyotiq-rewind-undo-'))
    const existing = new Set(copyDirs())
    setRewindUndoMemoryBytesForTests(0)
    try {
      await changeThreeFiles()
      fsRoute.failCopyFrom = 'files/b.txt'

      expect(rewindWritesFrom(runDir, workspace, 2).failure?.path).toBe('b.txt')
      // Each file is copied aside before it is restored; c.txt comes back from its copy.
      expect(fsRoute.ops.slice(0, 5)).toEqual(['copy 0', 'copy c.txt', 'copy 1', 'copy b.txt', 'copy c.txt'])
      expect(fsRoute.ops.slice(5)).toEqual([expect.stringMatching(/^rm vyotiq-rewind-undo-/)])
      expect(read('c.txt')).toBe('c2\n')
      expect(read('b.txt')).toBe('b2\n')

      fsRoute.failCopyFrom = null
      expect(rewindWritesFrom(runDir, workspace, 2).restored).toEqual(['c.txt', 'b.txt', 'a.txt'])
      expect(read('c.txt')).toBe('c0\n')
      expect(copyDirs().filter((n) => !existing.has(n))).toEqual([])
    } finally {
      setRewindUndoMemoryBytesForTests(null)
    }
  })
})
