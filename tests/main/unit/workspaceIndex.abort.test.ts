import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearWorkspaceIndexSyncTimers,
  disposeWorkspaceIndexes,
  warmWorkspaceIndexes,
  workspaceIndexAbortSignal
} from '@main/agent/workspaceIndex'
import { closeCodeIndexStore } from '@main/agent/codeindex'
import { resetIndexJobQueueForTests, enqueueIndexJob } from '@main/agent/indexJobQueue'
import { resetCodeIndexRuntimeStatusForTests } from '@main/agent/codeindex/status'

describe('workspaceIndex abort + warm policy', () => {
  let dir: string | undefined

  afterEach(() => {
    clearWorkspaceIndexSyncTimers()
    resetIndexJobQueueForTests()
    resetCodeIndexRuntimeStatusForTests()
    if (dir) {
      disposeWorkspaceIndexes(dir)
      closeCodeIndexStore(dir)
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
      dir = undefined
    }
  })

  it('dispose aborts the per-workspace signal', () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-ws-abort-'))
    const signal = workspaceIndexAbortSignal(dir)
    expect(signal.aborted).toBe(false)
    disposeWorkspaceIndexes(dir)
    expect(signal.aborted).toBe(true)
  })

  it('dispose aborts in-flight warm without hanging the queue', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-ws-warm-abort-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')

    const signal = workspaceIndexAbortSignal(dir)
    warmWorkspaceIndexes(dir)
    await new Promise((r) => setImmediate(r))
    disposeWorkspaceIndexes(dir)
    expect(signal.aborted).toBe(true)

    // Queue must accept a subsequent job (prior warm must not deadlock concurrency=1).
    let ran = false
    await enqueueIndexJob({
      priority: 'interactive',
      run: async () => {
        ran = true
      }
    })
    expect(ran).toBe(true)
  })

  it('permanent dispose blocks follow-up warm (instance worktree teardown)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-ws-perm-dispose-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')

    warmWorkspaceIndexes(dir)
    await new Promise((r) => setImmediate(r))
    disposeWorkspaceIndexes(dir, { permanent: true })

    let warmRan = false
    const orig = await import('@main/agent/indexJobQueue')
    const spy = vi.spyOn(orig, 'enqueueIndexJob').mockImplementation(async (opts) => {
      warmRan = true
      return opts.run()
    })
    warmWorkspaceIndexes(dir)
    await new Promise((r) => setImmediate(r))
    expect(warmRan).toBe(false)
    spy.mockRestore()
  })

  it('dispose+reopen does not pin a stale coalesce abort', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-ws-coalesce-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')

    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    // Block the queue so the first warm stays pending (coalesced).
    const blocker = enqueueIndexJob({
      priority: 'reindex',
      run: async () => {
        await gate
      }
    })
    warmWorkspaceIndexes(dir)
    await new Promise((r) => setImmediate(r))
    disposeWorkspaceIndexes(dir)
    // Re-open: must schedule a fresh warm, not reuse an aborted coalesce promise.
    warmWorkspaceIndexes(dir)
    release()
    await blocker
    // Let warm drain; should not throw / hang.
    await new Promise((r) => setTimeout(r, 50))
    let ran = false
    await enqueueIndexJob({
      priority: 'interactive',
      run: async () => {
        ran = true
      }
    })
    expect(ran).toBe(true)
  })
})
