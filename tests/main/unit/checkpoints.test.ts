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
import { execFileSync } from 'child_process'

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

  // The checkpoint is flushed at invoke end; the receipt dates each write by
  // this stamp so a check run after it is not read as stale.
  it('stamps each path with its first write, not the flush', async () => {
    const cp = beginWriteCheckpoint(runDir, workspace)
    const before = new Date().toISOString()
    await cp.recordPrior('a.txt', 'write')
    const firstAt = cp['files'].get('a.txt')?.recordedAt
    await new Promise((r) => setTimeout(r, 5))
    await cp.recordObservedMutation('b.txt', 'created')
    await cp.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'end\n', 'utf8')
    writeFileSync(join(workspace, 'b.txt'), 'new\n', 'utf8')
    await new Promise((r) => setTimeout(r, 5))
    const flushedAt = new Date().toISOString()
    const meta = finalizeWriteCheckpoint(runDir)

    const byPath = new Map(meta!.files.map((f) => [f.path, f]))
    expect(firstAt! >= before).toBe(true)
    expect(byPath.get('a.txt')?.recordedAt).toBe(firstAt)
    expect(byPath.get('b.txt')?.recordedAt! > firstAt!).toBe(true)
    expect(byPath.get('b.txt')?.recordedAt! < flushedAt).toBe(true)
  })

  // The live verification tracker reads otherWriteCount after every tool
  // call; the receipt reads lastMutatedAt. Edit tools stay out of both: the
  // tracker sees them by name, and their snapshot precedes a write that can
  // still fail.
  it('counts and dates writes by tools other than the edit family', async () => {
    const cp = beginWriteCheckpoint(runDir, workspace)
    await cp.recordPrior('a.txt', 'write')
    expect(cp.otherWriteCount).toBe(0)

    await new Promise((r) => setTimeout(r, 5))
    const beforeRewrite = new Date().toISOString()
    await cp.recordPrior('a.txt', 'write', { nonEditTool: true }) // e.g. terminal `sed -i a.txt`
    expect(cp.otherWriteCount).toBe(1)
    await cp.recordObservedMutation('b.txt', 'created') // e.g. a watched build
    expect(cp.otherWriteCount).toBe(2)
    writeFileSync(join(workspace, 'a.txt'), 'end\n', 'utf8')
    writeFileSync(join(workspace, 'b.txt'), 'new\n', 'utf8')

    const byPath = new Map(finalizeWriteCheckpoint(runDir)!.files.map((f) => [f.path, f]))
    expect(byPath.get('a.txt')?.lastMutatedAt! >= beforeRewrite).toBe(true)
    expect(byPath.get('a.txt')?.recordedAt! < beforeRewrite).toBe(true)
    expect(byPath.get('b.txt')?.lastMutatedAt).toBeUndefined()
  })

  it('does not count a str_replace that failed', async () => {
    const cp = beginWriteCheckpoint(runDir, workspace)
    const result = await executeTool(
      'str_replace',
      JSON.stringify({ path: 'a.txt', old_string: 'not there', new_string: 'x' }),
      workspace,
      new AbortController().signal,
      { runDir }
    )
    expect(result.ok).toBe(false)
    expect(cp.otherWriteCount).toBe(0)
    expect(finalizeWriteCheckpoint(runDir)).toBeNull()
  })

  it('checkpoints the files a git_apply patch writes', async () => {
    execFileSync('git', ['init', '-q'], { cwd: workspace })
    const cp = beginWriteCheckpoint(runDir, workspace)
    const patch = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-hello',
      '+patched',
      ''
    ].join('\n')
    const result = await executeTool(
      'git_apply',
      JSON.stringify({ patch }),
      workspace,
      new AbortController().signal,
      { runDir }
    )
    expect(result.ok, result.content).toBe(true)
    // core.autocrlf may turn the patched line into CRLF.
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('patched\n')
    expect(cp.otherWriteCount).toBe(1)

    const meta = finalizeWriteCheckpoint(runDir)
    expect(meta!.files.map((f) => [f.path, f.action])).toEqual([['a.txt', 'modified']])
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

/**
 * A checkpoint's record of what it wrote is the only thing that stops a restore
 * from destroying a later change. These three cover the ways that record goes
 * missing: an index that cannot be read, hashes a crash never wrote, and a
 * rewind that did not take every file back.
 */
describe('checkpoint integrity', () => {
  const cpDir = (id: string): string => join(runDir, 'checkpoints', id)
  const indexPath = (): string => join(runDir, 'checkpoints', 'index.json')

  it('a corrupt index.json keeps every earlier checkpoint reachable', async () => {
    const first = beginWriteCheckpoint(runDir, workspace, 0)
    await first.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'turn1\n', 'utf8')
    const meta1 = finalizeWriteCheckpoint(runDir)!

    // The index is one file: a crash mid-write leaves it unparseable, and it
    // is the only way back to every turn's undo copies.
    writeFileSync(indexPath(), '{ "checkpoints": [', 'utf8')

    const second = beginWriteCheckpoint(runDir, workspace, 2)
    await second.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'turn2\n', 'utf8')
    const meta2 = finalizeWriteCheckpoint(runDir)!

    // The next save no longer writes over the record of the earlier turns: the
    // entries came back from the checkpoint dirs, and the unreadable file it
    // replaced was kept beside it.
    const index = JSON.parse(readFileSync(indexPath(), 'utf8')) as { checkpoints: { id: string }[] }
    expect(index.checkpoints.map((c) => c.id).sort()).toEqual([meta1.id, meta2.id].sort())
    expect(readdirSync(join(runDir, 'checkpoints')).filter((n) => n.startsWith('index.json.unreadable-')))
      .toHaveLength(1)

    // Both turns are still actionable, newest first. A path-resolved discard
    // spans checkpoints, so the file itself says which turn it took back.
    const newest = resolveWrites(runDir, workspace, { action: 'discard', paths: ['a.txt'] })
    expect(newest.discarded).toEqual(['a.txt'])
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('turn1\n')
    expect(getWriteCheckpointMeta(runDir, meta2.id)?.undone).toBe(true)
    expect(getWriteCheckpointMeta(runDir, meta1.id)?.undone).not.toBe(true)

    const older = resolveWrites(runDir, workspace, { checkpointId: meta1.id, action: 'discard' })
    expect(older.discarded).toEqual(['a.txt'])
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('hello\n')
  })

  it('a checkpoint with no post-write hash conflicts instead of overwriting', async () => {
    // A turn that died before finalize persisted its copies and meta with no
    // hash of what it wrote: nothing on disk can tell its output from yours.
    const id = '1a2b3c4d-0000-4000-8000-00000000b00c'
    const createdAt = new Date().toISOString()
    mkdirSync(join(cpDir(id), 'files'), { recursive: true })
    writeFileSync(join(cpDir(id), 'files', 'a.txt'), 'before\n', 'utf8')
    writeFileSync(
      join(cpDir(id), 'meta.json'),
      JSON.stringify({
        id,
        createdAt,
        files: [
          { path: 'a.txt', action: 'modified', undoable: true },
          { path: 'new.txt', action: 'created', undoable: true }
        ]
      }),
      'utf8'
    )
    writeFileSync(indexPath(), JSON.stringify({ checkpoints: [{ id, createdAt }] }), 'utf8')

    // You changed both after the crash.
    writeFileSync(join(workspace, 'a.txt'), 'mine\n', 'utf8')
    writeFileSync(join(workspace, 'new.txt'), 'mine, still wanted\n', 'utf8')

    const result = resolveWrites(runDir, workspace, { action: 'discard' })

    // Neither the copy over a.txt nor the delete of new.txt happened.
    expect(result.discarded).toEqual([])
    expect(result.conflicted).toEqual(['a.txt', 'new.txt'])
    expect(result.fullyResolved).toBe(false)
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('mine\n')
    expect(readFileSync(join(workspace, 'new.txt'), 'utf8')).toBe('mine, still wanted\n')

    const meta = getWriteCheckpointMeta(runDir, id)
    expect(meta?.resolved).not.toBe(true)
    expect(meta?.undone).not.toBe(true)
    expect(meta?.files.every((f) => f.conflicted === true)).toBe(true)
  })

  it('a rewind that left your edit keeps that turn revertible', async () => {
    const older = beginWriteCheckpoint(runDir, workspace, 0)
    await older.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'a1\n', 'utf8')
    const olderId = finalizeWriteCheckpoint(runDir)!.id
    const newer = beginWriteCheckpoint(runDir, workspace, 2)
    await newer.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'a2\n', 'utf8')
    const newerId = finalizeWriteCheckpoint(runDir)!.id
    writeFileSync(join(workspace, 'a.txt'), 'mine\n', 'utf8')

    const result = rewindWritesFrom(runDir, workspace, 0)

    expect(result.edited).toEqual(['a.txt'])
    expect(result.restored).toEqual([])
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('mine\n')

    // Marking follows what the rewind did. The writes are still in the file,
    // so both turns keep their before-images and stay unresolved: retention
    // frees a resolved checkpoint's copies, and a later rewind needs these.
    for (const id of [newerId, olderId]) {
      const meta = getWriteCheckpointMeta(runDir, id)
      expect(meta?.undone).not.toBe(true)
      expect(meta?.resolved).not.toBe(true)
      expect(existsSync(join(cpDir(id), 'files', 'a.txt'))).toBe(true)
    }
    expect(getWriteCheckpointMeta(runDir, newerId)?.files[0]?.resolved).toBe('kept')
  })
})
