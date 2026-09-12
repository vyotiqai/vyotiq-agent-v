import { existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { DatabaseSync } from 'node:sqlite'
import type { ChunkKind, IndexStatus, StoredChunk } from './types'
import { CODE_INDEX_SCHEMA_VERSION } from './types'
import { codeindexDbPath, codeindexRoot } from '../indexStoragePaths'

export { codeindexRoot, codeindexDbPath } from '../indexStoragePaths'

/**
 * One SQLite store per workspace: a `files` table for incremental sync and
 * glob/file-list acceleration, a `chunks` metadata table, and one FTS5 index
 * with the trigram tokenizer — substring + keyword matching with BM25 ranking,
 * no embeddings, no models.
 */
export class CodeIndexStore {
  readonly db: DatabaseSync
  readonly dbPath: string

  private constructor(db: DatabaseSync, dbPath: string) {
    this.db = db
    this.dbPath = dbPath
  }

  static open(workspacePath: string): CodeIndexStore {
    const root = codeindexRoot(workspacePath)
    if (!existsSync(root)) mkdirSync(root, { recursive: true })
    return CodeIndexStore.openDbPath(codeindexDbPath(workspacePath))
  }

  static openDbPath(dbPath: string): CodeIndexStore {
    const dir = dirname(dbPath)
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
    const db = new DatabaseSync(dbPath)
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec('PRAGMA synchronous = NORMAL;')
    db.exec('PRAGMA busy_timeout = 5000;')
    migrate(db)
    return new CodeIndexStore(db, dbPath)
  }

  /** In-memory store for unit tests. */
  static openMemory(): CodeIndexStore {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    return new CodeIndexStore(db, ':memory:')
  }

  close(): void {
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
    this.db
      .prepare(
        'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, value)
  }

  getStatus(): IndexStatus {
    const fileCount = (this.db.prepare('SELECT COUNT(*) AS c FROM files').get() as { c: number }).c
    const chunkCount = (
      this.db.prepare('SELECT COUNT(*) AS c FROM chunks').get() as { c: number }
    ).c
    const lastIndexedAt = this.getMeta('lastIndexedAt')
    return {
      ready: fileCount > 0,
      fileCount,
      chunkCount,
      lastIndexedAt,
      syncComplete: this.getMeta('syncComplete') === 'true'
    }
  }

  getFileStamp(path: string): { hash: string; mtimeMs: number; size: number } | null {
    const row = this.db
      .prepare(
        `SELECT file_hash AS hash, mtime_ms AS mtimeMs, size_bytes AS size
         FROM files WHERE path = ?`
      )
      .get(path) as { hash: string; mtimeMs: number; size: number | null } | undefined
    if (!row || row.size == null || !Number.isFinite(row.size)) return null
    return { hash: row.hash, mtimeMs: row.mtimeMs, size: row.size }
  }

  updateFileStamp(path: string, fileHash: string, mtimeMs: number, sizeBytes: number): void {
    this.db
      .prepare('UPDATE files SET file_hash = ?, mtime_ms = ?, size_bytes = ? WHERE path = ?')
      .run(fileHash, mtimeMs, sizeBytes, path)
  }

  listFilePaths(): string[] {
    const rows = this.db.prepare('SELECT path FROM files ORDER BY path').all() as { path: string }[]
    return rows.map((r) => r.path)
  }

  private deleteFile(path: string): void {
    const ids = this.db.prepare('SELECT id FROM chunks WHERE path = ?').all(path) as { id: number }[]
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

  replaceFileChunks(
    path: string,
    fileHash: string,
    mtimeMs: number,
    sizeBytes: number,
    chunks: {
      startLine: number
      endLine: number
      kind: ChunkKind
      name: string
      parentName?: string
      ftsBody: string
    }[]
  ): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.deleteFile(path)
      this.db
        .prepare(
          `INSERT INTO files(path, file_hash, mtime_ms, size_bytes) VALUES(?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET file_hash = excluded.file_hash,
             mtime_ms = excluded.mtime_ms, size_bytes = excluded.size_bytes`
        )
        .run(path, fileHash, mtimeMs, sizeBytes)
      const insertChunk = this.db.prepare(
        `INSERT INTO chunks(path, start_line, end_line, kind, name, parent_name)
         VALUES(?, ?, ?, ?, ?, ?)`
      )
      const insertFts = this.db.prepare(
        `INSERT INTO chunks_fts(chunk_id, path, name, body) VALUES(?, ?, ?, ?)`
      )
      for (const c of chunks) {
        const info = insertChunk.run(path, c.startLine, c.endLine, c.kind, c.name, c.parentName ?? null)
        insertFts.run(Number(info.lastInsertRowid), path, c.name, c.ftsBody)
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

  getChunk(id: number): StoredChunk | null {
    const row = this.db
      .prepare(
        `SELECT id, path, start_line AS startLine, end_line AS endLine, kind, name,
                parent_name AS parentName
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
        }
      | undefined
    return row ?? null
  }

  /**
   * Ranked FTS search over the trigram index. Phrases shorter than three
   * characters never match a trigram table, so tokens are floored at 3 chars;
   * a LIKE fallback over path/name covers shorter identifiers. Primary pass
   * ANDs all tokens; if that yields nothing, an OR pass keeps recall. BM25
   * column weights favour path/name matches over body text.
   */
  searchFts(query: string, limit: number): number[] {
    const tokens = ftsQueryTokens(query)
    const ids: number[] = []
    const seen = new Set<number>()
    const push = (id: number): void => {
      if (!Number.isFinite(id) || seen.has(id)) return
      seen.add(id)
      ids.push(id)
    }
    const runMatch = (matchQuery: string): number[] => {
      const rows = this.db
        .prepare(
          `SELECT chunk_id AS id FROM chunks_fts
           WHERE chunks_fts MATCH ?
           ORDER BY bm25(chunks_fts, 0, 4.0, 3.0, 1.0)
           LIMIT ?`
        )
        .all(matchQuery, limit) as { id: number | string }[]
      return rows.map((r) => Number(r.id))
    }

    const phrases = tokens.map((t) => `"${t}"`)
    if (phrases.length > 0) {
      try {
        for (const id of runMatch(phrases.join(' '))) push(id)
        if (ids.length === 0 && phrases.length > 1) {
          for (const id of runMatch(phrases.join(' OR '))) push(id)
        }
      } catch {
        /* malformed query — fall through to LIKE */
      }
    }

    // Short tokens (< 3 chars) and path-only matches: plain LIKE sweep.
    if (ids.length < limit) {
      const likeStmt = this.db.prepare(
        `SELECT c.id AS id FROM chunks c
         WHERE c.path LIKE ? OR c.name LIKE ?
         LIMIT ?`
      )
      for (const token of tokens) {
        if (ids.length >= limit) break
        if (token.length < 3) continue
        const like = `%${token.replace(/[%_]/g, '')}%`
        if (like.length < 5) continue
        const rows = likeStmt.all(like, like, limit) as { id: number }[]
        for (const r of rows) {
          push(r.id)
          if (ids.length >= limit) break
        }
      }
    }
    return ids.slice(0, limit)
  }

  /**
   * Distinct file paths whose indexed text contains the literal substring —
   * the FTS5 trigram equivalent of trigram candidate pruning. Returns null
   * when the literal cannot prune (shorter than 3 chars).
   */
  lookupFilesByLiteral(literal: string, limit = 20000): string[] | null {
    const lit = literal.trim()
    if (lit.length < 3) return null
    const phrase = `"${lit.replace(/"/g, '')}"`
    try {
      const rows = this.db
        .prepare(
          `SELECT DISTINCT path FROM chunks_fts WHERE chunks_fts MATCH ? LIMIT ?`
        )
        .all(phrase, limit) as { path: string }[]
      return rows.map((r) => r.path)
    } catch {
      return null
    }
  }
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
  const version = (() => {
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schemaVersion'`).get() as
      | { value: string }
      | undefined
    return row?.value ?? null
  })()
  if (version != null && version !== CODE_INDEX_SCHEMA_VERSION) {
    // Foreign schema (e.g. the old embedding store) — rebuild from scratch.
    db.exec('DROP TABLE IF EXISTS chunks_fts; DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS files;')
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      file_hash TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      parent_name TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      chunk_id UNINDEXED,
      path,
      name,
      body,
      tokenize = 'trigram'
    );
  `)
  db.prepare(
    `INSERT INTO meta(key, value) VALUES('schemaVersion', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(CODE_INDEX_SCHEMA_VERSION)
  // Fail loud when the runtime SQLite lacks FTS5/trigram — never degrade silently.
  db.prepare(`SELECT chunk_id FROM chunks_fts WHERE chunks_fts MATCH '"abc"' LIMIT 1`).get()
}

const CAMEL_SPLIT = /_|(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/

/** Identifier-style tokens for FTS, including camelCase / snake_case splits. */
export function ftsQueryTokens(raw: string): string[] {
  const tokens = new Set<string>()
  const push = (part: string): void => {
    const s = part.trim().toLowerCase().replace(/"/g, '')
    if (s.length >= 3) tokens.add(s)
  }
  for (const part of raw.split(/[^a-zA-Z0-9_$]+/)) {
    if (!part) continue
    push(part)
    for (const bit of part.split(CAMEL_SPLIT)) push(bit)
  }
  return [...tokens]
}

/** FTS body document: identifier splits folded in so camelCase bits rank too. */
export function buildChunkFtsBody(
  path: string,
  chunk: { name: string; parentName?: string | null; text: string }
): string {
  const ident = `${path}\n${chunk.name}\n${chunk.parentName ?? ''}`
  return `${ident}\n${ftsQueryTokens(ident).join(' ')}\n${chunk.text}`
}

/**
 * Longest literal run usable for trigram candidate pruning of a regex or
 * substring query. Returns null when the pattern cannot safely prune
 * (alternation, lookaround, or no run of 3+ literal chars) — callers fall
 * back to a live scan.
 */
export function literalRunForPattern(pattern: string): string | null {
  const trimmed = pattern.trim()
  if (!trimmed) return null
  if (
    trimmed === '.' ||
    trimmed === '.*' ||
    trimmed === '.+' ||
    trimmed === '^' ||
    trimmed === '$' ||
    trimmed === '^$' ||
    /^\.\*$/.test(trimmed) ||
    /^\.\+$/.test(trimmed)
  ) {
    return null
  }
  // Alternation or lookaround — a required literal would over-prune.
  if (/(^|[^\\])\|/.test(trimmed) || /\(\?/.test(trimmed)) return null
  const withoutClasses = trimmed.replace(/\[[^\]]*]/g, ' ')
  const unescaped = withoutClasses.replace(/\\(.)/g, '$1')
  const forRuns = unescaped.replace(/[.*+?^${}()|[\]\\]/g, ' ')
  const runs = forRuns.match(/[A-Za-z0-9_$.-]{3,}/g)
  if (!runs || runs.length === 0) return null
  let best = runs[0]!
  for (const r of runs) {
    if (r.length > best.length) best = r
  }
  return best
}
