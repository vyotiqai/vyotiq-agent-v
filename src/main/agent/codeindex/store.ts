import { existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { DatabaseSync } from 'node:sqlite'
import type { ChunkKind, IndexStatus, StoredChunk } from './types'
import { DEFAULT_MODEL_ID } from './types'
import { bufferToEmbedding, embeddingToBuffer } from './embed'
import { codeindexDbPath, codeindexRoot } from '../indexStoragePaths'

export type ChunkRow = StoredChunk & {
  embedding: Float32Array
}

export { codeindexRoot, codeindexDbPath } from '../indexStoragePaths'

export class CodeIndexStore {
  readonly db: DatabaseSync
  readonly dbPath: string
  readonly dimensions: number

  /** Read-only fallback DB for getEmbeddingsByChunkHashes (parent-workspace reuse). */
  private reuseDbPath: string | null = null
  private reuseDb: DatabaseSync | null = null
  private reuseDbDisabled = false

  private constructor(db: DatabaseSync, dbPath: string, dimensions: number) {
    this.db = db
    this.dbPath = dbPath
    this.dimensions = dimensions
  }

  static open(
    workspacePath: string,
    dimensions: number,
    opts?: { reuseDbPath?: string }
  ): CodeIndexStore {
    const root = codeindexRoot(workspacePath)
    if (!existsSync(root)) mkdirSync(root, { recursive: true })
    return CodeIndexStore.openDbPath(codeindexDbPath(workspacePath), dimensions, opts)
  }

  static openDbPath(
    dbPath: string,
    dimensions: number,
    opts?: { reuseDbPath?: string }
  ): CodeIndexStore {
    const dir = dirname(dbPath)
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
    const db = new DatabaseSync(dbPath)
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec('PRAGMA synchronous = NORMAL;')
    // Main + utilityProcess may briefly contend on Windows; wait instead of failing.
    db.exec('PRAGMA busy_timeout = 5000;')
    migrate(db)
    const store = new CodeIndexStore(db, dbPath, dimensions)
    if (opts?.reuseDbPath) store.reuseDbPath = opts.reuseDbPath
    return store
  }

  /** In-memory store for unit tests. */
  static openMemory(dimensions: number): CodeIndexStore {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    return new CodeIndexStore(db, ':memory:', dimensions)
  }

  close(): void {
    try {
      this.reuseDb?.close()
    } catch {
      /* already closed */
    }
    try {
      this.db.close()
    } catch {
      /* already closed */
    }
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  }

  setMeta(key: string, value: string): void {
    this.db.prepare(
      'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, value)
  }

  getStatus(): IndexStatus {
    const fileCount = (
      this.db.prepare('SELECT COUNT(*) AS c FROM files').get() as { c: number }
    ).c
    const chunkCount = (
      this.db.prepare('SELECT COUNT(*) AS c FROM chunks').get() as { c: number }
    ).c
    const modelId = this.getMeta('modelId') ?? DEFAULT_MODEL_ID
    const lastIndexedAt = this.getMeta('lastIndexedAt')
    return {
      ready: chunkCount > 0,
      modelId,
      fileCount,
      chunkCount,
      lastIndexedAt
    }
  }

  getFileHash(path: string): string | null {
    const row = this.db.prepare('SELECT file_hash AS h FROM files WHERE path = ?').get(path) as
      | { h: string }
      | undefined
    return row?.h ?? null
  }

  getFileStamp(path: string): {
    hash: string
    mtimeMs: number
    size: number
    embedPending: boolean
  } | null {
    const row = this.db
      .prepare(
        `SELECT file_hash AS hash, mtime_ms AS mtimeMs, size_bytes AS size,
                embed_pending AS embedPending
         FROM files WHERE path = ?`
      )
      .get(path) as
      | { hash: string; mtimeMs: number; size: number | null; embedPending: number | null }
      | undefined
    if (!row || row.size == null || !Number.isFinite(row.size)) return null
    return {
      hash: row.hash,
      mtimeMs: row.mtimeMs,
      size: row.size,
      embedPending: row.embedPending === 1
    }
  }

  updateFileStamp(path: string, fileHash: string, mtimeMs: number, sizeBytes: number): void {
    this.db
      .prepare(
        'UPDATE files SET file_hash = ?, mtime_ms = ?, size_bytes = ? WHERE path = ?'
      )
      .run(fileHash, mtimeMs, sizeBytes, path)
  }

  /** Lookup embeddings keyed by chunk_hash (same model salt → reuse without re-embed). */
  getEmbeddingsByChunkHashes(hashes: string[]): Map<string, Float32Array> {
    const out = new Map<string, Float32Array>()
    if (!hashes.length) return out
    const uniq = [...new Set(hashes)]
    // SQLite default max variable count is often 999 — chunk large IN lists.
    const SQLITE_IN_CHUNK = 500
    for (let i = 0; i < uniq.length; i += SQLITE_IN_CHUNK) {
      const slice = uniq.slice(i, i + SQLITE_IN_CHUNK)
      const placeholders = slice.map(() => '?').join(',')
      const rows = this.db
        .prepare(
          `SELECT chunk_hash AS chunkHash, embedding FROM chunks WHERE chunk_hash IN (${placeholders})`
        )
        .all(...slice) as { chunkHash: string; embedding: Buffer }[]
      for (const r of rows) {
        if (!r.embedding || r.embedding.byteLength < 4) continue
        out.set(r.chunkHash, bufferToEmbedding(Buffer.from(r.embedding), this.dimensions))
      }
    }
    this.fillFromReuseDb(uniq, out)
    return out
  }

  /** Lazily open the read-only reuse DB; disable it permanently on any problem. */
  private openReuseDb(): DatabaseSync | null {
    if (this.reuseDbDisabled || !this.reuseDbPath) return null
    if (this.reuseDb) return this.reuseDb
    try {
      const db = new DatabaseSync(this.reuseDbPath, { readOnly: true })
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('dimensions') as
        | { value: string }
        | undefined
      if (!row || Number(row.value) !== this.dimensions) {
        db.close()
        this.reuseDbDisabled = true
        return null
      }
      this.reuseDb = db
      return db
    } catch {
      this.reuseDbDisabled = true
      return null
    }
  }

  /** Merge embeddings for misses from the reuse DB (never written to). */
  private fillFromReuseDb(uniq: string[], out: Map<string, Float32Array>): void {
    if (!this.reuseDbPath || out.size >= uniq.length) return
    const db = this.openReuseDb()
    if (!db) return
    const misses = uniq.filter((h) => !out.has(h))
    for (let i = 0; i < misses.length; i += 500) {
      const slice = misses.slice(i, i + 500)
      const placeholders = slice.map(() => '?').join(',')
      const rows = db
        .prepare(
          `SELECT chunk_hash AS chunkHash, embedding FROM chunks WHERE chunk_hash IN (${placeholders})`
        )
        .all(...slice) as { chunkHash: string; embedding: Buffer }[]
      for (const r of rows) {
        if (!r.embedding || r.embedding.byteLength < this.dimensions * 4) continue
        out.set(r.chunkHash, bufferToEmbedding(Buffer.from(r.embedding), this.dimensions))
      }
    }
  }

  listFilePaths(): string[] {
    const rows = this.db.prepare('SELECT path FROM files').all() as { path: string }[]
    return rows.map((r) => r.path)
  }

  deleteFile(path: string): void {
    const ids = this.db
      .prepare('SELECT id FROM chunks WHERE path = ?')
      .all(path) as { id: number }[]
    const delFts = this.db.prepare('DELETE FROM chunks_fts WHERE chunk_id = ?')
    for (const { id } of ids) delFts.run(String(id))
    this.db.prepare('DELETE FROM chunks WHERE path = ?').run(path)
    this.db.prepare('DELETE FROM files WHERE path = ?').run(path)
  }

  /** Delete every file path not in `seen` in one IMMEDIATE transaction. */
  deleteFilesNotIn(seen: ReadonlySet<string>): number {
    const stale = this.listFilePaths().filter((path) => !seen.has(path))
    if (stale.length === 0) return 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const path of stale) this.deleteFile(path)
      this.db.exec('COMMIT')
      return stale.length
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw err
    }
  }

  upsertFile(
    path: string,
    fileHash: string,
    mtimeMs: number,
    sizeBytes: number,
    embedPending = false
  ): void {
    this.db
      .prepare(
        `INSERT INTO files(path, file_hash, mtime_ms, size_bytes, embed_pending) VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET file_hash = excluded.file_hash, mtime_ms = excluded.mtime_ms, size_bytes = excluded.size_bytes, embed_pending = excluded.embed_pending`
      )
      .run(path, fileHash, mtimeMs, sizeBytes, embedPending ? 1 : 0)
  }

  replaceFileChunks(
    path: string,
    fileHash: string,
    mtimeMs: number,
    chunks: {
      startLine: number
      endLine: number
      kind: ChunkKind
      name: string
      parentName?: string
      chunkHash: string
      embedding: Float32Array
      ftsText: string
    }[],
    sizeBytes = 0,
    embedPending = false
  ): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.deleteFile(path)
      this.upsertFile(path, fileHash, mtimeMs, sizeBytes, embedPending)
      const insert = this.db.prepare(
        `INSERT INTO chunks(path, start_line, end_line, kind, name, parent_name, chunk_hash, embedding)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
      )
      const insertFts = this.db.prepare(
        `INSERT INTO chunks_fts(chunk_id, path, name, parent_name, body) VALUES(?, ?, ?, ?, ?)`
      )
      for (const c of chunks) {
        const info = insert.run(
          path,
          c.startLine,
          c.endLine,
          c.kind,
          c.name,
          c.parentName ?? null,
          c.chunkHash,
          embeddingToBuffer(c.embedding)
        )
        const id = Number(info.lastInsertRowid)
        insertFts.run(String(id), path, c.name, c.parentName ?? '', c.ftsText)
      }
      this.db.exec('COMMIT')
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw err
    }
  }

  loadAllEmbeddings(): { id: number; embedding: Float32Array }[] {
    const rows = this.db.prepare('SELECT id, embedding FROM chunks').all() as {
      id: number
      embedding: Buffer
    }[]
    return rows
      .filter((r) => r.embedding && r.embedding.byteLength >= 4)
      .map((r) => ({
        id: r.id,
        embedding: bufferToEmbedding(Buffer.from(r.embedding), this.dimensions)
      }))
  }

  *iterateEmbeddings(): Generator<{ id: number; embedding: Float32Array }, void, undefined> {
    const stmt = this.db.prepare('SELECT id, embedding FROM chunks')
    const rows = stmt.iterate() as IterableIterator<{ id: number; embedding: Buffer }>
    for (const r of rows) {
      if (!r.embedding || r.embedding.byteLength < 4) continue
      yield {
        id: r.id,
        embedding: bufferToEmbedding(Buffer.from(r.embedding), this.dimensions)
      }
    }
  }

  getChunk(id: number): StoredChunk | null {
    const row = this.db
      .prepare(
        `SELECT id, path, start_line AS startLine, end_line AS endLine, kind, name,
                parent_name AS parentName, chunk_hash AS chunkHash
         FROM chunks WHERE id = ?`
      )
      .get(id) as
      | {
          id: number
          path: string
          startLine: number
          endLine: number
          kind: ChunkKind
          name: string
          parentName: string | null
          chunkHash: string
        }
      | undefined
    return row ?? null
  }

  searchFts(query: string, limit: number): number[] {
    const tokens = ftsQueryTokens(query)
    const q = tokensToMatchQuery(tokens)
    const ids: number[] = []
    const seen = new Set<number>()
    const push = (id: number): void => {
      if (!Number.isFinite(id) || seen.has(id)) return
      seen.add(id)
      ids.push(id)
    }

    if (q) {
      try {
        const rows = this.db
          .prepare(
            `SELECT chunk_id AS id FROM chunks_fts
             WHERE chunks_fts MATCH ?
             ORDER BY bm25(chunks_fts)
             LIMIT ?`
          )
          .all(q, limit) as { id: string }[]
        for (const r of rows) push(Number(r.id))
      } catch {
        const like = `%${query.replace(/[%_]/g, '')}%`
        const rows = this.db
          .prepare(
            `SELECT c.id AS id FROM chunks c
             JOIN chunks_fts f ON f.chunk_id = CAST(c.id AS TEXT)
             WHERE f.body LIKE ? OR f.name LIKE ? OR c.path LIKE ?
             LIMIT ?`
          )
          .all(like, like, like, limit) as { id: number }[]
        for (const r of rows) push(r.id)
      }
    }

    // path is UNINDEXED in FTS5; LIKE covers filename queries on existing DBs
    // and tokens that only appear in the path.
    if (ids.length < limit) {
      const pathStmt = this.db.prepare(
        `SELECT id FROM chunks WHERE path LIKE ? LIMIT ?`
      )
      for (const token of tokens) {
        if (ids.length >= limit) break
        if (token.length < 3) continue
        const like = `%${token.replace(/[%_]/g, '')}%`
        if (like.length < 5) continue
        const rows = pathStmt.all(like, limit) as { id: number }[]
        for (const r of rows) {
          push(r.id)
          if (ids.length >= limit) break
        }
      }
    }
    return ids.slice(0, limit)
  }
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      file_hash TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL,
      size_bytes INTEGER
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      parent_name TEXT,
      chunk_hash TEXT NOT NULL,
      embedding BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      chunk_id UNINDEXED,
      path UNINDEXED,
      name,
      parent_name,
      body,
      tokenize = 'porter unicode61'
    );
  `)
  ensureColumn(db, 'files', 'size_bytes', 'size_bytes INTEGER')
  ensureColumn(db, 'files', 'embed_pending', 'embed_pending INTEGER NOT NULL DEFAULT 0')
}

function ensureColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (rows.some((r) => r.name === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
}

const CAMEL_SPLIT = /_|(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/

/**
 * English function words that survive the 3-char token floor.
 * Applied to MATCH queries only — indexed `body` is unchanged.
 */
const FTS_QUERY_STOPWORDS = new Set([
  'about',
  'also',
  'and',
  'any',
  'are',
  'been',
  'being',
  'but',
  'does',
  'doing',
  'done',
  'for',
  'from',
  'have',
  'here',
  'how',
  'into',
  'its',
  'just',
  'more',
  'most',
  'one',
  'only',
  'other',
  'our',
  'over',
  'should',
  'some',
  'such',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'very',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your'
])

/** Identifier-style tokens for FTS, including camelCase / snake_case splits. */
export function ftsQueryTokens(raw: string): string[] {
  const tokens = new Set<string>()
  const push = (part: string): void => {
    const s = part.trim().toLowerCase().replace(/"/g, '')
    if (s.length >= 3) tokens.add(s)
  }
  for (const part of raw.split(/[^a-zA-Z0-9_]+/)) {
    if (!part) continue
    push(part)
    for (const bit of part.split(CAMEL_SPLIT)) push(bit)
  }
  return [...tokens]
}

function tokensToMatchQuery(tokens: string[]): string {
  const kept = tokens.filter((t) => !FTS_QUERY_STOPWORDS.has(t))
  if (!kept.length) return ''
  // FTS5 default operator is AND; quoted terms keep porter tokens intact.
  return kept.map((t) => `"${t}"`).join(' ')
}

/** Build a safe FTS5 MATCH query from free text. */
export function sanitizeFtsQuery(raw: string): string {
  return tokensToMatchQuery(ftsQueryTokens(raw))
}

/** FTS document: path + names + camelCase splits + chunk body. */
export function buildChunkFtsText(
  path: string,
  chunk: { name: string; parentName?: string | null; text: string }
): string {
  const ident = `${path}\n${chunk.name}\n${chunk.parentName ?? ''}`
  return `${ident}\n${ftsQueryTokens(ident).join(' ')}\n${chunk.text}`
}
