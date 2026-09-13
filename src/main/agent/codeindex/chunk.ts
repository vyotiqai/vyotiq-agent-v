import { extname } from 'path'
import type { ChunkKind, CodeChunk } from './types'
import { MAX_CHUNK_CHARS } from './types'

function toLines(source: string): string[] {
  return source.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
}

function sliceLines(lines: string[], startLine: number, endLine: number): string {
  return lines.slice(startLine - 1, endLine).join('\n')
}

function contextualize(
  path: string,
  kind: ChunkKind,
  name: string,
  parentName: string | undefined,
  text: string
): string {
  const header = [
    `file: ${path}`,
    parentName ? `parent: ${parentName}` : null,
    `kind: ${kind}`,
    `name: ${name}`
  ]
    .filter(Boolean)
    .join('\n')
  return `${header}\n\n${text}`
}

function makeChunk(
  path: string,
  lines: string[],
  startLine: number,
  endLine: number,
  kind: ChunkKind,
  name: string,
  parentName?: string
): CodeChunk {
  const text = sliceLines(lines, startLine, endLine)
  return {
    path,
    startLine,
    endLine,
    kind,
    name,
    parentName,
    text,
    contextualizedText: contextualize(path, kind, name, parentName, text)
  }
}

function findBraceEnd(source: string, openIdx: number): number {
  let depth = 0
  let inStr: '"' | "'" | '`' | null = null
  let escape = false
  for (let i = openIdx; i < source.length; i++) {
    const ch = source[i]!
    if (inStr) {
      if (escape) {
        escape = false
        continue
      }
      if (ch === '\\' && inStr !== '`') {
        escape = true
        continue
      }
      if (ch === inStr) inStr = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return source.length - 1
}

function lineAt(source: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === '\n') line++
  }
  return line
}

type Span = {
  startLine: number
  endLine: number
  kind: ChunkKind
  name: string
  parentName?: string
}

const NESTED_CHILD_KINDS = new Set<ChunkKind>(['function', 'method'])

/**
 * Do not embed a class body that is already covered by method/function children.
 * Keep `parentName` on children so FTS still finds the class.
 */
export function dropParentSpansCoveredByChildren<T extends Span>(spans: T[]): T[] {
  return spans.filter((span, i) => {
    if (span.kind !== 'class') return true
    return !spans.some((other, j) => {
      if (i === j) return false
      if (!NESTED_CHILD_KINDS.has(other.kind)) return false
      if (other.parentName === span.name) return true
      return (
        other.startLine >= span.startLine &&
        other.endLine <= span.endLine &&
        (other.startLine > span.startLine || other.endLine < span.endLine)
      )
    })
  })
}

function splitOversized(lines: string[], span: Span, path: string): CodeChunk[] {
  const text = sliceLines(lines, span.startLine, span.endLine)
  if (text.length <= MAX_CHUNK_CHARS) {
    return [makeChunk(path, lines, span.startLine, span.endLine, span.kind, span.name, span.parentName)]
  }
  const out: CodeChunk[] = []
  let start = span.startLine
  while (start <= span.endLine) {
    let end = start
    let size = 0
    while (end <= span.endLine) {
      const lineLen = (lines[end - 1]?.length ?? 0) + 1
      if (size > 0 && size + lineLen > MAX_CHUNK_CHARS) break
      size += lineLen
      end++
    }
    const last = Math.max(start, end - 1)
    out.push(
      makeChunk(
        path,
        lines,
        start,
        last,
        span.kind,
        `${span.name}#${out.length + 1}`,
        span.parentName ?? span.name
      )
    )
    start = last + 1
  }
  return out
}

