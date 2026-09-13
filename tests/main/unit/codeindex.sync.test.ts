import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { syncCodeIndex } from '@main/agent/codeindex/sync'
import { CodeIndexStore } from '@main/agent/codeindex/store'
import type { IndexProgressUpdate } from '@main/agent/codeindex/indexProgress'

let workspace: string

afterEach(() => {
  if (workspace && existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
})

function writeRepo(): string {
  workspace = mkdtempSync(join(tmpdir(), 'vyotiq-codeindex-sync-'))
  mkdirSync(join(workspace, 'src'), { recursive: true })
  writeFileSync(
    join(workspace, 'src', 'auth.ts'),
    'export function loginUser(email: string) {\n  return email\n}\n',
    'utf8'
  )
  writeFileSync(
    join(workspace, 'src', 'refund.ts'),
    'export function refundOrder(orderId: string) {\n  return orderId\n}\n',
    'utf8'
  )
  // Lockfiles and tests/ are never indexed.
  writeFileSync(join(workspace, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8')
  mkdirSync(join(workspace, 'tests'), { recursive: true })
  writeFileSync(join(workspace, 'tests', 'auth.test.ts'), 'it("x", () => {})\n', 'utf8')
  return workspace
}

describe('syncCodeIndex', () => {
  it('indexes production source, skipping tests and lockfiles', async () => {
    const ws = writeRepo()
    const store = CodeIndexStore.openMemory()
    const result = await syncCodeIndex(ws, store)
    expect(result.indexed).toBe(2)
    expect(result.skipped).toBe(0)
    expect(result.syncComplete).toBe(true)
    expect(store.listFilePaths().sort()).toEqual(['src/auth.ts', 'src/refund.ts'])
    store.close()
  })

  it('skips unchanged files by mtime+size and by content hash', async () => {
    const ws = writeRepo()
    const store = CodeIndexStore.openMemory()
    const first = await syncCodeIndex(ws, store)
    expect(first.indexed).toBe(2)

    // No changes at all → everything skipped, nothing re-indexed.
    const second = await syncCodeIndex(ws, store)
    expect(second.indexed).toBe(0)
    expect(second.skipped).toBe(2)

    // Content change (mtime bumped) → re-index.
    writeFileSync(join(ws, 'src', 'auth.ts'), 'export function loginUser2() {}\n', 'utf8')
    const third = await syncCodeIndex(ws, store)
    expect(third.indexed).toBe(1)
    expect(store.getStatus().chunkCount).toBeGreaterThan(0)

    // Same new content but a newer mtime: hash fast path still skips.
    const f = join(ws, 'src', 'auth.ts')
    const st = await import('fs').then((m) => m.statSync(f))
    utimesSync(f, st.atime, new Date(st.mtimeMs + 5000))
    const fourth = await syncCodeIndex(ws, store)
    expect(fourth.indexed).toBe(0)
    store.close()
  })

  it('removes deleted files on reconcile', async () => {
    const ws = writeRepo()
    const store = CodeIndexStore.openMemory()
    await syncCodeIndex(ws, store)
    rmSync(join(ws, 'src', 'refund.ts'))
    const result = await syncCodeIndex(ws, store)
    expect(result.removed).toBe(1)
    expect(store.listFilePaths()).toEqual(['src/auth.ts'])
    store.close()
  })

  it('pages large trees via the cursor and reconciles on the last page', async () => {
    const ws = writeRepo()
    const store = CodeIndexStore.openMemory()
    // pageCap=1 forces one file per pass; the reconcile walk cap stays above it.
    const page1 = await syncCodeIndex(ws, store, { pageCap: 1 })
    expect(page1.syncComplete).toBe(false)
    expect(page1.cursor).not.toBeNull()
    expect(store.getMeta('syncComplete')).toBe('false')
    const page2 = await syncCodeIndex(ws, store, { pageCap: 1 })
    expect(page2.syncComplete).toBe(true)
    expect(store.listFilePaths().sort()).toEqual(['src/auth.ts', 'src/refund.ts'])
    expect(store.getMeta('syncComplete')).toBe('true')
    store.close()
  })

  it('reports progress with file counters and no embed stage', async () => {
    const ws = writeRepo()
    const store = CodeIndexStore.openMemory()
    const updates: IndexProgressUpdate[] = []
    await syncCodeIndex(ws, store, {
      onProgress: (update) => updates.push({ ...update })
    })
    const stages = updates.map((u) => u.stage)
    expect(stages[0]).toBe('walking')
    expect(stages).toContain('scanning')
    expect(stages[stages.length - 1]).toBe('done')
    expect(stages).not.toContain('embedding')
    for (const u of updates) {
      expect(u).not.toHaveProperty('embedChunks')
      expect(u).not.toHaveProperty('kind')
    }
    store.close()
  })
})
