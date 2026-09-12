import { readFileSync, statSync, promises as fsp } from 'fs'
import { extname, join } from 'path'
import { assertInsideWorkspace } from '../../../shared/workspacePath'
import {
  collectWorkspaceFilesPage,
  formatLiveScanCapNotice,
  globToRegExp,
  isGrepOverlapRel,
  TEXT_EXTS,
  throwIfAborted,
  yieldToEventLoop,
  type WalkedFile
} from './walk'
import { compileUserRegex } from './safeUserRegex'
import { extractDocxText, isDocxPath, MAX_DOCX_ARCHIVE_BYTES } from './docxText'
import {
  queryIndexCandidates,
  resolveCandidateFullPaths
} from '../codeindex'

export const GREP_SCAN_CAP = 20_000
export const GREP_MAX_FILE_BYTES = 512 * 1024
export const GREP_DEFAULT_MAX_RESULTS = 60
const YIELD_EVERY_FILES = 32

export type GrepOptions = {
  /** Glob restricting which files are searched, e.g. `src/**\/*.ts`. */
  include?: string
  caseSensitive?: boolean
  contextLines?: number
  maxResults?: number
  /** Override live-walk file cap (tests). Production uses GREP_SCAN_CAP. */
  scanCap?: number
}

function compile(pattern: string, caseSensitive: boolean): RegExp {
  // `m` so `^`/`$` are per line — the schema says each line, and ripgrep does the same.
  // Without it, `^export` only matches files whose first byte is `export`.
  return compileUserRegex(pattern, caseSensitive ? 'm' : 'im')
}

type GrepHitState = { out: string[]; matchCount: number; truncated: boolean }

function isGrepDocx(file: WalkedFile): boolean {
  return isDocxPath(file.rel) || isDocxPath(file.full)
}

function shouldSkipGrepFile(file: WalkedFile, includeRegex: RegExp | null): boolean {
  if (includeRegex && !includeRegex.test(file.rel)) return true
  if (isGrepDocx(file)) return false
  if (!TEXT_EXTS.has(extname(file.full).toLowerCase())) return true
  return false
}

function loadGrepTextSync(file: WalkedFile): string | null {
  try {
    const st = statSync(file.full)
    if (isGrepDocx(file)) {
      if (st.size > MAX_DOCX_ARCHIVE_BYTES) return null
      return extractDocxText(readFileSync(file.full))
    }
    return readFileSync(file.full, 'utf8')
  } catch {
    return null
  }
}

async function loadGrepTextAsync(file: WalkedFile): Promise<string | null> {
  try {
    const st = await fsp.stat(file.full)
    if (isGrepDocx(file)) {
      if (st.size > MAX_DOCX_ARCHIVE_BYTES) return null
      return extractDocxText(await fsp.readFile(file.full))
    }
    return await fsp.readFile(file.full, 'utf8')
  } catch {
    return null
  }
}

/**
 * Scan one file's text for matches. Shared by the async tool path and the
 * sync test helper so output format stays identical (`rel:line:…`).
 */
function grepFileText(
  rel: string,
  text: string,
  regex: RegExp,
  maxResults: number,
  contextLines: number,
  state: GrepHitState
): void {
  if (!regex.test(text)) return

  const lines = text.split('\n')
  for (let n = 0; n < lines.length; n++) {
    if (!regex.test(lines[n]!)) continue

    if (Number.isFinite(maxResults) && state.matchCount >= maxResults) {
      state.truncated = true
      return
    }
    state.matchCount++

    if (contextLines === 0) {
      state.out.push(`${rel}:${n + 1}: ${lines[n]!.trim()}`)
      continue
    }
    const from = Math.max(0, n - contextLines)
    const to = Math.min(lines.length - 1, n + contextLines)
    state.out.push(`${rel}:${n + 1}`)
    for (let c = from; c <= to; c++) {
      state.out.push(`${c === n ? '>' : ' '} ${c + 1}| ${lines[c]!}`)
    }
    state.out.push('')
  }
}

