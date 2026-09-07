import type { UiToolRow } from '@shared/transcript'
import { inferFileWriteAction } from '@shared/toolSummary'
import { extractPartialEditArgs } from '@shared/utils/partialJson'
import { countLines, splitLines, splitLinesTail } from './common'

export { countLines, splitLines } from './common'

export type EditCardData = {
  /** Display path. */
  path: string
  /** Single real path for Material file icons; empty when unknown. */
  iconPath: string
  fileCount: number
  added: number
  removed: number
  changeLabel: string
}

/** Prefer a concrete file path for icons; reject placeholders / joined lists. */
export function iconPathForFile(path: string | undefined | null): string {
  const raw = (path ?? '').trim()
  if (!raw || raw === 'file') return ''
  if (raw.includes(', ')) {
    const first = raw.split(', ')[0]?.trim() ?? ''
    return first && first !== 'file' ? first : ''
  }
  return raw
}

export type DiffLineKind = 'add' | 'del' | 'context' | 'gap'

export type DiffLine = {
  kind: DiffLineKind
  text: string
  lineNumber: number | null
  /** Stable React identity while a streaming peek slides (byte offset in source). */
  rowKey?: string
}

export function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue
    if (line.startsWith('+')) added += 1
    else if (line.startsWith('-')) removed += 1
  }
  return { added, removed }
}

function changeLabelFor(added: number, removed: number): string {
  const parts: string[] = []
  if (added > 0) parts.push(`+${added}`)
  if (removed > 0) parts.push(`-${removed}`)
  return parts.join(' ')
}

export function parseEditCardData(tool: UiToolRow): EditCardData {
  // Streaming argsPreview is often incomplete JSON — extract path/diff early.
  const args = extractPartialEditArgs(tool.argsPreview)
  const rawPath = typeof args?.path === 'string' ? args.path : tool.summary?.trim() || ''
  const path = rawPath
  const iconPath = iconPathForFile(rawPath)
  const fileCount = path ? 1 : 0

  if (
    tool.name === 'str_replace' ||
    typeof args?.old_string === 'string' ||
    typeof args?.new_string === 'string'
  ) {
    const oldString = typeof args?.old_string === 'string' ? args.old_string : ''
    const newString = typeof args?.new_string === 'string' ? args.new_string : ''
    if (oldString || newString) {
      const removed = countLines(oldString)
      const added = countLines(newString)
      return { path, iconPath, fileCount, added, removed, changeLabel: changeLabelFor(added, removed) }
    }
  }

  if (typeof args?.contents === 'string') {
    const added = countLines(args.contents)
    return { path, iconPath, fileCount, added, removed: 0, changeLabel: changeLabelFor(added, 0) }
  }

  if (typeof args?.diff === 'string' && args.diff.trim()) {
    const { added, removed } = countDiffLines(args.diff)
    return { path, iconPath, fileCount, added, removed, changeLabel: changeLabelFor(added, removed) }
  }

  return { path, iconPath, fileCount, added: 0, removed: 0, changeLabel: '' }
}

function diffLinesFromStrReplace(args: Record<string, unknown>): DiffLine[] {
  const oldString = typeof args.old_string === 'string' ? args.old_string : ''
  const newString = typeof args.new_string === 'string' ? args.new_string : ''
  if (!oldString && !newString) return []
  const out: DiffLine[] = []
  let start = 0
  for (const text of splitLines(oldString)) {
    out.push({ kind: 'del', text, lineNumber: null, rowKey: `del:${start}` })
    start += text.length + 1
  }
  start = 0
  for (const [index, text] of splitLines(newString).entries()) {
    out.push({ kind: 'add', text, lineNumber: index + 1, rowKey: `add:${start}` })
    start += text.length + 1
  }
  return out
}

