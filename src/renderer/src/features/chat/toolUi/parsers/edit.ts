import type { UiToolRow } from '@shared/transcript'
import { inferFileWriteAction, reportedRewriteStat } from '@shared/toolSummary'
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
  /**
   * 1-based file line the edit lands on, or null when this edit shape does not
   * report one (full-contents write). `str_replace` takes it from the tool
   * result text; a unified diff takes it from the hunk header. Never inferred.
   */
  changedLine: number | null
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

/** One `split('\n')` line, resolved to what it means in a unified diff. */
type DiffLineClass =
  | { kind: 'metadata' }
  | { kind: 'file-header' }
  | { kind: 'hunk'; newStart: number }
  | { kind: 'add' }
  | { kind: 'del' }
  | { kind: 'context' }
  | { kind: 'newline-marker' }
  | { kind: 'other' }

/** `@@ -a,b +c,d @@` — declares where the hunk starts in each file. */
const HUNK_HEADER_RE = /^@@\s*-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?/
/** Bare `@@`: models emit it, apply accepts it, so the preview must too. */
const BARE_HUNK_RE = /^@@(?:\s.*)?$/
/** The second `@` of a `@@` has not streamed in yet. */
const HUNK_PREFIX_RE = /^@+$/
/** The `---`/`+++` pair that names the file, before the first hunk. */
const FILE_HEADER_RE = /^(?:---|\+\+\+)(?: |\t|$)/
/** How far past a candidate header a numbered `@@` may sit and still count. */
const HEADER_LOOKAHEAD = 32
/** Ceiling on the arrays a classify pass may allocate from one diff string. */
const CLASSIFY_LINE_CAP = 200_000

type HunkState = {
  /** False for a bare `@@`, which declares no counts to spend. */
  declared: boolean
  oldRemaining: number
  newRemaining: number
}

const NO_HUNK: HunkState = { declared: false, oldRemaining: 0, newRemaining: 0 }

/**
 * Classifies every line of a unified diff with one hunk-aware state machine,
 * returning a `classify(index)` accessor. Consumers must call it in order: the
 * answer for line *n* depends on the lines before it.
 *
 * The `---`/`+++` of a patch header name the file; the same two lines inside a
 * hunk body are content, because a removed `-- note` renders as `--- note` and
 * an added `++ note` as `+++ note`. So a sign line is only a header where the
 * format allows one: before the first hunk, or once the running hunk's declared
 * old/new counts are both spent. A bare `@@` declares no counts, so it falls
 * back to a look-ahead — a numbered `@@` further down is the only signal left
 * that what looks like a body line is the next file's header.
 *
 * Classifying first is what keeps the preview rows, the `+N -M` chip and the
 * changed-line badge in agreement: all three read this one scan, so none of
 * them can report a line the others dropped.
 */
function diffLineClassifier(lines: readonly string[]): (index: number) => DiffLineClass {
  let hunk = NO_HUNK
  let seenHunk = false
  /** Are the declared counts spent, so a `---`/`+++` may name the next file? */
  const countsLeft = (): boolean =>
    !hunk.declared || hunk.oldRemaining > 0 || hunk.newRemaining > 0
  const spend = (kind: DiffLineClass['kind']): void => {
    if (!hunk.declared) return
    if (kind === 'del') hunk.oldRemaining -= 1
    else if (kind === 'context') {
      hunk.oldRemaining -= 1
      hunk.newRemaining -= 1
    } else hunk.newRemaining -= 1
  }

  return (index: number): DiffLineClass => {
    const raw = lines[index] ?? ''
    if (isUnifiedDiffMetadata(raw)) return { kind: 'metadata' }
    // A blank line is the empty context line git writes for an empty source
    // line; without a prefix the format still reads it as unchanged text.
    if (raw === '') {
      spend('context')
      return { kind: 'context' }
    }
    const sign = raw[0]!

    const header = HUNK_HEADER_RE.exec(raw)
    if (header) {
      // An omitted count means one line, per the unified diff spec.
      hunk = {
        declared: true,
        oldRemaining: header[2] === undefined ? 1 : Number(header[2]),
        newRemaining: header[4] === undefined ? 1 : Number(header[4])
      }
      seenHunk = true
      return { kind: 'hunk', newStart: Number(header[3]) }
    }
    if (BARE_HUNK_RE.test(raw)) {
      hunk = NO_HUNK
      seenHunk = true
      return { kind: 'hunk', newStart: 0 }
    }
    // Streaming may emit a lone `@` before the second `@` arrives — never paint
    // that as a context row (it would flicker in then vanish once `@@` completes).
    if (HUNK_PREFIX_RE.test(raw)) return { kind: 'other' }

    if (sign === '+' || sign === '-') {
      const kind = sign === '+' ? 'add' : 'del'
      // A sign line names a file only where the format allows one. Before the
      // first hunk that is the `---`/`+++` pair itself; a lone `+body` line is
      // content from a diff that arrived without its header.
      if (!seenHunk) {
        if (FILE_HEADER_RE.test(raw)) return { kind: 'file-header' }
        return { kind }
      }
      // A hunk that still owes declared lines is the real thing: this is its
      // body, whatever its text begins with.
      if (hunk.declared && countsLeft()) {
        spend(kind)
        return { kind }
      }
      // A bare `@@` declared no counts to spend, and a model that understated a
      // hunk's has none left. A numbered `@@` further down is the only evidence
      // that this names the next file; without one the line is content, since
      // swallowing it would drop a change from the card.
      if (hunkHeaderLooksAhead(index, lines)) return { kind: 'file-header' }
      spend(kind)
      return { kind }
    }
    if (sign === '\\') return { kind: 'newline-marker' }
    if (sign === ' ' || seenHunk) {
      spend('context')
      return { kind: 'context' }
    }
    return { kind: 'other' }
  }
}

