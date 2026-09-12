import { assertInsideWorkspace } from '../../../shared/workspacePath'
import { promises as fsp } from 'fs'
import { extname } from 'path'
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
import { extractDocxText, isDocxPath, MAX_DOCX_ARCHIVE_BYTES } from './docxText'
import {
  queryIndexCandidates,
  resolveCandidateFullPaths
} from '../codeindex'

const YIELD_EVERY_FILES = 32
export const SEARCH_SCAN_CAP = 5000
export const SEARCH_MAX_FILE_BYTES = 256 * 1024
export const SEARCH_DEFAULT_MAX_RESULTS = 40

async function contentHit(
  file: string,
  rel: string,
  q: string,
  pattern: RegExp,
  regex: boolean
): Promise<string | null> {
  try {
    const st = await fsp.stat(file)
    let text: string
    if (isDocxPath(rel) || isDocxPath(file)) {
      if (st.size > MAX_DOCX_ARCHIVE_BYTES) return null
      text = extractDocxText(await fsp.readFile(file))
    } else {
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

/** Case-insensitive substring or optional regex search over filenames and text contents. */
export async function toolSearch(
  workspaceRoot: string,
  query: string,
  maxResults?: number,
  signal?: AbortSignal,
  regex = false,
  scanCap?: number
): Promise<string> {
  throwIfAborted(signal)
  const q = query.trim()
  if (!q) throw new Error('search query is required')
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
  let indexMode: 'trigram' | 'live' = 'live'

  const liveCap =
    typeof scanCap === 'number' && Number.isFinite(scanCap)
      ? Math.max(1, Math.floor(scanCap))
      : SEARCH_SCAN_CAP
  const page = await collectWorkspaceFilesPage(workspaceRoot, liveCap, undefined, signal)
  const allFiles = page.files
  const liveHitCap = !page.exhausted
  throwIfAborted(signal)

  for (const f of allFiles) {
    if (Number.isFinite(limit) && hits.length >= limit) {
      truncated = true
      break
    }
    if (pattern.test(f.rel)) {
      hits.push(`file: ${f.rel}`)
      fileHitRels.add(f.rel)
    }
  }

  if (Number.isFinite(limit) && hits.length >= limit) {
    truncated = true
  } else {
    let contentFiles: WalkedFile[] = allFiles.filter((f) => !fileHitRels.has(f.rel))
    const sparse = await queryIndexCandidates(workspaceRoot, {
      query: q,
      kind: regex ? 'regex' : 'substring',
      caseSensitive: false,
      signal
    })
    if (sparse?.lookup.ok) {
      const pruned = resolveCandidateFullPaths(workspaceRoot, sparse.lookup.paths).filter(
        (f) => !fileHitRels.has(f.rel)
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
      const hit = await contentHit(file, rel, q, pattern, regex)
      if (hit) hits.push(hit)
    }
  }

  const notices: string[] = []
  if (truncated) notices.push(`… stopped at ${limit} matches`)
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
