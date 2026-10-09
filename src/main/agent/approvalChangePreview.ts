import { existsSync, readFileSync, statSync } from 'fs'
import type { ApprovalChangePreview, ApprovalChangeLine } from '../../shared/ipc'
import { splitLines } from '../../shared/utils/lineDiffStat'
import { lineDiff } from '../../shared/utils/unifiedDiff'
import { scrubString } from '../../shared/utils/scrub'
import { resolveInsideWorkspace } from '../workspace/safePath'

/**
 * What an edit approval would change, as −/+ rows. The card used to say
 * "change a file? src/math.js" and offer one line of raw JSON, cut at 4,000
 * characters; this is built from the call's full arguments, and for a
 * whole-file write from the file on disk, so a person can judge the edit.
 */

/** Rows the card shows; the rest are counted, not sent. */
export const APPROVAL_PREVIEW_MAX_LINES = 200
/** A line wider than this is cut: one minified line must not fill the card. */
const MAX_LINE_CHARS = 400
/** Files past this are not read for a whole-file write: the rows say "replaces the file". */
const MAX_DISK_BYTES = 1_000_000

function parseArgs(argsJson: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(argsJson || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function row(kind: ApprovalChangeLine['kind'], text: string): ApprovalChangeLine {
  const clean = scrubString(text)
  return { kind, text: clean.length > MAX_LINE_CHARS ? `${clean.slice(0, MAX_LINE_CHARS)}…` : clean }
}

function capped(
  path: string,
  action: ApprovalChangePreview['action'],
  lines: ApprovalChangeLine[],
  extra: Partial<ApprovalChangePreview> = {}
): ApprovalChangePreview {
  const add = lines.filter((l) => l.kind === '+').length
  const del = lines.filter((l) => l.kind === '-').length
  return {
    path,
    action,
    add,
    del,
    lines: lines.slice(0, APPROVAL_PREVIEW_MAX_LINES),
    hiddenLines: Math.max(0, lines.length - APPROVAL_PREVIEW_MAX_LINES),
    ...extra
  }
}

/** A unified diff the model wrote, as rows; `@@` headers become hunk breaks. */
function rowsFromUnifiedDiff(diff: string): ApprovalChangeLine[] {
  const out: ApprovalChangeLine[] = []
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('diff ') || line.startsWith('index ')) continue
    if (line.startsWith('@@')) out.push(row('@', line))
    else if (line.startsWith('+')) out.push(row('+', line.slice(1)))
    else if (line.startsWith('-')) out.push(row('-', line.slice(1)))
    else if (line.startsWith(' ')) out.push(row(' ', line.slice(1)))
    else if (line === '\\ No newline at end of file' || line === '') continue
    else out.push(row(' ', line))
  }
  return out
}

function readDisk(workspaceRoot: string, relPath: string): { text: string } | { missing: true } | null {
  try {
    const full = resolveInsideWorkspace(workspaceRoot, relPath)
    if (!existsSync(full)) return { missing: true }
    const stat = statSync(full)
    if (!stat.isFile() || stat.size > MAX_DISK_BYTES) return null
    return { text: readFileSync(full, 'utf8') }
  } catch {
    return null
  }
}

/**
 * The preview for `str_replace` and `edit`; null for any other tool, or when
 * the arguments do not parse (the card falls back to the raw request).
 */
export function buildApprovalChangePreview(
  toolName: string,
  argsJson: string,
  workspaceRoot: string | undefined
): ApprovalChangePreview | null {
  if (toolName !== 'str_replace' && toolName !== 'edit') return null
  const args = parseArgs(argsJson)
  const path = typeof args?.path === 'string' ? args.path.trim() : ''
  if (!args || !path) return null

  if (toolName === 'str_replace') {
    if (typeof args.old_string !== 'string' || typeof args.new_string !== 'string') return null
    const lines = [
      ...splitLines(args.old_string).map((l) => row('-', l)),
      ...splitLines(args.new_string).map((l) => row('+', l))
    ]
    return capped(path, 'modify', lines, args.replace_all === true ? { everyMatch: true } : {})
  }

  if (typeof args.diff === 'string' && args.diff.trim()) {
    return capped(path, 'modify', rowsFromUnifiedDiff(args.diff))
  }
  if (typeof args.contents !== 'string') return null
  const disk = workspaceRoot ? readDisk(workspaceRoot, path) : null
  if (disk && 'missing' in disk) {
    return capped(path, 'create', splitLines(args.contents).map((l) => row('+', l)))
  }
  if (disk) {
    const diff = lineDiff(disk.text, args.contents)
    const lines: ApprovalChangeLine[] = []
    for (const hunk of diff.hunks) {
      lines.push(row('@', `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${hunk.context ? ` ${hunk.context}` : ''}`))
      for (const line of hunk.lines) lines.push(row(line.kind, line.text))
    }
    return capped(path, 'modify', lines)
  }
  // Unreadable or too large to diff: what will be written, marked as a rewrite.
  return capped(path, 'rewrite', splitLines(args.contents).map((l) => row('+', l)))
}
