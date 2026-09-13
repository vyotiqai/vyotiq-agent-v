import { describe, expect, it } from 'vitest'
import { lowerProcessPriority } from '@main/agent/processPriority'
import { CODE_INDEX_RECONCILE_WALK_CAP, INDEX_SCAN_CAP } from '@main/agent/codeindex/types'

describe('processPriority', () => {
  it('lowerProcessPriority is best-effort and does not throw', () => {
    expect(() => lowerProcessPriority(process.pid)).not.toThrow()
    expect(lowerProcessPriority(-1)).toBe(false)
    expect(lowerProcessPriority(0)).toBe(false)
  })
})

describe('codeindex RECONCILE_WALK_CAP', () => {
  it('is finite and at least 2× scan cap', () => {
    expect(INDEX_SCAN_CAP).toBe(24000)
    expect(Number.isFinite(CODE_INDEX_RECONCILE_WALK_CAP)).toBe(true)
    expect(CODE_INDEX_RECONCILE_WALK_CAP).toBeGreaterThanOrEqual(INDEX_SCAN_CAP * 2)
  })
})

describe('index sync progress', () => {
  it('publishes live counters into runtime status', async () => {
    const { publishIndexSyncProgress } = await import('@main/agent/codeindex/indexProgress')
    const {
      getCodeIndexRuntimeStatus,
      resetCodeIndexRuntimeStatusForTests
    } = await import('@main/agent/codeindex/status')
    resetCodeIndexRuntimeStatusForTests()
    publishIndexSyncProgress(
      {
        stage: 'scanning',
        filesDone: 3,
        filesTotal: 10,
        indexed: 1,
        skipped: 2,
        currentPath: 'src/a.ts'
      },
      { force: true }
    )
    const st = getCodeIndexRuntimeStatus()
    expect(st.phase).toBe('syncing')
    expect(st.indexProgress?.filesDone).toBe(3)
    expect(st.indexProgress?.indexed).toBe(1)
    expect(st.indexProgress?.currentPath).toBe('src/a.ts')
    expect(st.progress).toBeCloseTo(0.3, 5)
    expect(st.message).toMatch(/Indexing|files/i)
    resetCodeIndexRuntimeStatusForTests()
  })

  it('syncCodeIndex accepts a precollected walk without changing skip semantics', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const { syncCodeIndex } = await import('@main/agent/codeindex/sync')
    const { CodeIndexStore } = await import('@main/agent/codeindex/store')
    const root = mkdtempSync(join(tmpdir(), 'vyotiq-sync-progress-'))
    try {
      writeFileSync(join(root, 'a.ts'), 'export const a = 1\n', 'utf8')
      writeFileSync(join(root, 'b.ts'), 'export const b = 2\n', 'utf8')
      const store = CodeIndexStore.openMemory()
      const files = [
        { full: join(root, 'a.ts'), rel: 'a.ts' },
        { full: join(root, 'b.ts'), rel: 'b.ts' }
      ]
      const first = await syncCodeIndex(root, store, { files })
      expect(first.indexed).toBe(2)
      expect(first.syncComplete).toBe(true)
      const second = await syncCodeIndex(root, store, { files })
      expect(second.indexed).toBe(0)
      expect(second.skipped).toBe(2)
      store.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