/** Sync file read — used only by `grepFilesForTest`. */
function grepOneFile(
  file: WalkedFile,
  regex: RegExp,
  maxResults: number,
  contextLines: number,
  includeRegex: RegExp | null,
  state: GrepHitState
): void {
  if (shouldSkipGrepFile(file, includeRegex)) return
  const text = loadGrepTextSync(file)
  if (text == null) return
  grepFileText(file.rel, text, regex, maxResults, contextLines, state)
}

async function grepOneFileAsync(
  file: WalkedFile,
  regex: RegExp,
  maxResults: number,
  contextLines: number,
  includeRegex: RegExp | null,
  state: GrepHitState
): Promise<void> {
  if (shouldSkipGrepFile(file, includeRegex)) return
  const text = await loadGrepTextAsync(file)
  if (text == null) return
  grepFileText(file.rel, text, regex, maxResults, contextLines, state)
}

/**
 * Scan the candidate set, yielding to the event loop every `YIELD_EVERY_FILES`.
 */
async function formatGrepHitsAsync(
  files: WalkedFile[],
  pattern: string,
  options: GrepOptions,
  maxResults: number,
  contextLines: number,
  includeRegex: RegExp | null,
  signal?: AbortSignal
): Promise<{ out: string[]; matchCount: number; truncated: boolean }> {
  const regex = compile(pattern, options.caseSensitive === true)
  const state = { out: [] as string[], matchCount: 0, truncated: false }
  for (let i = 0; i < files.length && !state.truncated; i++) {
    if (i > 0 && i % YIELD_EVERY_FILES === 0) {
      throwIfAborted(signal)
      await yieldToEventLoop()
    }
    await grepOneFileAsync(files[i]!, regex, maxResults, contextLines, includeRegex, state)
  }
  return state
}

function formatGrepHits(
  files: WalkedFile[],
  pattern: string,
  options: GrepOptions,
  maxResults: number,
  contextLines: number,
  includeRegex: RegExp | null
): { out: string[]; matchCount: number; truncated: boolean } {
  const regex = compile(pattern, options.caseSensitive === true)
  const state = { out: [] as string[], matchCount: 0, truncated: false }
  for (let i = 0; i < files.length && !state.truncated; i++) {
    grepOneFile(files[i]!, regex, maxResults, contextLines, includeRegex, state)
  }
  return state
}

function resolveMaxResults(maxResults: number | undefined): number {
  // GREP_DEFAULT_MAX_RESULTS was previously defined but dead: a null maxResults
  // meant unbounded. Wire the constant in as the live default; explicit wins.
  return maxResults == null ? GREP_DEFAULT_MAX_RESULTS : Math.max(1, maxResults)
}

/**
 * Regex content search with optional surrounding context.
 *
 * Uses trigram candidate prune when the code index is ready; otherwise live walk.
 * Output format is identical either way (`rel:line:…`).
 */
