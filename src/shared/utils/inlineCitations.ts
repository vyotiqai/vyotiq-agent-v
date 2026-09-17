import { VY_FILE_HREF_PREFIX } from './linkableWorkspacePath'
import { parseArgsRecord } from './toolSummary'
import { isSafeWorkspaceRelPath } from './workspacePath'

const URL_TOOLS = new Set(['browser_search', 'browser_navigate', 'browser_snapshot'])

const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})([^\S\n]*)(.*)$/
const CONTEXT_LINE_RE = /^[> ]\s*\d+\|/
const FILE_HIT_RE = /^file:\s*(.+)$/
const CODEBASE_HIT_RE = /^\d+\.\s+(.+?):(\d+)-(\d+)\s+\[/
const PATH_LINE_RE = /^(.+?):(\d+)(?::\s*|\s*$)/
const NAVIGATED_RE = /^Navigated to\s+(\S+)/im
const URL_HEADER_RE = /^URL:\s+(\S+)/im

export type CiteToolEvidence = {
  name: string
  argsPreview?: string
  content?: string
  status?: 'running' | 'done' | 'fail'
}

export type CitationCatalogEntry =
  | { kind: 'file'; path: string }
  | { kind: 'url'; url: string; key: string }

export type InlineCitationResult = {
  markdown: string
}

type ParsedCiteMarker =
  | { kind: 'file'; path: string; line?: number; endLine?: number }
  | { kind: 'url'; url: string; key: string }

export function collectCitationCatalog(
  tools: readonly CiteToolEvidence[]
): CitationCatalogEntry[] {
  const out: CitationCatalogEntry[] = []
  const seen = new Set<string>()

  const addFile = (raw: string): void => {
    const path = normalizeCitePath(raw)
    if (!path) return
    const key = `file:${path}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ kind: 'file', path })
  }

  const addUrl = (raw: string): void => {
    const parsed = parseCiteUrl(raw)
    if (!parsed) return
    const key = `url:${parsed.key}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ kind: 'url', url: parsed.url, key: parsed.key })
  }

  for (const tool of tools) {
    if (tool.status === 'fail') continue
    const args = parseArgsRecord(tool.argsPreview)
    if (tool.name === 'read') {
      if (args) {
        const path = args.path ?? args.file
        if (typeof path === 'string') addFile(path)
      }
    } else if (tool.name === 'grep' || tool.name === 'search') {
      if (tool.content) addGrepSearchPaths(tool.content, addFile)
    } else if (tool.name === 'codebase_search' || tool.name === 'concept_search') {
      if (tool.content) addCodebaseSearchPaths(tool.content, addFile)
    }
    if (URL_TOOLS.has(tool.name)) {
      if (args && typeof args.url === 'string') addUrl(args.url)
      if (tool.content) addUrlsFromToolContent(tool.content, addUrl)
    }
  }

  return out
}

export function resolveInlineCitations(
  content: string,
  catalog: readonly CitationCatalogEntry[]
): InlineCitationResult {
  if (!content) return { markdown: content }

  const fileByPath = new Map<string, Extract<CitationCatalogEntry, { kind: 'file' }>>()
  const urlByKey = new Map<string, Extract<CitationCatalogEntry, { kind: 'url' }>>()
  for (const entry of catalog) {
    if (entry.kind === 'file') fileByPath.set(entry.path, entry)
    else urlByKey.set(entry.key, entry)
  }

  const rewriteProse = (line: string): string => {
    const withoutOpen = stripUnclosedCiteMarkers(line)
    return mapOutsideInlineCode(withoutOpen, (chunk, chunkStart) =>
      chunk.replace(/\[\[([^\]]+)\]\]/g, (full, inner: string, offsetInChunk) => {
        const parsed = parseCiteMarker(inner)
        if (!parsed) return ''
        if (parsed.kind === 'file') {
          if (!fileByPath.has(parsed.path)) return ''
          const markerStart = chunkStart + offsetInChunk
          if (isPathAlreadyShownOnLine(line, parsed.path, markerStart)) return ''
          return formatFileMarkdownLink(parsed.path, parsed.line, parsed.endLine)
        }
        if (!urlByKey.has(parsed.key)) return ''
        const entry = urlByKey.get(parsed.key)!
        if (!entry.url.startsWith('https:')) return ''
        return `[${formatUrlLabel(entry.url)}](${entry.url})`
      })
    )
  }

  return { markdown: transformProseRegions(content, rewriteProse) }
}

