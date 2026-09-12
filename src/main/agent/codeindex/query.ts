import { openSync, readSync, closeSync, fstatSync, promises as fsp } from 'fs'
import { basename, join } from 'path'
import { existsSync } from 'fs'
import { literalRunForPattern, type CodeIndexStore } from './store'
import { getOrOpenCodeIndexStore } from './storeCache'
import { codeindexDbPath } from '../indexStoragePaths'
import type { CodebaseSearchHit } from './types'
import { CODE_INDEX_MAX_FILE_BYTES, DEFAULT_SEARCH_LIMIT } from './types'
import {
  collectWorkspaceFilesPage,
  DOC_TEXT_EXTS,
  throwIfAborted,
  yieldToEventLoop
} from '../tools/walk'
import { extractDocxText, isDocxPath, MAX_DOCX_ARCHIVE_BYTES } from '../tools/docxText'

export type SearchOptions = {
  limit?: number
  signal?: AbortSignal
}

const DOCS_OVERLAP_YIELD_EVERY = 16
/** Docs walk cap — index skips `docs/`; this is search-time only. */
const DOCS_OVERLAP_SCAN_CAP = 4_000
/** Cap bytes read when extracting a line-bounded snippet (match indexed-file max). */
const SNIPPET_READ_CAP_BYTES = CODE_INDEX_MAX_FILE_BYTES

function docsQueryTokens(query: string): string[] {
  const parts = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 4)
  if (parts.length > 0) return [...new Set(parts)]
  const compact = query.toLowerCase().trim()
  return compact.length >= 3 ? [compact] : []
}

async function loadDocsOverlapText(rel: string, full: string): Promise<string | null> {
  try {
    const st = await fsp.stat(full)
    if (isDocxPath(rel) || isDocxPath(full)) {
      if (st.size > MAX_DOCX_ARCHIVE_BYTES) return null
      return extractDocxText(await fsp.readFile(full))
    }
    if (st.size > CODE_INDEX_MAX_FILE_BYTES) return null
    return await fsp.readFile(full, 'utf8')
  } catch {
    return null
  }
}

/**
 * Lexical hits under workspace `docs/` (.md/.docx). The source index skips that
 * tree; this walk is search-time only and does not index zip bytes.
 */
export async function collectDocsLexicalHits(
  workspaceRoot: string,
  query: string,
  opts: { limit: number; seenPaths: ReadonlySet<string>; signal?: AbortSignal }
): Promise<CodebaseSearchHit[]> {
  const tokens = docsQueryTokens(query)
  if (tokens.length === 0 || opts.limit <= 0) return []

  const docsRoot = join(workspaceRoot, 'docs')
  try {
    const st = await fsp.stat(docsRoot)
    if (!st.isDirectory()) return []
  } catch {
    return []
  }

  const page = await collectWorkspaceFilesPage(
    docsRoot,
    DOCS_OVERLAP_SCAN_CAP,
    undefined,
    opts.signal,
    DOC_TEXT_EXTS
  )
  const out: CodebaseSearchHit[] = []
  for (let i = 0; i < page.files.length; i++) {
    if (out.length >= opts.limit) break
    throwIfAborted(opts.signal)
    if (i > 0 && i % DOCS_OVERLAP_YIELD_EVERY === 0) {
      await yieldToEventLoop()
      throwIfAborted(opts.signal)
    }
    const file = page.files[i]!
    const rel = `docs/${file.rel.replace(/\\/g, '/')}`
    if (opts.seenPaths.has(rel)) continue
    const text = await loadDocsOverlapText(rel, file.full)
    if (!text) continue
    const lower = text.toLowerCase()
    let matched = 0
    let firstIdx = -1
    for (const token of tokens) {
      const idx = lower.indexOf(token)
      if (idx < 0) continue
      matched++
      if (firstIdx < 0 || idx < firstIdx) firstIdx = idx
    }
    if (matched === 0) continue
    const line = text.slice(0, Math.max(0, firstIdx)).split('\n').length
    const snippet = (text.split('\n')[line - 1] ?? '').trim().slice(0, 900)
    out.push({
      path: rel,
      startLine: line,
      endLine: line,
      kind: 'section',
      name: basename(rel),
      parentName: null,
      score: matched / tokens.length,
      snippet
    })
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, opts.limit)
}

/**
 * Read only enough of the file to cover `[startLine, endLine]` instead of the
 * full source (up to 512KB). Falls back to empty string on any I/O error.
 */