function isUnifiedDiffMetadata(raw: string): boolean {
  return (
    raw.startsWith('diff --git') ||
    raw.startsWith('index ') ||
    raw.startsWith('new file mode') ||
    raw.startsWith('deleted file mode') ||
    raw.startsWith('old mode') ||
    raw.startsWith('new mode') ||
    raw.startsWith('similarity index') ||
    raw.startsWith('rename from') ||
    raw.startsWith('rename to') ||
    raw.startsWith('copy from') ||
    raw.startsWith('copy to') ||
    raw.startsWith('Binary files ')
  )
}

export type DiffPreviewParseOpts = {
  maxLines?: number
  /** Prefer newest lines (live streaming peek). */
  fromEnd?: boolean
}

function resolveDiffParseOpts(
  maxLinesOrOpts?: number | DiffPreviewParseOpts
): DiffPreviewParseOpts {
  if (typeof maxLinesOrOpts === 'number') return { maxLines: maxLinesOrOpts }
  return maxLinesOrOpts ?? {}
}

function diffSliceForParse(
  diff: string,
  maxLines: number | undefined,
  fromEnd: boolean
): { text: string; origin: number } {
  if (typeof maxLines !== 'number' || maxLines <= 0) return { text: diff, origin: 0 }
  const budget = Math.min(diff.length, Math.max(16_000, maxLines * 400))
  if (budget >= diff.length) return { text: diff, origin: 0 }
  if (!fromEnd) return { text: diff.slice(0, budget), origin: 0 }
  const start = diff.length - budget
  const slice = diff.slice(start)
  const nl = slice.indexOf('\n')
  const skip = nl > 0 ? nl + 1 : 0
  return { text: slice.slice(skip), origin: start + skip }
}

function capParsedLines(lines: DiffLine[], maxLines: number | undefined, fromEnd: boolean): DiffLine[] {
  if (typeof maxLines !== 'number' || maxLines <= 0 || lines.length <= maxLines) return lines
  return fromEnd ? lines.slice(-maxLines) : lines.slice(0, maxLines)
}

function diffLinesFromEditArgs(
  args: Record<string, unknown>,
  maxLinesOrOpts?: number | DiffPreviewParseOpts
): DiffLine[] {
  const { maxLines, fromEnd = false } = resolveDiffParseOpts(maxLinesOrOpts)

  if (typeof args.old_string === 'string' || typeof args.new_string === 'string') {
    return capParsedLines(diffLinesFromStrReplace(args), maxLines, fromEnd)
  }

  if (typeof args.contents === 'string') {
    if (fromEnd && typeof maxLines === 'number' && maxLines > 0) {
      const lines: DiffLine[] = splitLinesTail(args.contents, maxLines).map(({ text, start }) => ({
        kind: 'add',
        text,
        lineNumber: null,
        rowKey: `add:${start}`
      }))
      return capParsedLines(lines, maxLines, fromEnd)
    }
    const lines = splitLines(args.contents).map((text, index) => ({
      kind: 'add' as const,
      text,
      lineNumber: index + 1
    }))
    return capParsedLines(lines, maxLines, fromEnd)
  }

  const diff = typeof args.diff === 'string' ? args.diff : ''
  if (!diff.trim()) return []

  // Avoid allocating/scanning a full 100k-char diff when the UI only shows a preview.
  const { text, origin } = diffSliceForParse(diff, maxLines, fromEnd)

  const out: DiffLine[] = []
  let lineNumber = 0
  let pos = 0
  const limit =
    typeof maxLines === 'number' && maxLines > 0 && !fromEnd
      ? maxLines
      : Number.POSITIVE_INFINITY

  for (const raw of text.split('\n')) {
    const lineStart = origin + pos
    pos += raw.length + 1
    if (out.length >= limit) break
    if (raw.startsWith('+++') || raw.startsWith('---')) continue
    if (isUnifiedDiffMetadata(raw)) continue

    const hunk = raw.match(/^@@\s*-\d+(?:,\d+)?\s*\+(\d+)/)
    if (hunk) {
      if (out.length > 0) {
        out.push({ kind: 'gap', text: '', lineNumber: null, rowKey: `gap:${lineStart}` })
      }
      lineNumber = Number(hunk[1])
      continue
    }

    // Bare `@@` (no -N,+M) — models emit this; apply accepts it, preview must too.
    if (/^@@(?:\s.*)?$/.test(raw)) {
      if (out.length > 0) {
        out.push({ kind: 'gap', text: '', lineNumber: null, rowKey: `gap:${lineStart}` })
      }
      // No +N in header — start gutter at 1 when we have not seen a numbered hunk yet.
      if (lineNumber === 0) lineNumber = 1
      continue
    }

    // Streaming may emit a lone `@` before the second `@` arrives — never paint that
    // as a context row (it would flicker in then vanish once `@@` completes).
    if (raw.startsWith('@')) continue

    if (raw.startsWith('+')) {
      out.push({ kind: 'add', text: raw.slice(1), lineNumber, rowKey: `add:${lineStart}` })
      lineNumber += 1
    } else if (raw.startsWith('-')) {
      out.push({ kind: 'del', text: raw.slice(1), lineNumber: null, rowKey: `del:${lineStart}` })
    } else if (raw.startsWith('\\')) {
      continue
    } else {
      out.push({
        kind: 'context',
        text: raw.startsWith(' ') ? raw.slice(1) : raw,
        lineNumber,
        rowKey: `ctx:${lineStart}`
      })
      lineNumber += 1
    }
  }

  while (out.length > 0 && out[out.length - 1]!.kind === 'gap') out.pop()
  return capParsedLines(out, maxLines, fromEnd)
}

