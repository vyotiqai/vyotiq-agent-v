import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { CodeIndexStore, createLocalHashEmbedder, syncCodeIndex } from '@main/agent/codeindex'

const tempDirs: string[] = []

function writeTree(dir: string): void {
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(
    join(dir, 'src', 'a.ts'),
    'export function reuseMarker(x: number): number {\n  return x + 1\n}\n',
    'utf8'
  )
}

function countingEmbedder(dimensions: number) {
  const base = createLocalHashEmbedder(dimensions)
  let calls = 0
  return {
    embedder: {
      modelId: base.modelId,
      dimensions: base.dimensions,
      async embed(texts: string[]) {
        calls += texts.length
        return base.embed(texts)
      }
    },
    get calls(): number {
      return calls
    }
  }
}

describe('codeindex worktree embedding reuse', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reuses parent embeddings for identical chunks — 0 embed calls', async () => {
    const parentDir = mkdtempSync(join(tmpdir(), 'vyotiq-reuse-parent-'))
    const childDir = mkdtempSync(join(tmpdir(), 'vyotiq-reuse-child-'))
    tempDirs.push(parentDir, childDir)
    writeTree(parentDir)
    writeTree(childDir)

    const parentDb = join(parentDir, 'parent-index.sqlite')
    const parentStore = CodeIndexStore.openDbPath(parentDb, 384)
    const parentCounter = countingEmbedder(384)
    try {
      const parentSync = await syncCodeIndex(parentDir, parentStore, parentCounter.embedder)
      expect(parentSync.indexed).toBeGreaterThan(0)
      expect(parentCounter.calls).toBeGreaterThan(0)

      const childDb = join(childDir, 'child-index.sqlite')
      const childCounter = countingEmbedder(384)
      const childStore = CodeIndexStore.openDbPath(childDb, 384, { reuseDbPath: parentDb })
      try {
        const childSync = await syncCodeIndex(childDir, childStore, childCounter.embedder)
        expect(childSync.indexed).toBeGreaterThan(0)
        // Identical content + same model salt → all chunks reused from parent DB.
        expect(childCounter.calls).toBe(0)
        expect(childStore.getStatus().chunkCount).toBe(parentStore.getStatus().chunkCount)
      } finally {
        childStore.close()
      }
    } finally {
      parentStore.close()
    }
  })

  it('falls back to embedding when the reuse DB dimensions mismatch', async () => {
    const parentDir = mkdtempSync(join(tmpdir(), 'vyotiq-reuse-dim-parent-'))
    const childDir = mkdtempSync(join(tmpdir(), 'vyotiq-reuse-dim-child-'))
    tempDirs.push(parentDir, childDir)
    writeTree(parentDir)
    writeTree(childDir)

    const parentDb = join(parentDir, 'parent-index.sqlite')
    const parentStore = CodeIndexStore.openDbPath(parentDb, 64)
    try {
      const parentSync = await syncCodeIndex(parentDir, parentStore, countingEmbedder(64).embedder)
      expect(parentSync.indexed).toBeGreaterThan(0)
    } finally {
      parentStore.close()
    }

    // Parent meta.dimensions = 64, child store opens at 384 → fallback disabled.
    const childCounter = countingEmbedder(384)
    const childStore = CodeIndexStore.openDbPath(join(childDir, 'child-index.sqlite'), 384, {
      reuseDbPath: parentDb
    })
    try {
      const childSync = await syncCodeIndex(childDir, childStore, childCounter.embedder)
      expect(childSync.indexed).toBeGreaterThan(0)
      expect(childCounter.calls).toBeGreaterThan(0)
    } finally {
      childStore.close()
    }
  })
})