function readSnippet(
  workspaceRoot: string,
  path: string,
  startLine: number,
  endLine: number,
  maxChars = 900
): string {
  try {
    const full = join(workspaceRoot, ...path.split('/'))
    const fd = openSync(full, 'r')
    try {
      const size = fstatSync(fd).size
      const toRead = Math.min(size, SNIPPET_READ_CAP_BYTES)
      const buf = Buffer.allocUnsafe(toRead)
      const n = readSync(fd, buf, 0, toRead, 0)
      const text = buf.toString('utf8', 0, n).replace(/\r\n/g, '\n')
      const lines = text.split('\n')
      const from = Math.max(0, startLine - 1)
      const to = Math.max(from, endLine)
      const slice = lines.slice(from, to).join('\n')
      return slice.length > maxChars ? slice.slice(0, maxChars) + '\n…' : slice
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

export async function searchCodeIndex(
  workspaceRoot: string,
  store: CodeIndexStore,
  query: string,
  opts: SearchOptions = {}
): Promise<CodebaseSearchHit[]> {
  throwIfAborted(opts.signal)
  const q = query.trim()
  if (!q) return []

  const limit = Math.max(1, opts.limit ?? DEFAULT_SEARCH_LIMIT)
  const candidateCap = Math.max(limit * 4, 20)

  const ids = store.searchFts(q, candidateCap)
  const hits: CodebaseSearchHit[] = []
  for (let i = 0; i < ids.length && hits.length < limit; i++) {
    const chunk = store.getChunk(ids[i]!)
    if (!chunk) continue
    hits.push({
      path: chunk.path,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      kind: chunk.kind,
      name: chunk.name,
      parentName: chunk.parentName,
      score: 1 / (i + 1),
      snippet: readSnippet(workspaceRoot, chunk.path, chunk.startLine, chunk.endLine)
    })
  }

  const seen = new Set(hits.map((h) => h.path))
  const docsBudget = hits.length === 0 ? limit : Math.min(3, Math.max(1, limit - hits.length))
  const docsHits = await collectDocsLexicalHits(workspaceRoot, q, {
    limit: docsBudget,
    seenPaths: seen,
    signal: opts.signal
  })
  if (docsHits.length > 0) {
    hits.push(...docsHits)
    hits.sort((a, b) => b.score - a.score)
    if (hits.length > limit) hits.length = limit
  }
  return hits
}

export function formatSearchHits(hits: CodebaseSearchHit[]): string {
  if (!hits.length) return 'No codebase_search hits.'
  return hits
    .map((h, i) => {
      const parent = h.parentName ? ` (${h.parentName})` : ''
      const head = `${i + 1}. ${h.path}:${h.startLine}-${h.endLine} [${h.kind} ${h.name}${parent}] score=${h.score.toFixed(4)}`
      return `${head}\n${h.snippet}`
    })
    .join('\n\n')
}

const HIT_HEAD = /^(\d+)\.\s+(.+?):(\d+)-(\d+)\s+\[/

/** Concrete hit paths from a formatted codebase_search tool result. */
export function codebaseSearchHitPathsFromResult(content: string): string[] {
  const paths: string[] = []
  const seen = new Set<string>()
  for (const line of content.split('\n')) {
    const m = line.trim().match(HIT_HEAD)
    if (!m) continue
    const path = m[2]!
    if (seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }
  return paths
}

// ---------------------------------------------------------------------------
// Candidate acceleration for grep / glob / search (formerly sparsegrep).
// Same contract: prune candidate files, false positives only, callers verify.
// ---------------------------------------------------------------------------

export type CandidateLookup =
  | { ok: true; paths: string[]; mode: 'trigram' }
  | { ok: false; reason: 'not_ready' | 'unusable_pattern' }

export type IndexCandidateQueryResult = {
  lookup: CandidateLookup
  fileCount: number
  syncComplete: boolean
}

/** Map relative paths to absolute under workspace; drop missing. */
export function resolveCandidateFullPaths(
  workspaceRoot: string,
  relPaths: string[]
): { full: string; rel: string }[] {
  const out: { full: string; rel: string }[] = []
  for (const rel of relPaths) {
    const full = join(workspaceRoot, ...rel.split('/'))
    if (existsSync(full)) out.push({ full, rel })
  }
  return out
}

function tryReadyStore(workspaceRoot: string): CodeIndexStore | null {
  try {
    if (!existsSync(codeindexDbPath(workspaceRoot))) return null
    const store = getOrOpenCodeIndexStore(workspaceRoot)
    if (!store.getStatus().ready) return null
    return store
  } catch {
    return null
  }
}

/**
 * Candidate file paths whose indexed text must contain a literal from the
 * pattern. Returns null when the store is cold so callers fall back to a live
 * walk, and `unusable_pattern` when no literal can prune.
 */
export async function queryIndexCandidates(
  workspaceRoot: string,
  opts: {
    query: string
    kind: 'regex' | 'substring'
    caseSensitive?: boolean
    signal?: AbortSignal
  }
): Promise<IndexCandidateQueryResult | null> {
  void opts.caseSensitive // trigram index is case-insensitive; verify step uses real flags
  const store = tryReadyStore(workspaceRoot)
  if (!store) return null
  const literal =
    opts.kind === 'substring'
      ? opts.query.trim().length >= 3
        ? opts.query.trim()
        : null
      : literalRunForPattern(opts.query)
  if (!literal) {
    return {
      lookup: { ok: false, reason: 'unusable_pattern' },
      fileCount: store.getStatus().fileCount,
      syncComplete: store.getMeta('syncComplete') === 'true'
    }
  }
  const paths = store.lookupFilesByLiteral(literal)
  return {
    lookup: paths ? { ok: true, paths, mode: 'trigram' } : { ok: false, reason: 'unusable_pattern' },
    fileCount: store.getStatus().fileCount,
    syncComplete: store.getMeta('syncComplete') === 'true'
  }
}

export type IndexFileListQueryResult = {
  ready: boolean
  paths: string[]
  fileCount: number
  syncComplete: boolean
}

/** Indexed file list for glob acceleration; null when the store is cold. */
export async function queryIndexFileList(
  workspaceRoot: string,
  opts: { signal?: AbortSignal } = {}
): Promise<IndexFileListQueryResult | null> {
  void opts.signal
  const store = tryReadyStore(workspaceRoot)
  if (!store) return null
  const status = store.getStatus()
  return {
    ready: status.ready,
    paths: status.ready ? store.listFilePaths() : [],
    fileCount: status.fileCount,
    syncComplete: status.syncComplete
  }
}