/**
 * Lines to classify. `split` allocates the whole array and this runs on every
 * streaming chunk, so a runaway single-line "diff" must not be able to make it
 * allocate a million strings; the cap is far above any real patch.
 */
function splitDiffLines(diff: string): string[] {
  const lines = diff.split('\n')
  return lines.length <= CLASSIFY_LINE_CAP ? lines : lines.slice(0, CLASSIFY_LINE_CAP)
}

/**
 * Does a numbered hunk header follow soon? A model that understated a hunk's
 * counts (or wrote a bare `@@`) leaves no declared total to spend, and a header
 * a few lines down is the only evidence that this `---`/`+++` is a file header
 * rather than body content.
 */
function hunkHeaderLooksAhead(index: number, lines: readonly string[]): boolean {
  const limit = Math.min(lines.length, index + 1 + HEADER_LOOKAHEAD)
  for (let j = index + 1; j < limit; j += 1) {
    const ahead = lines[j] ?? ''
    if (HUNK_HEADER_RE.test(ahead)) return true
    if (ahead.startsWith('diff --git')) return true
  }
  return false
}

/** Real `+`/`-` rows in a diff — the same classification the preview renders. */
export function countDiffLines(diff: string): { added: number; removed: number } {
  const lines = splitDiffLines(diff)
  const classify = diffLineClassifier(lines)
  let added = 0
  let removed = 0
  for (let i = 0; i < lines.length; i += 1) {
    const kind = classify(i).kind
    if (kind === 'add') added += 1
    else if (kind === 'del') removed += 1
  }
  return { added, removed }
}

/**
 * 1-based line in the new file where the first hunk's first change lands.
 *
 * Only a unified diff carries real file line numbers. A `str_replace` body
 * knows the replacement text but not where it sits in the file, and a
 * full-contents write replaces the file wholesale — both are handled by the
 * caller returning null rather than pointing an editor at a guessed line.
 */
export function firstChangedLineInDiff(diff: string): number | null {
  const lines = splitDiffLines(diff)
  const classify = diffLineClassifier(lines)
  let lineNumber = 0
  let hunkStart = 0
  for (let i = 0; i < lines.length; i += 1) {
    const row = classify(i)
    if (row.kind === 'hunk') {
      // A bare `@@` carries no +N, so keep the cursor the last hunk left.
      if (row.newStart > 0) lineNumber = row.newStart
      else if (lineNumber === 0) lineNumber = 1
      hunkStart = lineNumber
      continue
    }
    // A deletion does not advance the new-file cursor, but the gap it leaves
    // is where the change reads, so both edge kinds land on lineNumber.
    if (row.kind === 'add' || row.kind === 'del') return lineNumber || null
    if (row.kind === 'context' && lineNumber > 0) lineNumber += 1
  }
  // A hunk header with no change body is malformed; its start is still the
  // best honest answer for where the edit was aimed.
  return hunkStart || null
}

const REPORTED_LINE_RE = /\(line (\d+)\)/

/**
 * 1-based file line a tool result reports for the edit it just made, e.g.
 * `Replaced 1 occurrence in src/x.ts (line 42)`. Null when the result reports
 * no line — a 1,2,3… counter there would read as a real location and is not.
 */
