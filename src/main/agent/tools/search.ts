import { assertInsideWorkspace } from '../../../shared/workspacePath'
import { extraRootDisplayPath } from '../../../shared/extraRoots'
import { canonicalizeWorkspacePath } from '../../../shared/utils/workspacePath'
import { resolveInsideWorkspace } from '../../workspace/safePath'
import { existsSync, promises as fsp, realpathSync } from 'fs'
import { extname, relative } from 'path'
import {
  collectWorkspaceFilesPage,
  formatLiveScanCapNotice,
  isGrepOverlapRel,
  TEXT_EXTS,
  throwIfAborted,
  yieldToEventLoop,
  type WalkedFile
} from './walk'
import { compileUserRegex } from './safeUserRegex'
import { formatOversizedNotice, formatPermissionHiddenNotice } from './grep'
import { extractDocxText, isDocxPath, MAX_DOCX_ARCHIVE_BYTES } from './docxText'
import {
  queryIndexCandidates,
  resolveCandidateFullPaths
} from '../codeindex'

const YIELD_EVERY_FILES = 32
export const SEARCH_SCAN_CAP = 5000
export const SEARCH_MAX_FILE_BYTES = 256 * 1024
export const SEARCH_DEFAULT_MAX_RESULTS = 40

/** Skipped for size, as opposed to unreadable, so the scan can report it. */
const OVERSIZED = Symbol('search-oversized')

async function contentHit(
  file: string,
  rel: string,
  q: string,
  pattern: RegExp,
  regex: boolean
): Promise<string | typeof OVERSIZED | null> {
  try {
    const st = await fsp.stat(file)
    let text: string
    if (isDocxPath(rel) || isDocxPath(file)) {
      if (st.size > MAX_DOCX_ARCHIVE_BYTES) return OVERSIZED
      text = extractDocxText(await fsp.readFile(file))
    } else {
      // Declared but previously unenforced — see the same fix in grep.ts.
      if (st.size > SEARCH_MAX_FILE_BYTES) return OVERSIZED
      text = await fsp.readFile(file, 'utf8')
    }
    if (regex) {
      const match = pattern.exec(text)
      if (!match) return null
      const idx = match.index
      const line = text.slice(0, idx).split('\n').length
      const snippet = text.split('\n')[line - 1]?.trim() ?? ''
      return `${rel}:${line}: ${snippet}`
    }
    const idx = text.toLowerCase().indexOf(q.toLowerCase())
    if (idx < 0) return null
    const line = text.slice(0, idx).split('\n').length
    const snippet = text.split('\n')[line - 1]?.trim() ?? ''
    return `${rel}:${line}: ${snippet}`
  } catch {
    return null
  }
}

export type SearchScope = {
  /**
   * Folder (or file) to search under: relative to the root, or absolute
   * inside it. Resolved with the root's symlink-escape check, so a path
   * outside it is refused. Omitted or `.` searches the whole root.
   */
  path?: string
  /**
   * The added folder this search runs in (extraRoots.ts). The code index is
   * the workspace's, so the folder is always walked live, and every hit is
   * cited by its absolute path, as grep cites it there.
   */
  displayRoot?: string
}

const WINDOWS_PATHS = process.platform === 'win32'

/** `path` as a root-relative prefix with forward slashes; '' for the whole root. */
function resolveSearchPrefix(root: string, pathArg: string | undefined): string {
  const p = pathArg?.trim()
  if (!p || p === '.' || p === './') return ''
  const full = resolveInsideWorkspace(root, p)
  if (!existsSync(full)) throw new Error(`search path not found: ${p}`)
  const rel = relative(realpathSync(canonicalizeWorkspacePath(root)), full).replace(/\\/g, '/')
  return WINDOWS_PATHS ? rel.toLowerCase() : rel
}

