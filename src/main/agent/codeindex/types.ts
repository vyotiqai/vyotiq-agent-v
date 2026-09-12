export type ChunkKind = 'function' | 'class' | 'method' | 'module' | 'section' | 'block'
export type CodeChunk = {
  /** Workspace-relative path with forward slashes. */
  path: string
  startLine: number
  endLine: number
  kind: ChunkKind
  name: string
  parentName?: string
  /** Raw source for the line range. */
  text: string
  /** Text indexed (path + parent + body). */
  contextualizedText: string
}

export type StoredChunk = {
  id: number
  path: string
  startLine: number
  endLine: number
  kind: ChunkKind
  name: string
  parentName: string | null
}

export type CodebaseSearchHit = {
  path: string
  startLine: number
  endLine: number
  kind: ChunkKind
  name: string
  parentName: string | null
  score: number
  snippet: string
}

export type IndexStatus = {
  ready: boolean
  fileCount: number
  chunkCount: number
  lastIndexedAt: string | null
  syncComplete: boolean
}

export const DEFAULT_SEARCH_LIMIT = 10
export const MAX_SEARCH_LIMIT = 40
/** Soft cap on characters per chunk body before split. */
export const MAX_CHUNK_CHARS = 2400
/** Index skips files larger than this; snippet reads use the same cap. */
export const CODE_INDEX_MAX_FILE_BYTES = 512 * 1024
/** Max files considered per index page (production source). */
export const INDEX_SCAN_CAP = 24000
/** Full-tree reconcile walk after the last page (must exceed one page). */
export const CODE_INDEX_RECONCILE_WALK_CAP = INDEX_SCAN_CAP * 2
/** Bumped when the SQLite schema changes — mismatched stores are rebuilt. */
export const CODE_INDEX_SCHEMA_VERSION = '2'

export type SyncResult = {
  scanned: number
  indexed: number
  skipped: number
  removed: number
  status: IndexStatus
  partial: boolean
  syncComplete: boolean
  cursor: string | null
}