export function formatCitationsForCopy(
  content: string,
  catalog: readonly CitationCatalogEntry[]
): string {
  const { markdown } = resolveInlineCitations(content, catalog)
  return plainResolvedCitationMarkdown(markdown)
}

function plainResolvedCitationMarkdown(markdown: string): string {
  return markdown
    .replace(/\[(.+?)\]\(#vy-file:[^)]+\)/g, '$1')
    .replace(/\[(.+?)\]\((https?:\/\/[^)]+)\)/g, '$2')
}

function parseCiteMarker(inner: string): ParsedCiteMarker | null {
  const trimmed = inner.trim()
  if (!trimmed || /\s/.test(trimmed)) return null
  if (/^https?:\/\//i.test(trimmed)) {
    const parsed = parseCiteUrl(trimmed)
    if (!parsed) return null
    return { kind: 'url', url: parsed.url, key: parsed.key }
  }
  return parseFileMarker(trimmed)
}

function parseFileMarker(
  raw: string
): { kind: 'file'; path: string; line?: number; endLine?: number } | null {
  let path = raw
  let line: number | undefined
  let endLine: number | undefined
  const range = /^(.+):(\d+)-(\d+)$/.exec(raw)
  if (range) {
    path = range[1]!
    line = Number(range[2])
    endLine = Number(range[3])
    if (!Number.isFinite(line) || !Number.isFinite(endLine) || line < 1 || endLine < 1) return null
    if (endLine < line) {
      const swap = line
      line = endLine
      endLine = swap
    }
  } else {
    const colon = raw.lastIndexOf(':')
    if (colon > 0) {
      const suffix = raw.slice(colon + 1)
      if (/^\d+$/.test(suffix)) {
        path = raw.slice(0, colon)
        line = Number(suffix)
        if (!Number.isFinite(line) || line < 1) return null
      }
    }
  }
  const normalized = normalizeCitePath(path)
  if (!normalized) return null
  return { kind: 'file', path: normalized, line, endLine }
}

function normalizeCitePath(raw: string): string | null {
  let path = raw.replace(/\\/g, '/').trim()
  while (path.startsWith('./')) path = path.slice(2)
  if (!isSafeWorkspaceRelPath(path)) return null
  return path
}

function parseCiteUrl(raw: string): { url: string; key: string } | null {
  const trimmed = raw.trim()
  if (!trimmed || /[\s<>]/.test(trimmed)) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const parsed = new URL(withScheme)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    parsed.hash = ''
    if (parsed.username || parsed.password) return null
    const path =
      parsed.pathname.length > 1 && parsed.pathname.endsWith('/')
        ? parsed.pathname.slice(0, -1)
        : parsed.pathname
    parsed.pathname = path || '/'
    const host = parsed.hostname.toLowerCase()
    const key = `${parsed.protocol}//${host}${parsed.pathname}`
    return { url: parsed.toString(), key }
  } catch {
    return null
  }
}

function formatFileLabel(path: string, line?: number, endLine?: number): string {
  if (line != null && endLine != null && endLine !== line) return `${path}:${line}-${endLine}`
  if (line != null) return `${path}:${line}`
  return path
}

function formatFileMarkdownLink(path: string, line?: number, endLine?: number): string {
  const label = formatFileLabel(path, line, endLine)
  const href =
    line != null ? `${VY_FILE_HREF_PREFIX}${path}:${line}` : `${VY_FILE_HREF_PREFIX}${path}`
  return `[${label}](${href})`
}