export async function toolGrep(
  workspaceRoot: string,
  pattern: string,
  options: GrepOptions = {},
  signal?: AbortSignal
): Promise<string> {
  const trimmed = pattern.trim()
  if (!trimmed) throw new Error('grep requires a non-empty pattern')

  const maxResults = resolveMaxResults(options.maxResults)
  const contextLines = Math.max(0, options.contextLines ?? 0)
  const includeRegex = options.include ? globToRegExp(options.include) : null

  assertInsideWorkspace(workspaceRoot, '.')
  throwIfAborted(signal)

  let files: WalkedFile[] | null = null
  let indexMode: 'trigram' | 'live' = 'live'
  let indexSyncInProgress = false
  let indexedFileCount = 0

  const sparse = await queryIndexCandidates(workspaceRoot, {
    query: trimmed,
    kind: 'regex',
    caseSensitive: options.caseSensitive === true,
    signal
  })
  if (sparse?.lookup.ok) {
    indexMode = 'trigram'
    indexedFileCount = sparse.fileCount
    indexSyncInProgress = !sparse.syncComplete
    let candidates = resolveCandidateFullPaths(workspaceRoot, sparse.lookup.paths)
    if (includeRegex) {
      candidates = candidates.filter((c) => includeRegex.test(c.rel))
    }
    // Empty prune (docs-only or tests-only hits, or include outside CODE_INDEX_EXTS)
    // must live-walk — the source index never contains .md/.docx or tests/.
    if (candidates.length > 0) {
      candidates.sort((a, b) => a.rel.localeCompare(b.rel))
      files = candidates
    }
  }

  let liveHitCap = false
  const liveCap =
    typeof options.scanCap === 'number' && Number.isFinite(options.scanCap)
      ? Math.max(1, Math.floor(options.scanCap))
      : GREP_SCAN_CAP
  if (files == null) {
    indexMode = 'live'
    indexSyncInProgress = false
    const page = await collectWorkspaceFilesPage(workspaceRoot, liveCap, undefined, signal)
    files = page.files
    liveHitCap = !page.exhausted
    throwIfAborted(signal)
  } else if (!includeRegex) {
    // Trigram candidates are source-only. Docs and tests/ still need a walk
    // when the query also hits indexed code (receipt: toolWebFetch only in tests).
    const seen = new Set(files.map((f) => f.rel))
    const overlapPage = await collectWorkspaceFilesPage(
      workspaceRoot,
      liveCap,
      undefined,
      signal,
      undefined,
      undefined,
      isGrepOverlapRel
    )
    for (const f of overlapPage.files) {
      if (!seen.has(f.rel)) files.push(f)
    }
    files.sort((a, b) => a.rel.localeCompare(b.rel))
    throwIfAborted(signal)
  }

  const { out, matchCount, truncated } = await formatGrepHitsAsync(
    files,
    trimmed,
    options,
    maxResults,
    contextLines,
    includeRegex,
    signal
  )

  const notices: string[] = []
  if (matchCount === 0) {
    notices.push(`No matches for /${trimmed}/`)
  } else {
    const body = out.join('\n').trimEnd()
    if (body) notices.push(body)
    if (truncated) notices.push(`… stopped at ${maxResults} matches`)
  }
  if (indexSyncInProgress) {
    notices.push(`index sync in progress (${indexedFileCount} files indexed so far)`)
  }
  if (liveHitCap) notices.push(formatLiveScanCapNotice(liveCap))
  notices.push(`index=${indexMode}`)
  return notices.join('\n')
}

/** Test helper: grep a fixed file list (no index). */
export function grepFilesForTest(
  workspaceRoot: string,
  pattern: string,
  relPaths: string[],
  options: GrepOptions = {}
): string {
  const maxResults = resolveMaxResults(options.maxResults)
  const contextLines = Math.max(0, options.contextLines ?? 0)
  const includeRegex = options.include ? globToRegExp(options.include) : null
  const files: WalkedFile[] = relPaths.map((rel) => ({
    full: join(workspaceRoot, ...rel.split('/')),
    rel
  }))
  const { out, matchCount, truncated } = formatGrepHits(
    files,
    pattern.trim(),
    options,
    maxResults,
    contextLines,
    includeRegex
  )
  if (matchCount === 0) return `No matches for /${pattern.trim()}/`
  const suffix = truncated ? `\n… stopped at ${maxResults} matches` : ''
  return `${out.join('\n').trimEnd()}${suffix}`
}

export type GrepWorkspaceHit = { path: string; line: number; text: string }

/** Structured hits for the Files panel (not an agent tool). */
export async function grepWorkspaceHits(
  workspaceRoot: string,
  query: string,
  options: { include?: string; maxResults?: number } = {},
  signal?: AbortSignal
): Promise<{ hits: GrepWorkspaceHit[]; truncated: boolean }> {
  const maxResults = Math.max(1, Math.min(500, options.maxResults ?? 80))
  const raw = await toolGrep(workspaceRoot, query, {
    include: options.include,
    maxResults,
    contextLines: 0
  }, signal)
  const hits: GrepWorkspaceHit[] = []
  for (const line of raw.split('\n')) {
    const match = /^(.*):(\d+): (.*)$/.exec(line)
    if (!match) continue
    hits.push({ path: match[1]!, line: Number(match[2]), text: match[3]! })
  }
  return { hits, truncated: raw.includes('stopped at') }
}