/** Parse a unified diff string into preview lines (shared by edit + git_diff). */
export function parseUnifiedDiff(diff: string, maxLines?: number): DiffLine[] {
  if (!diff.trim()) return []
  return diffLinesFromEditArgs({ diff }, maxLines)
}

export function parseDiffPreview(
  tool: UiToolRow,
  opts?: DiffPreviewParseOpts
): DiffLine[] {
  const args = extractPartialEditArgs(tool.argsPreview)
  const edits = args?.edits
  if (Array.isArray(edits) && edits.length > 0) {
    const out: DiffLine[] = []
    for (const entry of edits) {
      if (!entry || typeof entry !== 'object') continue
      const edit = entry as Record<string, unknown>
      const chunk = diffLinesFromEditArgs(edit, opts)
      if (!chunk.length) continue
      if (out.length > 0) out.push({ kind: 'gap', text: '', lineNumber: null })
      if (typeof edit.path === 'string' && edit.path.trim()) {
        out.push({ kind: 'context', text: edit.path, lineNumber: null })
      }
      out.push(...chunk)
    }
    return capParsedLines(out, opts?.maxLines, Boolean(opts?.fromEnd))
  }
  return diffLinesFromEditArgs((args as Record<string, unknown> | null) ?? {}, opts)
}

export type FileChange = {
  path: string
  added: number
  removed: number
  action?: 'created' | 'modified' | 'deleted'
}

function normalizeWritePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '')
}

function changeFromEditArgs(
  edit: Record<string, unknown>,
  action?: 'created' | 'modified'
): FileChange | null {
  const path = typeof edit.path === 'string' ? edit.path : ''
  if (!path) return null
  if (typeof edit.contents === 'string') {
    const added = countLines(edit.contents)
    if (added > 0 || action === 'created') {
      return { path, added, removed: 0, ...(action ? { action } : {}) }
    }
    return null
  }
  if (typeof edit.diff === 'string' && edit.diff.trim()) {
    const { added, removed } = countDiffLines(edit.diff)
    if (added > 0 || removed > 0) {
      return { path, added, removed, ...(action ? { action } : {}) }
    }
  }
  return null
}

/** Per-file line deltas for turn change summaries. */
export function collectWritingChanges(tool: UiToolRow): FileChange[] {
  const { path, added, removed } = parseEditCardData(tool)
  const action = inferFileWriteAction(tool.name, tool.content)
  if (!path || (added === 0 && removed === 0 && action !== 'created')) return []
  return [{ path, added, removed, ...(action ? { action } : {}) }]
}