export function reportedLineInContent(content: string | undefined | null): number | null {
  const match = REPORTED_LINE_RE.exec(content ?? '')
  if (!match) return null
  const line = Number(match[1])
  return Number.isInteger(line) && line > 0 ? line : null
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
      return {
        path,
        iconPath,
        fileCount,
        added,
        removed,
        changeLabel: changeLabelFor(added, removed),
        changedLine: reportedLineInContent(tool.content)
      }
    }
  }

  if (typeof args?.contents === 'string') {
    // A rewrite of a file that existed: main reports the real line change, so
    // a small fix to a long file does not read as every line added.
    const reported = reportedRewriteStat(tool.content)
    const added = reported ? reported.add : countLines(args.contents)
    const removed = reported ? reported.del : 0
    return {
      path,
      iconPath,
      fileCount,
      added,
      removed,
      changeLabel: changeLabelFor(added, removed),
      changedLine: null
    }
  }

  if (typeof args?.diff === 'string' && args.diff.trim()) {
    const { added, removed } = countDiffLines(args.diff)
    return {
      path,
      iconPath,
      fileCount,
      added,
      removed,
      changeLabel: changeLabelFor(added, removed),
      changedLine: firstChangedLineInDiff(args.diff)
    }
  }

  return {
    path,
    iconPath,
    fileCount,
    added: 0,
    removed: 0,
    changeLabel: '',
    changedLine: null
  }
}

/**
 * Rows for a `str_replace` body. `startLine` is the file line the tool result
 * reports for the match; both sides count from it because nothing before the
 * match changed. Without a reported line every row stays unnumbered.
 */
