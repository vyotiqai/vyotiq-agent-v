/**
 * The dense embedding pass shares the single-flight index queue with every
 * search and re-sync. It must yield to interactive work between batches, pick
 * up where it stopped, and stop quietly when its workspace is disposed.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const BATCH_MS = 300
const embedded = vi.hoisted(() => ({ calls: [] as number[], texts: 0 }))

vi.mock('@main/agent/codeindex/embed/embedModels', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/codeindex/embed/embedModels')>()
  return {
    ...actual,
    embedModelFilesPresent: () => true,
    ensureEmbedModelFiles: async () => undefined
  }
})
vi.mock('@main/agent/codeindex/embed/embedUtilityClient', () => ({
  getEmbedUtilityClient: () => ({
    ensure: async () => undefined,
    embed: async (texts: string[]) => {
      embedded.calls.push(Date.now())
      embedded.texts += texts.length
      await new Promise((r) => setTimeout(r, BATCH_MS))
      return texts.map(() => {
        const v = new Float32Array(384)
        v[0] = 1
        return v
      })
    }
  })
}))

import { logger } from '@shared/logger'
import { setWorkspaceIndexStorageRootOverrideForTests } from '@main/agent/indexStoragePaths'
import {
  disposeCodeIndexWorkspace,
  ensureCodeIndexSynced,
  getOrOpenCodeIndexStore
} from '@main/agent/codeindex'
import { disposeWorkspaceIndexes } from '@main/agent/workspaceIndex'
import {
  enqueueIndexJob,
  indexJobQueueActivePriorityForTests,
  indexJobQueueIsBusyForTests,
  resetIndexJobQueueForTests
} from '@main/agent/indexJobQueue'

const storage = mkdtempSync(join(tmpdir(), 'vyotiq-dense-preempt-idx-'))
setWorkspaceIndexStorageRootOverrideForTests(storage)
const workspaces: string[] = []

function workspaceWithChunks(files: number): string {
  const ws = mkdtempSync(join(tmpdir(), 'vyotiq-dense-preempt-ws-'))
  workspaces.push(ws)
  mkdirSync(join(ws, 'src'), { recursive: true })
  for (let f = 0; f < files; f++) {
    const body = Array.from(
      { length: 20 },
      (_, i) => `export function fn_${f}_${i}(a: number): number {\n  return a + ${i}\n}\n`
    ).join('\n')
    writeFileSync(join(ws, 'src', `m${f}.ts`), body, 'utf8')
  }
  return ws
}

afterAll(() => {
  resetIndexJobQueueForTests()
  for (const ws of workspaces) disposeCodeIndexWorkspace(ws)
  setWorkspaceIndexStorageRootOverrideForTests(null)
  for (const dir of [...workspaces, storage]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows may briefly hold the sqlite handle.
    }
  }
})

describe('dense warm job', () => {
  it('lets an interactive job in after the batch in flight, then resumes', async () => {
    embedded.calls.length = 0
    embedded.texts = 0
    const ws = workspaceWithChunks(10)
    const { sync } = await ensureCodeIndexSynced(ws)
    const total = sync?.status.chunkCount ?? 0
    expect(total).toBeGreaterThan(100)

    await vi.waitFor(() => expect(embedded.calls.length).toBeGreaterThan(0), { timeout: 10_000 })
    expect(indexJobQueueActivePriorityForTests()).toBe('warm')
    const callsAtEnqueue = embedded.calls.length
    await enqueueIndexJob({ priority: 'interactive', run: async () => undefined })
    // Only the batch already in flight may finish ahead of it.
    expect(embedded.calls.length - callsAtEnqueue).toBeLessThanOrEqual(1)

    // The requeued pass finishes the rest without re-embedding anything.
    await vi.waitFor(
      () => {
        const dense = getOrOpenCodeIndexStore(ws).denseStatus()
        expect(dense.vectorized).toBe(dense.total)
      },
      { timeout: 20_000 }
    )
    expect(embedded.texts).toBe(getOrOpenCodeIndexStore(ws).denseStatus().total)
    await vi.waitFor(() => expect(indexJobQueueIsBusyForTests()).toBe(false), { timeout: 5_000 })
  }, 60_000)

  it('stops quietly when its workspace is disposed', async () => {
    embedded.calls.length = 0
    const warn = vi.spyOn(logger, 'warn')
    const ws = workspaceWithChunks(6)
    await ensureCodeIndexSynced(ws)
    await vi.waitFor(() => expect(embedded.calls.length).toBeGreaterThan(0), { timeout: 10_000 })

    disposeWorkspaceIndexes(ws)
    const callsAtDispose = embedded.calls.length
    await new Promise((r) => setTimeout(r, BATCH_MS * 3))

    expect(embedded.calls.length).toBe(callsAtDispose)
    expect(warn.mock.calls.some(([message]) => message === 'Dense vector warm job failed')).toBe(
      false
    )
    warn.mockRestore()
  }, 60_000)
})