function formatUrlLabel(url: string): string {
  try {
    const parsed = new URL(url)
    const path =
      parsed.pathname.length > 1 && parsed.pathname.endsWith('/')
        ? parsed.pathname.slice(0, -1)
        : parsed.pathname
    return path && path !== '/' ? `${parsed.hostname}${path}` : parsed.hostname
  } catch {
    return url
  }
}

function isPathAlreadyShownOnLine(line: string, path: string, markerStart: number): boolean {
  const before = line.slice(0, markerStart)
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (new RegExp(`\`${escaped}(?::\\d+)?`).test(before)) return true
  if (new RegExp(`\\]\\(#vy-file:${escaped}(?::\\d+)?\\)`).test(before)) return true
  if (new RegExp(`(?:^|[\\s(])${escaped}(?::\\d+)?(?=[\\s).,;:!?]|$)`).test(before)) return true
  return false
}

function addGrepSearchPaths(content: string, addFile: (path: string) => void): void {
  for (const raw of content.split('\n')) {
    const line = raw.trimEnd()
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('…') || trimmed.startsWith('index=')) continue
    if (CONTEXT_LINE_RE.test(line)) continue
    const fileHit = FILE_HIT_RE.exec(trimmed)
    if (fileHit) {
      addFile(fileHit[1]!.trim())
      continue
    }
    const pathLine = PATH_LINE_RE.exec(trimmed)
    if (pathLine) addFile(pathLine[1]!.trim())
  }
}

function addCodebaseSearchPaths(content: string, addFile: (path: string) => void): void {
  for (const line of content.split('\n')) {
    const codebase = CODEBASE_HIT_RE.exec(line.trim())
    if (codebase) addFile(codebase[1]!.trim())
  }
}

function addUrlsFromToolContent(content: string, addUrl: (url: string) => void): void {
  const navigated = NAVIGATED_RE.exec(content)?.[1]
  if (navigated) addUrl(navigated)
  const header = URL_HEADER_RE.exec(content)?.[1]
  if (header) addUrl(header)
}

function stripUnclosedCiteMarkers(prose: string): string {
  const open = prose.lastIndexOf('[[')
  if (open < 0) return prose
  const close = prose.indexOf(']]', open + 2)
  if (close >= 0) return prose
  return prose.slice(0, open)
}

function transformProseRegions(source: string, mapProse: (chunk: string) => string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let fenceChar: '`' | '~' | null = null
  let fenceLength = 0

  for (const line of lines) {
    const fence = FENCE_LINE_RE.exec(line)
    if (fenceChar == null) {
      if (fence) {
        const marker = fence[1]!
        fenceChar = marker[0] as '`' | '~'
        fenceLength = marker.length
        out.push(line)
        continue
      }
      out.push(mapProse(line))
      continue
    }
    if (fence) {
      const marker = fence[1]!
      const rest = fence[3] ?? ''
      if (
        marker[0] === fenceChar &&
        marker.length >= fenceLength &&
        rest.trim() === ''
      ) {
        fenceChar = null
        fenceLength = 0
      }
    }
    out.push(line)
  }

  return out.join('\n')
}

function mapOutsideInlineCode(
  line: string,
  map: (chunk: string, chunkStart: number) => string
): string {
  let out = ''
  let i = 0
  while (i < line.length) {
    if (line[i] === '`') {
      let n = 1
      while (i + n < line.length && line[i + n] === '`') n++
      const close = line.indexOf('`'.repeat(n), i + n)
      if (close < 0) {
        out += line.slice(i)
        break
      }
      out += line.slice(i, close + n)
      i = close + n
      continue
    }
    const nextTick = line.indexOf('`', i)
    const chunk = nextTick < 0 ? line.slice(i) : line.slice(i, nextTick)
    out += map(chunk, i)
    if (nextTick < 0) break
    i = nextTick
  }
  return out
}