/** Case-insensitive substring or optional regex search over filenames and text contents. */
export async function toolSearch(
  workspaceRoot: string,
  query: string,
  maxResults?: number,
  signal?: AbortSignal,
  regex = false,
  scanCap?: number,
  /** Files whose contents a permission rule keeps out (denied, or asked before reading). */
  hidePath?: (rel: string) => boolean,
  scope: SearchScope = {}
): Promise<string> {
  throwIfAborted(signal)
  const q = query.trim()
  if (!q) throw new Error('search query is required')
  const prefix = resolveSearchPrefix(workspaceRoot, scope.path)
  const underPrefix = prefix
    ? (rel: string): boolean => {
        const key = WINDOWS_PATHS ? rel.toLowerCase() : rel
        return key === prefix || key.startsWith(`${prefix}/`)
      }
    : undefined
  const displayRoot = scope.displayRoot
  const shown = (rel: string): string => (displayRoot ? extraRootDisplayPath(displayRoot, rel) : rel)
  const limit =
    maxResults == null ? SEARCH_DEFAULT_MAX_RESULTS : Math.max(1, maxResults)

  let pattern: RegExp
  if (regex) {
    pattern = compileUserRegex(q, 'im')
  } else {
    const lower = q.toLowerCase()
    pattern = {
      test: (s: string) => s.toLowerCase().includes(lower)
    } as RegExp
  }

  assertInsideWorkspace(workspaceRoot, '.')

  const hits: string[] = []
  const fileHitRels = new Set<string>()
  let truncated = false
  let oversized = 0
  let hidden = 0
  let indexMode: 'trigram' | 'live' = 'live'

  const liveCap =
    typeof scanCap === 'number' && Number.isFinite(scanCap)
      ? Math.max(1, Math.floor(scanCap))
      : SEARCH_SCAN_CAP
  const page = await collectWorkspaceFilesPage(
    workspaceRoot,
    liveCap,
    undefined,
    signal,
    undefined,
    undefined,
    underPrefix
  )
  const allFiles = page.files
  const liveHitCap = !page.exhausted
  throwIfAborted(signal)

  for (const f of allFiles) {
    if (Number.isFinite(limit) && hits.length >= limit) {
      truncated = true
      break
    }
    if (pattern.test(f.rel)) {
      hits.push(`file: ${shown(f.rel)}`)
      fileHitRels.add(f.rel)
    }
  }

  if (Number.isFinite(limit) && hits.length >= limit) {
    truncated = true
  } else {
    let contentFiles: WalkedFile[] = allFiles.filter((f) => !fileHitRels.has(f.rel))
    const sparse = displayRoot
      ? null
      : await queryIndexCandidates(workspaceRoot, {
          query: q,
          kind: regex ? 'regex' : 'substring',
          caseSensitive: false,
          signal
        })
    if (sparse?.lookup.ok) {
      const pruned = resolveCandidateFullPaths(workspaceRoot, sparse.lookup.paths).filter(
        (f) => !fileHitRels.has(f.rel) && (!underPrefix || underPrefix(f.rel))
      )
      if (pruned.length > 0) {
        indexMode = 'trigram'
        const seen = new Set(pruned.map((f) => f.rel))
        const extraOverlap = allFiles.filter((f) => {
          if (seen.has(f.rel) || fileHitRels.has(f.rel)) return false
          return isGrepOverlapRel(f.rel, f.full)
        })
        contentFiles = extraOverlap.length > 0 ? [...pruned, ...extraOverlap] : pruned
      }
    }
    // A name match is only a name; the contents of a file a rule protects stay out.
    if (hidePath) {
      contentFiles = contentFiles.filter((f) => {
        if (!hidePath(f.rel)) return true
        if (TEXT_EXTS.has(extname(f.full).toLowerCase()) || isDocxPath(f.rel)) hidden++
        return false
      })
    }

    for (let i = 0; i < contentFiles.length; i++) {
      throwIfAborted(signal)
      if (i > 0 && i % YIELD_EVERY_FILES === 0) {
        await yieldToEventLoop()
        throwIfAborted(signal)
      }
      if (Number.isFinite(limit) && hits.length >= limit) {
        truncated = true
        break
      }
      const { full: file, rel } = contentFiles[i]!
      const ext = extname(file).toLowerCase()
      if (!TEXT_EXTS.has(ext) && !isDocxPath(rel)) continue
      const hit = await contentHit(file, shown(rel), q, pattern, regex)
      if (hit === OVERSIZED) oversized += 1
      else if (hit) hits.push(hit)
    }
  }

  const notices: string[] = []
  if (truncated) notices.push(`… stopped at ${limit} matches`)
  // A size skip is a coverage gap, not an absence of matches — say so, or a
  // symbol in an oversized file reads back as "no such symbol".
  if (oversized > 0) notices.push(formatOversizedNotice(oversized, SEARCH_MAX_FILE_BYTES))
  if (hidden > 0) notices.push(formatPermissionHiddenNotice(hidden))
  if (liveHitCap) notices.push(formatLiveScanCapNotice(liveCap))
  notices.push(`index=${indexMode}`)
  if (hits.length === 0) {
    return [`No matches for "${query}"`, ...notices].join('\n')
  }
  return [hits.join('\n'), ...notices].join('\n')
}

/** Paths from a successful `search` tool result (filename or content hits). */
export function searchHitPathsFromResult(content: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('…') || trimmed.startsWith('index=') || trimmed.startsWith('scan cap')) continue
    const fileHit = trimmed.match(/^file:\s*(.+)$/)
    if (fileHit) {
      const p = fileHit[1]!.trim()
      if (p && !seen.has(p)) {
        seen.add(p)
        out.push(p)
      }
      continue
    }
    const contentHit = trimmed.match(/^(.+?):(\d+):\s*(.*)$/)
    if (contentHit) {
      const p = contentHit[1]!.trim()
      if (p && !seen.has(p)) {
        seen.add(p)
        out.push(p)
      }
    }
  }
  return out
}