function chunkTypeScriptLike(path: string, source: string): CodeChunk[] {
  const lines = toLines(source)
  const spans: Span[] = []
  const classRe =
    /(?:^|\n)(?:export\s+)?(?:abstract\s+)?(?:default\s+)?class\s+([A-Za-z0-9_$]+)/g
  const funcRe =
    /(?:^|\n)(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)\s*\(/g
  const methodRe =
    /(?:^|\n)[ \t]+(?:(?:public|private|protected|static|async|readonly|override|get|set)\s+)*([A-Za-z0-9_$]+)\s*\([^;{]*\)\s*(?::\s*[^{;]+)?\s*\{/g
  const arrowRe =
    /(?:^|\n)(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>/g

  const pushFromMatch = (
    re: RegExp,
    kind: ChunkKind,
    getParent?: (idx: number) => string | undefined
  ): void => {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(source)) !== null) {
      const name = m[1]!
      const nameIdx = m.index + m[0].lastIndexOf(name)
      const braceIdx = source.indexOf('{', nameIdx)
      const arrowBody = source.indexOf('=>', nameIdx)
      let endIdx: number
      let startLine = lineAt(source, m.index === 0 ? 0 : m.index + 1)
      if (kind !== 'function' && braceIdx >= 0 && (arrowBody < 0 || braceIdx < arrowBody + 2)) {
        endIdx = findBraceEnd(source, braceIdx)
      } else if (braceIdx >= 0 && (kind === 'function' || kind === 'class' || kind === 'method')) {
        endIdx = findBraceEnd(source, braceIdx)
      } else if (arrowBody >= 0) {
        const after = arrowBody + 2
        const trimmed = source.slice(after).match(/^\s*/)
        const bodyStart = after + (trimmed?.[0].length ?? 0)
        if (source[bodyStart] === '{') {
          endIdx = findBraceEnd(source, bodyStart)
        } else {
          const semi = source.indexOf('\n', bodyStart)
          endIdx = semi >= 0 ? semi : source.length - 1
        }
      } else {
        continue
      }
      const endLine = lineAt(source, endIdx)
      spans.push({
        startLine,
        endLine: Math.max(startLine, endLine),
        kind,
        name,
        parentName: getParent?.(m.index)
      })
    }
  }

  const classSpans: Span[] = []
  classRe.lastIndex = 0
  let cm: RegExpExecArray | null
  while ((cm = classRe.exec(source)) !== null) {
    const name = cm[1]!
    const braceIdx = source.indexOf('{', cm.index)
    if (braceIdx < 0) continue
    const endIdx = findBraceEnd(source, braceIdx)
    const startLine = lineAt(source, cm.index === 0 ? 0 : cm.index + 1)
    const endLine = lineAt(source, endIdx)
    classSpans.push({ startLine, endLine: Math.max(startLine, endLine), kind: 'class', name })
  }
  spans.push(...classSpans)

  const parentFor = (idx: number): string | undefined => {
    const line = lineAt(source, idx)
    for (const c of classSpans) {
      if (line >= c.startLine && line <= c.endLine) return c.name
    }
    return undefined
  }

  pushFromMatch(funcRe, 'function')
  pushFromMatch(arrowRe, 'function')
  pushFromMatch(methodRe, 'method', parentFor)

  return finalizeSpans(path, lines, source, spans)
}

function chunkPython(path: string, source: string): CodeChunk[] {
  const lines = toLines(source)
  const spans: Span[] = []
  const headerRe = /^(\s*)(def|class)\s+([A-Za-z0-9_]+)\s*[(:]/

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(headerRe)
    if (!m) continue
    const kind: ChunkKind = m[2] === 'class' ? 'class' : 'function'
    const name = m[3]!
    const indent = m[1]!.length
    let end = i + 1
    while (end < lines.length) {
      const line = lines[end]!
      if (line.trim() === '') {
        end++
        continue
      }
      const ind = (line.match(/^\s*/)?.[0].length ?? 0)
      if (ind <= indent && !line.trim().startsWith('#')) break
      end++
    }
    let parentName: string | undefined
    if (kind === 'function') {
      for (let j = spans.length - 1; j >= 0; j--) {
        const s = spans[j]!
        if (s.kind === 'class' && i + 1 >= s.startLine && i + 1 <= s.endLine) {
          parentName = s.name
          break
        }
      }
      // Nested defs stay inside the parent function chunk.
      if (indent > 0 && !parentName) continue
    }
    spans.push({
      startLine: i + 1,
      endLine: Math.max(i + 1, end),
      kind: parentName ? 'method' : kind,
      name,
      parentName
    })
  }
  return finalizeSpans(path, lines, source, spans)
}

function chunkMarkdown(path: string, source: string): CodeChunk[] {
  const lines = toLines(source)
  const spans: Span[] = []
  let start = 1
  let name = 'preamble'
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^(#{1,6})\s+(.+)$/)
    if (!m) continue
    if (i > 0) {
      spans.push({ startLine: start, endLine: i, kind: 'section', name })
    }
    start = i + 1
    name = m[2]!.trim().slice(0, 80) || 'section'
  }
  spans.push({ startLine: start, endLine: lines.length || 1, kind: 'section', name })
  return finalizeSpans(path, lines, source, spans)
}

function chunkJson(path: string, source: string): CodeChunk[] {
  const lines = toLines(source)
  try {
    const obj = JSON.parse(source) as unknown
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const spans: Span[] = []
      for (const key of Object.keys(obj as Record<string, unknown>)) {
        const keyRe = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:`)
        const m = keyRe.exec(source)
        if (!m) continue
        const startLine = lineAt(source, m.index)
        spans.push({
          startLine,
          endLine: Math.min(lines.length, startLine + 40),
          kind: 'block',
          name: key
        })
      }
      if (spans.length) return finalizeSpans(path, lines, source, spans)
    }
  } catch {
    /* fall through */
  }
  return [
    makeChunk(path, lines, 1, Math.max(1, lines.length), 'module', path.split('/').pop() ?? path)
  ]
}

const MODULE_CONTEXT_START_MAX = 40
const MODULE_CONTEXT_MAX_SPAN = 80

/**
 * File-start uncovered runs (imports / banners), merged across blanks and split
 * on covered function/class bodies so module_context never spans them.
 */
export function appendModuleContextChunks(
  chunks: CodeChunk[],
  path: string,
  lines: string[],
  covered: ReadonlySet<number>
): void {
  const runs: { startLine: number; endLine: number }[] = []
  let start: number | null = null
  let end = 0
  for (let i = 1; i <= lines.length; i++) {
    if (covered.has(i)) {
      if (start != null) {
        runs.push({ startLine: start, endLine: end })
        start = null
      }
      continue
    }
    if (!lines[i - 1]!.trim()) continue
    if (start == null) start = i
    end = i
  }
  if (start != null) runs.push({ startLine: start, endLine: end })

  for (const run of runs) {
    if (run.startLine > MODULE_CONTEXT_START_MAX) continue
    chunks.push(
      makeChunk(
        path,
        lines,
        run.startLine,
        Math.min(run.endLine, run.startLine + MODULE_CONTEXT_MAX_SPAN),
        'module',
        'module_context'
      )
    )
  }
}

function finalizeSpans(
  path: string,
  lines: string[],
  source: string,
  spans: Span[]
): CodeChunk[] {
  const sorted = dropParentSpansCoveredByChildren(
    [...spans].sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine)
  )
  const covered = new Set<number>()
  const chunks: CodeChunk[] = []
  for (const span of sorted) {
    for (let ln = span.startLine; ln <= span.endLine; ln++) covered.add(ln)
    chunks.push(...splitOversized(lines, span, path))
  }

  appendModuleContextChunks(chunks, path, lines, covered)

  if (!chunks.length && source.trim()) {
    chunks.push(
      makeChunk(path, lines, 1, Math.max(1, lines.length), 'module', path.split('/').pop() ?? 'file')
    )
  }
  return chunks.sort((a, b) => a.startLine - b.startLine)
}

/** Chunk source at syntactic boundaries (function/class/section). */
export function chunkSource(path: string, source: string): CodeChunk[] {
  const ext = extname(path).toLowerCase()
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    return chunkTypeScriptLike(path, source)
  }
  if (ext === '.py') return chunkPython(path, source)
  if (ext === '.md' || ext === '.mdc') return chunkMarkdown(path, source)
  if (ext === '.json') return chunkJson(path, source)
  const lines = toLines(source)
  return [
    makeChunk(path, lines, 1, Math.max(1, lines.length), 'module', path.split('/').pop() ?? 'file')
  ]
}
