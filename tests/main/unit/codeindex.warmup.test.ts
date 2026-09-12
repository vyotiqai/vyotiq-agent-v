import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closeCodeIndexStore,
  disposeCodeIndexWorkspace,
  ensureCodeIndexSynced,
  getOrOpenCodeIndexStore,
  reindexCodeIndex,
  runCodebaseSearch
} from '@main/agent/codeindex'
import {
  clearWorkspaceIndexSyncTimers,
  disposeWorkspaceIndexes,
  scheduleWorkspaceIndexSync,
  warmWorkspaceIndexes
} from '@main/agent/workspaceIndex'
import {
  indexJobQueueIsBusyForTests,
  indexJobQueuePendingCountForTests,
  resetIndexJobQueueForTests
} from '@main/agent/indexJobQueue'
import { toolCodebaseSearch } from '@main/agent/tools/codebaseSearch'

describe('workspace index schedule debounce', () => {
  let dir: string | undefined

  afterEach(() => {
    clearWorkspaceIndexSyncTimers()
    resetIndexJobQueueForTests()
    if (dir) {
      disposeWorkspaceIndexes(dir)
      disposeCodeIndexWorkspace(dir)
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
        const { sync } = await ensureCodeIndexSynced(dir!)
        expect(sync?.status.chunkCount).toBeGreaterThan(0)
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

    const store = getOrOpenCodeIndexStore(dir)
    expect(store.getStatus().chunkCount).toBe(0)
    closeCodeIndexStore(dir)
  })
})

describe('reindexCodeIndex', () => {
  let dir: string | undefined

  afterEach(() => {
    resetIndexJobQueueForTests()
    if (dir) {
      disposeWorkspaceIndexes(dir)
      disposeCodeIndexWorkspace(dir)
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* windows sqlite */
      }
      dir = undefined
    }
  })

  it('forces a full sync through the reindex queue slot', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-reindex-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const reindexMarker = 1\n', 'utf8')
    const sync = await reindexCodeIndex(dir)
    expect(sync).not.toBeNull()
    expect(sync!.indexed).toBe(1)
    const store = getOrOpenCodeIndexStore(dir)
    expect(store.getStatus().ready).toBe(true)
    closeCodeIndexStore(dir)
  })
})

describe('codebase_search warm and result behavior', () => {
  let dir: string | undefined

  afterEach(() => {
    vi.restoreAllMocks()
    resetIndexJobQueueForTests()
    if (dir) {
      disposeWorkspaceIndexes(dir)
      disposeCodeIndexWorkspace(dir)
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* windows sqlite */
      }
      dir = undefined
    }
  })

  it('returns ranked hits with the honest header after a cold search', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-search-cold-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(
      join(dir, 'src', 'alpha.ts'),
      'export function alphaHelper(): number { return 1 }\n',
      'utf8'
    )
    const result = await runCodebaseSearch(dir, 'alphaHelper')
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits[0]!.path).toBe('src/alpha.ts')
    expect(result.formatted).toMatch(/^1\. src\/alpha\.ts:\d+-\d+/)
    // No model / fallback annotations anywhere in the output.
    expect(result.formatted).not.toMatch(/model=/)
    expect(result.formatted).not.toMatch(/fallback=/)
  })

  it('enqueues a warm job after interactive search', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-search-warm-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'a.ts'), 'export function alphaHelper(): number { return 1 }\n', 'utf8')
    const workspaceIndex = await import('@main/agent/workspaceIndex')
    const spy = vi.spyOn(workspaceIndex, 'warmWorkspaceIndexes')
    await toolCodebaseSearch(dir, 'alphaHelper')
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalledWith(dir)
    })
    spy.mockRestore()
  })

  it('forces a sync on refresh:true and still returns hits', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-search-refresh-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(
      join(dir, 'src', 'a.ts'),
      'export function refreshMarkerHelper(): number { return 2 }\n',
      'utf8'
    )
    const result = await runCodebaseSearch(dir, 'refreshMarkerHelper', { refresh: true })
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.status.ready).toBe(true)
  })

  it('tool output keeps the index header with chunk and file counts', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-tool-header-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'a.ts'), 'export function headerHelper(): number { return 3 }\n', 'utf8')
    const out = await toolCodebaseSearch(dir, 'headerHelper')
    expect(out).toMatch(/^index: \d+ chunks \/ \d+ files · hits=\d+/)
    expect(out).toContain('src/a.ts')
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