function diffLinesFromStrReplace(
  args: Record<string, unknown>,
  startLine: number | null
): DiffLine[] {
  const oldString = typeof args.old_string === 'string' ? args.old_string : ''
  const newString = typeof args.new_string === 'string' ? args.new_string : ''
  if (!oldString && !newString) return []
  const out: DiffLine[] = []
  let start = 0
  for (const [index, text] of splitLines(oldString).entries()) {
    out.push({
      kind: 'del',
      text,
      lineNumber: startLine === null ? null : startLine + index,
      rowKey: `del:${start}`
    })
    start += text.length + 1
  }
  start = 0
  for (const [index, text] of splitLines(newString).entries()) {
    out.push({
      kind: 'add',
      text,
      lineNumber: startLine === null ? null : startLine + index,
      rowKey: `add:${start}`
    })
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

/**
 * A prefix of a diff large enough for the preview, plus the file line its first
 * row sits on so the gutter keeps the file's numbering after a cut. `resume` is
 * null when no hunk header governs the slice — a peek that lands inside a hunk
 * with its header already sliced off — and every row then stays unnumbered
 * rather than counting from a number no file has.
 */
function diffSliceForParse(
  diff: string,
  maxLines: number | undefined,
  fromEnd: boolean
): { text: string; origin: number; resume: number | null } {
  if (typeof maxLines !== 'number' || maxLines <= 0) {
    return { text: diff, origin: 0, resume: newFileLineAt(diff, 0) }
  }
  const budget = Math.min(diff.length, Math.max(16_000, maxLines * 400))
  if (budget >= diff.length) return { text: diff, origin: 0, resume: newFileLineAt(diff, 0) }
  if (!fromEnd) return { text: diff.slice(0, budget), origin: 0, resume: newFileLineAt(diff, 0) }
  const start = diff.length - budget
  const slice = diff.slice(start)
  const nl = slice.indexOf('\n')
  const skip = nl > 0 ? nl + 1 : 0
  const origin = start + skip
  return { text: slice.slice(skip), origin, resume: newFileLineAt(diff, origin) }
}

/**
 * New-file line the line at `offset` sits on, or null when nothing before it
 * says where the file is. A hunk header sets the line and every context or
 * added line spends one; a deletion spends an old-file line only. A model that
 * understated a hunk's counts fails closed — the rows after the cut stay
 * unnumbered rather than drifting onto lines the header never promised.
 */
function newFileLineAt(diff: string, offset: number): number | null {
  if (offset <= 0) return null
  if (offset >= diff.length) return null
  const prefix = splitDiffLines(diff.slice(0, offset))
  // The cut lands on a line boundary, so the split leaves a trailing '' that
  // is no line of the file — counting it would put every row one too high.
  if (prefix[prefix.length - 1] === '') prefix.pop()
  const classify = diffLineClassifier(prefix)
  let lineNumber = 0
  for (let i = 0; i < prefix.length; i += 1) {
    const row = classify(i)
    if (row.kind === 'hunk') {
      if (row.newStart > 0) lineNumber = row.newStart
      else if (lineNumber === 0) lineNumber = 1
    } else if (row.kind === 'context' || row.kind === 'add') lineNumber += 1
  }
  return lineNumber > 0 ? lineNumber : null
}

function capParsedLines(lines: DiffLine[], maxLines: number | undefined, fromEnd: boolean): DiffLine[] {
  if (typeof maxLines !== 'number' || maxLines <= 0 || lines.length <= maxLines) return lines
  return fromEnd ? lines.slice(-maxLines) : lines.slice(0, maxLines)
}

function diffLinesFromEditArgs(
  args: Record<string, unknown>,
  maxLinesOrOpts?: number | DiffPreviewParseOpts,
  startLine: number | null = null
): DiffLine[] {
  const { maxLines, fromEnd = false } = resolveDiffParseOpts(maxLinesOrOpts)

  if (typeof args.old_string === 'string' || typeof args.new_string === 'string') {
    return capParsedLines(diffLinesFromStrReplace(args, startLine), maxLines, fromEnd)
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
    // A whole-file write has no single location; numbering it 1..n would read
    // as "this is where the change is" when nothing is.
    const lines = splitLines(args.contents).map((text) => ({
      kind: 'add' as const,
      text,
      lineNumber: null
    }))
    return capParsedLines(lines, maxLines, fromEnd)
  }

  const diff = typeof args.diff === 'string' ? args.diff : ''
  if (!diff.trim()) return []

  // Avoid allocating/scanning a full 100k-char diff when the UI only shows a preview.
  const { text, origin, resume } = diffSliceForParse(diff, maxLines, fromEnd)
  const sliceLines = splitDiffLines(text)
  const classify = diffLineClassifier(sliceLines)

  const out: DiffLine[] = []
  // A slice cut inside a hunk resumes on the file's own numbering; a cut that
  // left the header behind resumes unnumbered, because a count from zero is a
  // location no file has.
  let lineNumber: number | null = resume
  let pos = 0
  const limit =
    typeof maxLines === 'number' && maxLines > 0 && !fromEnd
      ? maxLines
      : Number.POSITIVE_INFINITY

  for (const [index, raw] of sliceLines.entries()) {
    const lineStart = origin + pos
    pos += raw.length + 1
    if (out.length >= limit) break

    const row = classify(index)
    if (row.kind === 'hunk') {
      if (out.length > 0) {
        out.push({ kind: 'gap', text: '', lineNumber: null, rowKey: `gap:${lineStart}` })
      }
      if (row.newStart > 0) lineNumber = row.newStart
      // No +N in a bare header — keep the cursor, starting at 1 when nothing
      // numbered the file yet.
      else if (lineNumber === null) lineNumber = 1
      continue
    }
    if (row.kind === 'metadata' || row.kind === 'file-header') continue

    if (row.kind === 'add') {
      out.push({
        kind: 'add',
        text: raw.slice(1),
        lineNumber,
        rowKey: `add:${lineStart}`
      })
      if (lineNumber !== null) lineNumber += 1
    } else if (row.kind === 'del') {
      // A deletion has no line in the new file; the gutter stays blank rather
      // than pointing at a line the removal does not occupy.
      out.push({ kind: 'del', text: raw.slice(1), lineNumber: null, rowKey: `del:${lineStart}` })
    } else if (row.kind === 'context') {
      out.push({
        kind: 'context',
        text: raw.startsWith(' ') ? raw.slice(1) : raw,
        lineNumber,
        rowKey: `ctx:${lineStart}`
      })
      if (lineNumber !== null) lineNumber += 1
    }
    // A streaming lone `@`, the `\` no-newline marker and a line the format
    // cannot express are all skipped, and so is `other`.
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
  // One tool result describes one location, so the reported line belongs to the
  // first chunk only; later chunks stay unnumbered.
  const startLine = reportedLineInContent(tool.content)
  const edits = args?.edits
  if (Array.isArray(edits) && edits.length > 0) {
    const out: DiffLine[] = []
    for (const [index, entry] of edits.entries()) {
      if (!entry || typeof entry !== 'object') continue
      const edit = entry as Record<string, unknown>
      const chunk = diffLinesFromEditArgs(edit, opts, index === 0 ? startLine : null)
      if (!chunk.length) continue
      if (out.length > 0) out.push({ kind: 'gap', text: '', lineNumber: null })
      if (typeof edit.path === 'string' && edit.path.trim()) {
        out.push({ kind: 'context', text: edit.path, lineNumber: null })
      }
      out.push(...chunk)
    }
    return capParsedLines(out, opts?.maxLines, Boolean(opts?.fromEnd))
  }
  return diffLinesFromEditArgs((args as Record<string, unknown> | null) ?? {}, opts, startLine)
}

export type FileChange = {
  path: string
  added: number
  removed: number
  action?: 'created' | 'modified' | 'deleted'
}

/** Per-file line deltas for turn change summaries. */
export function collectWritingChanges(tool: UiToolRow): FileChange[] {
  const { path, added, removed } = parseEditCardData(tool)
  const action = inferFileWriteAction(tool.name, tool.content)
  if (!path || (added === 0 && removed === 0 && action !== 'created')) return []
  return [{ path, added, removed, ...(action ? { action } : {}) }]
}
