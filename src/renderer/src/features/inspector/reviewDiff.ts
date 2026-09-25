import type { DiffLine } from '@renderer/features/chat/toolUi'

/**
 * One file's `git diff` text as rows a reviewer reads: hunk headers kept (they
 * carry the enclosing function), every line with its old and new number, and
 * — for the split view — each run of removed lines set against the added lines
 * that replaced it.
 */
export type ReviewLineKind = 'ctx' | 'add' | 'del'

export type ReviewLine = {
  kind: ReviewLineKind
  text: string
  oldN: number | null
  newN: number | null
  /** Index into `flat`, which is what the syntax highlighter keys on. */
  i: number
}

export type ReviewHunk = { key: string; header: string; lines: ReviewLine[] }

export type ParsedReviewDiff = {
  hunks: ReviewHunk[]
  /** Every line in diff order, for highlighting both sides. */
  flat: DiffLine[]
  /** Lines past the cap were dropped. */
  truncated: boolean
}

export type SplitRow =
  | { type: 'hunk'; key: string; header: string }
  | { type: 'line'; key: string; left: ReviewLine | null; right: ReviewLine | null }

export type UnifiedRow =
  | { type: 'hunk'; key: string; header: string }
  | { type: 'line'; key: string; line: ReviewLine }

/** Enough to review; past it the renderer stalls for no reader's benefit. */
export const REVIEW_MAX_LINES = 1000

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

export function parseReviewDiff(diff: string, maxLines = REVIEW_MAX_LINES): ParsedReviewDiff {
  const hunks: ReviewHunk[] = []
  const flat: DiffLine[] = []
  let current: ReviewHunk | null = null
  let oldN = 0
  let newN = 0
  let truncated = false

  for (const raw of diff.split(/\r?\n/)) {
    const hunk = HUNK_RE.exec(raw)
    if (hunk) {
      oldN = Number(hunk[1])
      newN = Number(hunk[2])
      current = { key: `h${hunks.length}`, header: raw, lines: [] }
      hunks.push(current)
      continue
    }
    // Headers and metadata before the first hunk are not lines of the file.
    if (!current) continue
    if (raw.startsWith('\\')) continue
    const sign = raw[0]
    if (sign !== ' ' && sign !== '+' && sign !== '-') continue
    if (flat.length >= maxLines) {
      truncated = true
      break
    }
    const text = raw.slice(1)
    const i = flat.length
    if (sign === ' ') {
      current.lines.push({ kind: 'ctx', text, oldN: oldN++, newN: newN++, i })
      flat.push({ kind: 'context', text, lineNumber: newN - 1 })
    } else if (sign === '-') {
      current.lines.push({ kind: 'del', text, oldN: oldN++, newN: null, i })
      flat.push({ kind: 'del', text, lineNumber: oldN - 1 })
    } else {
      current.lines.push({ kind: 'add', text, oldN: null, newN: newN++, i })
      flat.push({ kind: 'add', text, lineNumber: newN - 1 })
    }
  }
  return { hunks: hunks.filter((h) => h.lines.length > 0), flat, truncated }
}

export function unifiedRows(parsed: ParsedReviewDiff): UnifiedRow[] {
  const rows: UnifiedRow[] = []
  for (const hunk of parsed.hunks) {
    rows.push({ type: 'hunk', key: hunk.key, header: hunk.header })
    for (const line of hunk.lines) rows.push({ type: 'line', key: `l${line.i}`, line })
  }
  return rows
}

/** Removed lines face the added lines that replaced them; the shorter side pads with blanks. */
export function splitRows(parsed: ParsedReviewDiff): SplitRow[] {
  const rows: SplitRow[] = []
  for (const hunk of parsed.hunks) {
    rows.push({ type: 'hunk', key: hunk.key, header: hunk.header })
    let dels: ReviewLine[] = []
    let adds: ReviewLine[] = []
    const flush = (): void => {
      for (let k = 0; k < Math.max(dels.length, adds.length); k += 1) {
        const left = dels[k] ?? null
        const right = adds[k] ?? null
        rows.push({ type: 'line', key: `s${(left ?? right)!.i}`, left, right })
      }
      dels = []
      adds = []
    }
    for (const line of hunk.lines) {
      if (line.kind === 'del') {
        // A removal after additions starts a new change block.
        if (adds.length > 0) flush()
        dels.push(line)
      } else if (line.kind === 'add') adds.push(line)
      else {
        flush()
        rows.push({ type: 'line', key: `s${line.i}`, left: line, right: line })
      }
    }
    flush()
  }
  return rows
}

/** The number a reviewer would call the line by: its new number, or its old one if it is gone. */
export function lineLabel(line: ReviewLine): number {
  return (line.kind === 'del' ? line.oldN : line.newN) ?? 0
}
