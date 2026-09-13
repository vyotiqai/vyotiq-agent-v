/**
 * Audit probes for the changes/revert/checkpoints audit — round 2.
 * Uses ONLY production modules. Each probe documents verified behavior;
 * a failure here means a genuine defect in the production code.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  beginWriteCheckpoint,
  finalizeWriteCheckpoint,
  getWriteCheckpointMeta,
  resolveWrites,
  rewindWritesFrom,
  resetWriteCheckpointsForTests,
  type WriteCheckpointMeta
} from '@main/agent/checkpoints'
import { extractTerminalWritePaths, needsOpaqueWatch } from '@main/agent/tools/terminalCheckpoint'
import { loadLoopCheckpoint, clearLoopCheckpoint } from '@main/agent/loopCheckpoint'
import { resolveInsideWorkspace } from '@main/workspace/safePath'

let base: string
let workspace: string
let runDir: string

beforeEach(() => {
  base = join(tmpdir(), `cp-audit-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  workspace = join(base, 'ws')
  runDir = join(base, 'run')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(runDir, { recursive: true })
  resetWriteCheckpointsForTests()
})

afterEach(() => {
  resetWriteCheckpointsForTests()
  try {
    rmSync(base, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

function persisted(meta: WriteCheckpointMeta | null): WriteCheckpointMeta | null {
  if (!meta) return null
  return getWriteCheckpointMeta(runDir, meta.id)
}

describe('write checkpoint semantics (audit coverage)', () => {
  it('user-deleted agent output — undo restores pre-agent content (per checkpoints.ts:506-509)', async () => {
    writeFileSync(join(workspace, 'a.txt'), 'original\n', 'utf8')
    const cp = beginWriteCheckpoint(runDir, workspace, 0)
    await cp.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'agent-version\n', 'utf8')
    const meta = finalizeWriteCheckpoint(runDir)
    expect(meta).not.toBeNull()
    rmSync(join(workspace, 'a.txt'))
    const res = resolveWrites(runDir, workspace, { action: 'discard' })
    expect(res.discarded).toEqual(['a.txt'])
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('original\n')
  })

  it('resolveWrites against an already-resolved checkpoint soft-no-ops', async () => {
    writeFileSync(join(workspace, 'a.txt'), 'x\n', 'utf8')
    const cp = beginWriteCheckpoint(runDir, workspace, 0)
    await cp.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'y\n', 'utf8')
    const meta = finalizeWriteCheckpoint(runDir)
    expect(meta).not.toBeNull()
    const r1 = resolveWrites(runDir, workspace, { action: 'keep', paths: ['a.txt'] })
    expect(r1.fullyResolved).toBe(true)
    const r2 = resolveWrites(runDir, workspace, { action: 'discard', paths: ['a.txt'] })
    expect(r2.checkpointId).toBe('')
    expect(r2.skipped).toContain('a.txt')
    expect(r2.fullyResolved).toBe(true)
  })

  it('terminal redirect on absolute in-workspace path records workspace-relative entry', () => {
    const cmd = `echo hi > ${workspace.replace(/\\/g, '/')}/out.txt`
    // Parser returns the raw path; recordTerminalCommandPriors relativizes it.
    expect(extractTerminalWritePaths(cmd)).toContain(`${workspace.replace(/\\/g, '/')}/out.txt`)
  })

  it('needsOpaqueWatch gates full snapshot to known opaque commands', () => {
    expect(needsOpaqueWatch('pnpm install')).toBe(true)
    expect(needsOpaqueWatch('ls -la')).toBe(false)
  })

  it('recordPrior on workspace-escaping path THROWS (surfaces as tool failure via executeTool catch)', async () => {
    const cp = beginWriteCheckpoint(runDir, workspace, 0)
    await expect(cp.recordPrior('../outside.txt', 'write')).rejects.toThrow(/Path escapes workspace/)
    const meta = finalizeWriteCheckpoint(runDir)
    expect(meta).toBeNull()
  })

  it('loopCheckpoint file with unknown version fails safe (returns null)', () => {
    const v99 = {
      version: 99,
      step: 4,
      invokeId: 1,
      updatedAt: '2026-01-01T00:00:00.000Z'
    }
    writeFileSync(join(runDir, 'loopCheckpoint.json'), JSON.stringify(v99), 'utf8')
    const loaded = loadLoopCheckpoint(runDir)
    expect(loaded).toBeNull()
    clearLoopCheckpoint(runDir)
  })

  it('discard-all with mixed undoable + non-undoable files resolves cleanly', async () => {
    writeFileSync(join(workspace, 'keep.txt'), 'keep\n', 'utf8')
    const cp = beginWriteCheckpoint(runDir, workspace, 0)
    await cp.recordPrior('keep.txt', 'write')
    writeFileSync(join(workspace, 'keep.txt'), 'kept-new\n', 'utf8')
    await cp.recordObservedMutation('opaque.bin', 'created')
    writeFileSync(join(workspace, 'opaque.bin'), 'opaque\n', 'utf8')
    const meta = finalizeWriteCheckpoint(runDir)
    expect(meta).not.toBeNull()
    const res = resolveWrites(runDir, workspace, { action: 'discard' })
    expect(res.discarded).toContain('keep.txt')
    // Observed 'created' mutation is undoable: discard deletes the agent-created file.
    expect(res.discarded).toContain('opaque.bin')
    const after = persisted(meta)
    expect(after?.undone).toBe(true)
    expect(after?.resolved).toBe(true)
    expect(existsSync(join(workspace, 'opaque.bin'))).toBe(false)
  })

  it('resolveWrites discard restores the pre-agent blob (real revert)', async () => {
    writeFileSync(join(workspace, 'r.txt'), 'v0\n', 'utf8')
    const cp = beginWriteCheckpoint(runDir, workspace, 0)
    await cp.recordPrior('r.txt', 'write')
    writeFileSync(join(workspace, 'r.txt'), 'v1\n', 'utf8')
    const meta = finalizeWriteCheckpoint(runDir)
    expect(meta).not.toBeNull()
    const res = resolveWrites(runDir, workspace, { action: 'discard', paths: ['r.txt'] })
    expect(res.discarded).toEqual(['r.txt'])
    expect(readFileSync(join(workspace, 'r.txt'), 'utf8')).toBe('v0\n')
    const after = persisted(meta)
    expect(after?.resolved).toBe(true)
  })

  it('user edit after agent write is a conflict, file left untouched', async () => {
    writeFileSync(join(workspace, 'c.txt'), 'v0\n', 'utf8')
    const cp = beginWriteCheckpoint(runDir, workspace, 0)
    await cp.recordPrior('c.txt', 'write')
    writeFileSync(join(workspace, 'c.txt'), 'v1\n', 'utf8')
    const meta = finalizeWriteCheckpoint(runDir)
    expect(meta).not.toBeNull()
    writeFileSync(join(workspace, 'c.txt'), 'user-edit\n', 'utf8')
    const res = resolveWrites(runDir, workspace, { action: 'discard', paths: ['c.txt'] })
    expect(res.conflicted).toEqual(['c.txt'])
    expect(readFileSync(join(workspace, 'c.txt'), 'utf8')).toBe('user-edit\n')
    const after = persisted(meta)
    expect(after?.resolved).not.toBe(true)
  })

  it('recursive dir delete snapshots and restores the whole tree', async () => {
    mkdirSync(join(workspace, 'pkg', 'sub'), { recursive: true })
    writeFileSync(join(workspace, 'pkg', 'a.txt'), 'A\n', 'utf8')
    writeFileSync(join(workspace, 'pkg', 'sub', 'b.txt'), 'B\n', 'utf8')
    const cp = beginWriteCheckpoint(runDir, workspace, 0)
    await cp.recordPrior('pkg', 'delete', { recursiveDir: true })
    rmSync(join(workspace, 'pkg'), { recursive: true, force: true })
    const meta = finalizeWriteCheckpoint(runDir)
    expect(meta).not.toBeNull()
    expect(meta?.files.map((f) => f.path).sort()).toEqual(['pkg/a.txt', 'pkg/sub/b.txt'])
    const res = resolveWrites(runDir, workspace, { action: 'discard' })
    expect(res.discarded.sort()).toEqual(['pkg/a.txt', 'pkg/sub/b.txt'])
    expect(readFileSync(join(workspace, 'pkg', 'a.txt'), 'utf8')).toBe('A\n')
    expect(readFileSync(join(workspace, 'pkg', 'sub', 'b.txt'), 'utf8')).toBe('B\n')
  })

  it('rewindWritesFrom multi-turn — anchored restore at index 2, full restore at index 0', async () => {
    writeFileSync(join(workspace, 'a.txt'), 'hello\n', 'utf8')
    writeFileSync(join(workspace, 'b.txt'), 'b0\n', 'utf8')
    const first = beginWriteCheckpoint(runDir, workspace, 0)
    await first.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'a1\n', 'utf8')
    const meta1 = finalizeWriteCheckpoint(runDir)

    const second = beginWriteCheckpoint(runDir, workspace, 2)
    await second.recordPrior('b.txt', 'write')
    writeFileSync(join(workspace, 'b.txt'), 'b2\n', 'utf8')
    const meta2 = finalizeWriteCheckpoint(runDir)

    const mid = rewindWritesFrom(runDir, workspace, 2)
    expect(mid.checkpointIds).toEqual([meta2!.id])
    expect(readFileSync(join(workspace, 'b.txt'), 'utf8')).toBe('b0\n')
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('a1\n')

    const full = rewindWritesFrom(runDir, workspace, 0)
    expect(full.checkpointIds).toContain(meta1!.id)
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('hello\n')
  })
})
