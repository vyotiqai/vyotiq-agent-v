import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Keep the bundled llama.cpp stage hermetic in unit tests: without this, the
// optional `node-llama-cpp` dep would trigger a real 229 MB GGUF download from
// Hugging Face. The real path is covered by a separate runtime smoke check.
vi.mock('node-llama-cpp', () => ({
  getLlama: vi.fn().mockRejectedValue(new Error('node-llama-cpp mocked unavailable in unit tests')),
  resolveModelFile: vi.fn()
}))
import {
  CodeIndexStore,
  closeCodeIndex,
  disposeCodeIndexWorkspace,
  ensureCodeIndexSynced,
  reindexCodeIndex
} from '@main/agent/codeindex'
import {
  clearWorkspaceIndexSyncTimers,
  disposeWorkspaceIndexes,
  scheduleWorkspaceIndexSync,
  warmWorkspaceIndexes
} from '@main/agent/workspaceIndex'
import { closeSparseGrep, SparseGrepStore } from '@main/agent/sparsegrep'
import {
  indexJobQueueIsBusyForTests,
  indexJobQueuePendingCountForTests,
  resetIndexJobQueueForTests
} from '@main/agent/indexJobQueue'
import { DEFAULT_EMBED_DIM } from '@main/agent/codeindex/types'
import { toolCodebaseSearch } from '@main/agent/tools/codebaseSearch'

describe('workspace index schedule debounce', () => {
  let dir: string | undefined

  afterEach(() => {
    clearWorkspaceIndexSyncTimers()
    resetIndexJobQueueForTests()
    if (dir) {
      disposeWorkspaceIndexes(dir)
      disposeCodeIndexWorkspace(dir)
      closeCodeIndex(dir)
      closeSparseGrep(dir)
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // Windows may briefly retain sqlite handles; best-effort cleanup.
      }
      dir = undefined
    }
    vi.useRealTimers()
  })

  it('coalesces rapid schedules into one incremental sync', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-codeindex-warm-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(
      join(dir, 'src', 'a.ts'),
      'export function alphaHelper(): number { return 1 }\n',
      'utf8'
    )

    vi.useFakeTimers()
    scheduleWorkspaceIndexSync(dir, 400)
    scheduleWorkspaceIndexSync(dir, 400)
    scheduleWorkspaceIndexSync(dir, 400)

    await vi.advanceTimersByTimeAsync(400)
    await vi.waitFor(
      async () => {
        const { entry } = await ensureCodeIndexSynced(dir!)
        expect(entry?.store?.getStatus()?.chunkCount).toBeGreaterThan(0)
      },
      { timeout: 20_000 }
    )
  })

  it('dispose cancels a pending scheduled sync', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-codeindex-cancel-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'b.ts'), 'export const x = 1\n', 'utf8')

    vi.useFakeTimers()
    scheduleWorkspaceIndexSync(dir, 800)
    disposeWorkspaceIndexes(dir)
    await vi.advanceTimersByTimeAsync(800)
    // Let any stray warm promise settle if it somehow started.
    await Promise.resolve()

    const store = CodeIndexStore.open(dir, DEFAULT_EMBED_DIM)
    expect(store.getStatus().chunkCount).toBe(0)
    store.close()
  })
})

describe('reindexCodeIndex', () => {
  let dir: string | undefined

  afterEach(() => {
    resetIndexJobQueueForTests()
    if (dir) {
      disposeWorkspaceIndexes(dir)
      disposeCodeIndexWorkspace(dir)
      closeCodeIndex(dir)
      closeSparseGrep(dir)
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* windows sqlite */
      }
      dir = undefined
    }
  })

  it('also syncs sparsegrep in the same reindex job', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-reindex-sparse-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const reindexMarker = 1\n', 'utf8')
    // Hermetic: hash embedder needs no ONNX weights; reindex must honor the override.
    const sync = await reindexCodeIndex(dir, { embedderId: 'hash' })
    expect(sync).not.toBeNull()
    const sparse = SparseGrepStore.open(dir)
    try {
      expect(sparse.getStatus().fileCount).toBeGreaterThan(0)
      expect(sparse.listFilePaths()).toContain('src/a.ts')
    } finally {
      sparse.close()
    }
  })
})

describe('codebase_search follow-up warm', () => {
  let dir: string | undefined

  afterEach(() => {
    vi.restoreAllMocks()
    resetIndexJobQueueForTests()
    if (dir) {
      disposeWorkspaceIndexes(dir)
      disposeCodeIndexWorkspace(dir)
      closeCodeIndex(dir)
      closeSparseGrep(dir)
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* windows sqlite */
      }
      dir = undefined
    }
  })

  it('enqueues a full warm job after interactive search', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-search-warm-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'a.ts'), 'export function alphaHelper(): number { return 1 }\n', 'utf8')
    await ensureCodeIndexSynced(dir, { preferOllama: false })
    const workspaceIndex = await import('@main/agent/workspaceIndex')
    const spy = vi.spyOn(workspaceIndex, 'warmWorkspaceIndexes')
    await toolCodebaseSearch(dir, 'alphaHelper', { preferOllama: false })
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalledWith(dir)
    })
    spy.mockRestore()
  })

  it('enqueues a full warm job after a cold empty-index search', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-search-warm-cold-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(
      join(dir, 'src', 'a.ts'),
      'export function alphaHelper(): number { return 1 }\n',
      'utf8'
    )
    const workspaceIndex = await import('@main/agent/workspaceIndex')
    const spy = vi.spyOn(workspaceIndex, 'warmWorkspaceIndexes')
    await toolCodebaseSearch(dir, 'alphaHelper', { preferOllama: false })
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalledWith(dir)
    })
    spy.mockRestore()
  })

  it('enqueues a full warm job after refresh:true search', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-search-warm-refresh-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(
      join(dir, 'src', 'a.ts'),
      'export function alphaHelper(): number { return 1 }\n',
      'utf8'
    )
    await ensureCodeIndexSynced(dir, { preferOllama: false })
    const workspaceIndex = await import('@main/agent/workspaceIndex')
    const spy = vi.spyOn(workspaceIndex, 'warmWorkspaceIndexes')
    await toolCodebaseSearch(dir, 'alphaHelper', { preferOllama: false, refresh: true })
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalledWith(dir)
    })
    spy.mockRestore()
  })
})

describe('instance worktree mutation does not warm indexes', () => {
  afterEach(() => {
    clearWorkspaceIndexSyncTimers()
    resetIndexJobQueueForTests()
    vi.useRealTimers()
  })

  it('skips scheduleWorkspaceIndexSync for instance-worktrees paths', async () => {
    vi.useFakeTimers()
    const dir = join(tmpdir(), 'workspaces', 'abc', 'instance-worktrees', 'run-1')
    scheduleWorkspaceIndexSync(dir, 10)
    await vi.advanceTimersByTimeAsync(50)
    expect(indexJobQueuePendingCountForTests()).toBe(0)
    expect(indexJobQueueIsBusyForTests()).toBe(false)
  })

  it('warmWorkspaceIndexes still enqueues instance-worktrees on demand', () => {
    const dir = join(tmpdir(), 'workspaces', 'abc', 'instance-worktrees', `run-warm-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    warmWorkspaceIndexes(dir)
    expect(indexJobQueuePendingCountForTests() > 0 || indexJobQueueIsBusyForTests()).toBe(true)
    resetIndexJobQueueForTests()
    disposeWorkspaceIndexes(dir)
  })
})
