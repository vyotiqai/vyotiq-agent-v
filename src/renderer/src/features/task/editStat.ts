import type { UiToolRow } from '@shared/transcript'
import { inferFileWriteAction, parseArgsRecord } from '@shared/toolSummary'
import { lineDiffStat, splitLines } from '@shared/utils/lineDiffStat'

/**
 * Exactly what one write changed, as the record reports it — or `exact: false`
 * when the transcript does not hold enough to say.
 *
 * The transcript's own edit chips count a replacement's old and new text
 * wholesale; that over-counts every unchanged line inside it, so a step would
 * not add up to the Changes total. Here:
 * - `str_replace` diffs its old text against its new text;
 * - `edit` with a unified diff counts the +/- rows inside its hunks;
 * - `edit` that created a file counts every line it wrote;
 * - a whole-file overwrite, a `replace_all` and a delete are not countable
 *   from their arguments (the old text is not there), so they report the path
 *   and no numbers.
 */
export type EditStat = { path: string; exact: true; add: number; del: number } | { path: string; exact: false }

export function editStatOf(tool: UiToolRow): EditStat | null {
  const args = parseArgsRecord(tool.argsPreview)
  const path = typeof args?.path === 'string' && args.path ? args.path : tool.summary?.trim() || ''
  if (!path) return null

  if (tool.name === 'str_replace') {
    const oldText = typeof args?.old_string === 'string' ? args.old_string : null
    const newText = typeof args?.new_string === 'string' ? args.new_string : null
    if (oldText === null || newText === null || args?.replace_all === true) return { path, exact: false }
    const stat = lineDiffStat(oldText, newText)
    return stat ? { path, exact: true, ...stat } : { path, exact: false }
  }

  if (tool.name === 'edit') {
    if (typeof args?.diff === 'string' && args.diff.trim()) {
      return diffStatOf(args.diff, path)
    }
    if (typeof args?.contents === 'string' && inferFileWriteAction(tool.name, tool.content) === 'created') {
      return { path, exact: true, add: splitLines(args.contents).length, del: 0 }
    }
    return { path, exact: false }
  }

  if (tool.name === 'delete') return { path, exact: false }
  return null
}

/** The `@@ -a,b +c,d @@` line that opens a hunk, as `parseReviewDiff` reads it. */
const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/

/**
 * The +/- rows a unified diff actually changed.
 *
 * Headers and metadata sit before the first `@@` and nowhere else, so a
 * `--- ` / `+++ ` row inside a hunk is a removed / added line whose own text
 * starts with `-` / `+` — skipping it by its prefix, as the old filter did,
 * dropped real changes while still reporting `exact: true`. A diff with no
 * hunk header is a body either way and is counted. A row inside a hunk that
 * carries no sign at all means the diff is malformed; guessing there would be
 * a confidently wrong number, so it reports the path and none.
 */
function diffStatOf(diff: string, path: string): EditStat {
  let add = 0
  let del = 0
  let inHunk = false
  for (const line of splitLines(diff)) {
    if (HUNK_HEADER_RE.test(line)) {
      inHunk = true
      continue
    }
    if (!inHunk && (line.startsWith('+++') || line.startsWith('---'))) continue
    const sign = line[0]
    if (line === '' || sign === '\\') continue
    if (sign === '+') add += 1
    else if (sign === '-') del += 1
    else if (sign === ' ') continue
    else if (inHunk) return { path, exact: false }
  }
  return { path, exact: true, add, del }
}

/** Sum of a step's writes: files touched, and lines when every write was countable. */
export function sumEditStats(stats: readonly EditStat[]): { files: number; add?: number; del?: number } | null {
  if (stats.length === 0) return null
  const paths = new Set(stats.map((s) => s.path.replace(/\\/g, '/')))
  if (!stats.every((s) => s.exact)) return { files: paths.size }
  let add = 0
  let del = 0
  for (const s of stats) {
    if (!s.exact) continue
    add += s.add
    del += s.del
  }
  return { files: paths.size, add, del }
}
