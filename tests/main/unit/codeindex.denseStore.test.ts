import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { CodeIndexStore } from '@main/agent/codeindex/store'
import { CODE_INDEX_SCHEMA_VERSION } from '@main/agent/codeindex/types'

const DENSE_COLUMNS = [
  'id',
  'path',
  'start_line',
  'end_line',
  'kind',
  'name',
  'parent_name',
  'text',
  'vec'
]

function denseColumns(store: CodeIndexStore): string[] {
  return (store.db.prepare('PRAGMA table_info(dense_chunks)').all() as { name: string }[]).map(
    (r) => r.name
  )
}

function denseIndexes(store: CodeIndexStore): string[] {
  return (store.db.prepare('PRAGMA index_list(dense_chunks)').all() as { name: string }[]).map(
    (r) => r.name
  )
}

function tableColumns(dbPath: string, table: string): string[] {
  const raw = new DatabaseSync(dbPath)
  try {
    return (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  } finally {
    raw.close()
  }
}

function rawDenseRows(store: CodeIndexStore): {
  id: number
  path: string
  start_line: number
  end_line: number
  kind: string
  name: string
  parent_name: string | null
  text: string
  vec: Buffer | null
}[] {
  return store.db
    .prepare(
      `SELECT id, path, start_line, end_line, kind, name, parent_name, text, vec
       FROM dense_chunks ORDER BY id`
    )
    .all() as never
}

/**
 * Current-version store with a structurally foreign dense_chunks table carrying
 * a stale row: the migrate() rebuild must DROP dense_chunks so the row never
 * survives, then recreate the table with the expected columns.
 */
function createForeignDenseStoreDb(dbPath: string): void {
  const raw = new DatabaseSync(dbPath)
  raw.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE files (
      path TEXT PRIMARY KEY,
      file_hash TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL
    );
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      parent_name TEXT
    );
    CREATE VIRTUAL TABLE chunks_fts USING fts5(
      chunk_id UNINDEXED,
      path,
      name,
      body,
      tokenize = 'trigram'
    );
    CREATE TABLE dense_chunks (id INTEGER PRIMARY KEY, path TEXT NOT NULL, embedding BLOB);
    INSERT INTO dense_chunks(id, path, embedding) VALUES(1, 'src/legacy.ts', NULL);
    INSERT INTO files(path, file_hash, mtime_ms, size_bytes)
      VALUES('src/legacy.ts', 'legacy-hash', 100, 50);
    INSERT INTO chunks(id, path, start_line, end_line, kind, name, parent_name)
      VALUES(1, 'src/legacy.ts', 1, 10, 'function', 'legacyFn', NULL);
  `)
  raw.prepare(`INSERT INTO meta(key, value) VALUES('schemaVersion', ?)`).run(
    CODE_INDEX_SCHEMA_VERSION
  )
  raw.close()
}

function replaceWithText(
  store: CodeIndexStore,
  path: string,
  chunks: { startLine: number; endLine: number; name: string; text: string }[]
): void {
  store.replaceFileChunks(
    path,
    `hash-${path}`,
    100,
    50,
    chunks.map((c) => ({
      startLine: c.startLine,
      endLine: c.endLine,
      kind: 'function' as const,
      name: c.name,
      ftsBody: c.text,
      text: c.text
    }))
  )
}

describe('CodeIndexStore dense layer', () => {
  it('migrates a fresh store with dense_chunks, a path index, and the partial pending index', () => {
    const store = CodeIndexStore.openMemory()
    expect(store.getMeta('schemaVersion')).toBe(CODE_INDEX_SCHEMA_VERSION)
    expect(denseColumns(store)).toEqual(DENSE_COLUMNS)
    const indexes = denseIndexes(store)
    expect(indexes).toContain('idx_dense_chunks_path')
    expect(indexes).toContain('idx_dense_chunks_vec_pending')
    // The pending index is partial: its SQL restricts to vec IS NULL.
    const sqls = (
      store.db
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_dense_chunks_vec_pending'`)
        .get() as { sql: string }
    ).sql
    expect(sqls.toUpperCase()).toContain('WHERE VEC IS NULL')
    store.close()
  })

  it('rebuilds a foreign dense_chunks table and drops its stale rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-codeindex-dense-'))
    const dbPath = join(dir, 'index.sqlite')
    createForeignDenseStoreDb(dbPath)
    const store = CodeIndexStore.openDbPath(dbPath)
    expect(store.getMeta('schemaVersion')).toBe(CODE_INDEX_SCHEMA_VERSION)
    // Stale dense row did not survive the rebuild.
    expect(store.denseStatus()).toEqual({ total: 0, vectorized: 0 })
    // The recreated table matches the current CREATE column set exactly.
    expect(tableColumns(dbPath, 'dense_chunks')).toEqual(DENSE_COLUMNS)
    expect(denseColumns(store)).toEqual(DENSE_COLUMNS)
    store.close()
  })

  it('writes dense rows in the same transaction with ids matching the chunks', () => {
    const store = CodeIndexStore.openMemory()
    replaceWithText(store, 'src/auth.ts', [
      { startLine: 1, endLine: 12, name: 'loginUser', text: 'export function loginUser() {}' },
      { startLine: 20, endLine: 30, name: 'AuthService', text: 'export class AuthService {}' }
    ])
    expect(store.denseStatus()).toEqual({ total: 2, vectorized: 0 })
    const rows = rawDenseRows(store)
    const chunkIds = (
      store.db.prepare('SELECT id FROM chunks WHERE path = ? ORDER BY start_line').all('src/auth.ts') as {
        id: number
      }[]
    ).map((r) => r.id)
    expect(chunkIds).toHaveLength(2)
    expect(rows.map((r) => r.id)).toEqual(chunkIds)
    expect(rows[0]).toMatchObject({
      path: 'src/auth.ts',
      start_line: 1,
      end_line: 12,
      kind: 'function',
      name: 'loginUser',
      parent_name: null,
      text: 'export function loginUser() {}',
      vec: null
    })
    store.close()
  })

  it('inserts no dense rows when text is absent, and re-replace clears stale dense rows', () => {
    const store = CodeIndexStore.openMemory()
    replaceWithText(store, 'src/auth.ts', [
      { startLine: 1, endLine: 10, name: 'fnA', text: 'function fnA() {}' }
    ])
    expect(store.denseStatus().total).toBe(1)
    // Reindex the same file without text: dense rows for the path must go.
    store.replaceFileChunks('src/auth.ts', 'hash-2', 200, 50, [
      { startLine: 1, endLine: 4, kind: 'module', name: 'auth module', ftsBody: 'auth module' }
    ])
    expect(store.denseStatus()).toEqual({ total: 0, vectorized: 0 })
    expect(store.getStatus().chunkCount).toBe(1)
    store.close()
  })

  it('cleans dense rows in deleteFilesNotIn', () => {
    const store = CodeIndexStore.openMemory()
    replaceWithText(store, 'src/auth.ts', [
      { startLine: 1, endLine: 10, name: 'fnA', text: 'function fnA() {}' }
    ])
    replaceWithText(store, 'src/payments/refund.ts', [
      { startLine: 5, endLine: 15, name: 'refundOrder', text: 'function refundOrder() {}' }
    ])
    expect(store.denseStatus().total).toBe(2)
    const removed = store.deleteFilesNotIn(new Set(['src/auth.ts']))
    expect(removed).toBe(1)
    const rows = rawDenseRows(store)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.path).toBe('src/auth.ts')
    expect(store.denseStatus()).toEqual({ total: 1, vectorized: 0 })
    store.close()
  })

  it('rolls back chunks and dense rows together when an insert fails mid-transaction', () => {
    const store = CodeIndexStore.openMemory()
    replaceWithText(store, 'src/auth.ts', [
      { startLine: 1, endLine: 10, name: 'fnA', text: 'function fnA() {}' }
    ])
    const before = { files: store.getStatus().fileCount, chunks: store.getStatus().chunkCount }
    // Chunk 1 is valid; chunk 2 carries an unsupported binding value in text,
    // which fails the dense insert after its chunk row was written.
    expect(() =>
      store.replaceFileChunks('src/b.ts', 'hash-b', 300, 20, [
        {
          startLine: 1,
          endLine: 5,
          kind: 'function',
          name: 'okFn',
          ftsBody: 'okFn body',
          text: 'function okFn() {}'
        },
        {
          startLine: 6,
          endLine: 8,
          kind: 'function',
          name: 'badFn',
          ftsBody: 'badFn body',
          text: { bad: true } as unknown as string
        }
      ])
    ).toThrow()
    // Everything rolled back: no file b, no chunks, no dense rows.
    expect(store.getStatus().fileCount).toBe(before.files)
    expect(store.getStatus().chunkCount).toBe(before.chunks)
    expect(store.denseStatus()).toEqual({ total: 1, vectorized: 0 })
    expect(rawDenseRows(store).every((r) => r.path === 'src/auth.ts')).toBe(true)
    store.close()
  })

  it('returns pending rows in id order with a limit, skipping vectorized rows', () => {
    const store = CodeIndexStore.openMemory()
    replaceWithText(store, 'src/auth.ts', [
      { startLine: 1, endLine: 10, name: 'fnA', text: 'function fnA() {}' },
      { startLine: 11, endLine: 20, name: 'fnB', text: 'function fnB() {}' },
      { startLine: 21, endLine: 30, name: 'fnC', text: 'function fnC() {}' }
    ])
    const ids = (rawDenseRows(store) as { id: number }[]).map((r) => r.id)
    const [first, second] = ids
    store.setDenseVector(second!, new Float32Array([1, 0, 0]))
    const pending = store.pendingDenseBatch(10)
    expect(pending.map((r) => r.id)).toEqual([first, ids[2]])
    expect(pending[0]!.text).toBe('function fnA() {}')
    // Limit returns the first N pending rows in id order.
    expect(store.pendingDenseBatch(1).map((r) => r.id)).toEqual([first])
    store.close()
  })

  it('round-trips vectors through setDenseVector / iterateDenseVectors exactly', () => {
    const store = CodeIndexStore.openMemory()
    replaceWithText(store, 'src/auth.ts', [
      { startLine: 1, endLine: 10, name: 'fnA', text: 'function fnA() {}' },
      { startLine: 11, endLine: 20, name: 'fnB', text: 'function fnB() {}' }
    ])
    const ids = (rawDenseRows(store) as { id: number }[]).map((r) => r.id)
    const values = [1.5, -2.25, Math.fround(0.1), 0, -0, Number.MIN_VALUE, 3.4e38, -7]
    store.setDenseVector(ids[0]!, Float32Array.from(values.map((v) => Math.fround(v))))
    store.setDenseVector(ids[1]!, Float32Array.from([-0, 0, 1, -1, Math.fround(0.5)]))

    const iterated = [...store.iterateDenseVectors()]
    expect(iterated).toHaveLength(2)
    const first = iterated.find((r) => r.id === ids[0])!
    expect(first.vec.length).toBe(values.length)
    for (let i = 0; i < values.length; i++) {
      // Exact float round-trip, and Object.is to distinguish +0 from -0.
      expect(Object.is(first.vec[i], Math.fround(values[i]!))).toBe(true)
    }
    const second = iterated.find((r) => r.id === ids[1])!
    expect(Object.is(second!.vec[0], -0)).toBe(true)
    expect(Object.is(second!.vec[1], 0)).toBe(true)
    store.close()
  })

  it('rejects vectors whose length mismatches the configured dimension or the stored one', () => {
    const store = CodeIndexStore.openMemory()
    replaceWithText(store, 'src/auth.ts', [
      { startLine: 1, endLine: 10, name: 'fnA', text: 'function fnA() {}' }
    ])
    const id = (rawDenseRows(store) as { id: number }[])[0]!.id
    // No model configured yet: the first vector fixes the row length.
    store.setDenseVector(id, new Float32Array([1, 2, 3]))
    expect(() => store.setDenseVector(id, new Float32Array([1, 2, 3, 4]))).toThrow(/length 4.*existing vector length 3/)
    // Once a model is configured, the configured dim is authoritative —
    // checked on a fresh row so the existing-vector guard doesn't fire first.
    store.setDenseModel('mock-embed', 4)
    replaceWithText(store, 'src/other.ts', [
      { startLine: 1, endLine: 10, name: 'fnB', text: 'function fnB() {}' }
    ])
    const otherId = (rawDenseRows(store) as { id: number }[]).find((r) => r.path === 'src/other.ts')!.id
    expect(() => store.setDenseVector(otherId, new Float32Array([1, 2, 3]))).toThrow(/dense dimension 4/)
    store.close()
  })

  it('reports denseStatus counts', () => {
    const store = CodeIndexStore.openMemory()
    expect(store.denseStatus()).toEqual({ total: 0, vectorized: 0 })
    replaceWithText(store, 'src/auth.ts', [
      { startLine: 1, endLine: 10, name: 'fnA', text: 'function fnA() {}' },
      { startLine: 11, endLine: 20, name: 'fnB', text: 'function fnB() {}' }
    ])
    expect(store.denseStatus()).toEqual({ total: 2, vectorized: 0 })
    const id = (rawDenseRows(store) as { id: number }[])[0]!.id
    store.setDenseVector(id, new Float32Array([1, 0]))
    expect(store.denseStatus()).toEqual({ total: 2, vectorized: 1 })
    store.close()
  })

  it('resetDenseVectors clears vectors and model meta but keeps texts', () => {
    const store = CodeIndexStore.openMemory()
    replaceWithText(store, 'src/auth.ts', [
      { startLine: 1, endLine: 10, name: 'fnA', text: 'function fnA() {}' }
    ])
    const id = (rawDenseRows(store) as { id: number }[])[0]!.id
    store.setDenseVector(id, new Float32Array([1, 2]))
    store.setDenseModel('mock-embed', 2)
    expect(store.denseStatus()).toEqual({ total: 1, vectorized: 1 })
    expect(store.pendingDenseBatch(10)).toEqual([])

    store.resetDenseVectors()
    expect(store.denseStatus()).toEqual({ total: 1, vectorized: 0 })
    expect(store.pendingDenseBatch(10)).toHaveLength(1)
    expect(store.getDenseModel()).toBeNull()
    expect(store.getMeta('denseModel')).toBeNull()
    expect(store.getMeta('denseDim')).toBeNull()
    store.close()
  })

  it('round-trips get/setDenseModel through the meta table', () => {
    const store = CodeIndexStore.openMemory()
    expect(store.getDenseModel()).toBeNull()
    store.setDenseModel('mock-embed', 384)
    expect(store.getDenseModel()).toEqual({ model: 'mock-embed', dim: 384 })
    expect(store.getMeta('denseDim')).toBe('384')
    store.setDenseModel('other-embed', 768)
    expect(store.getDenseModel()).toEqual({ model: 'other-embed', dim: 768 })
    store.close()
  })
})
