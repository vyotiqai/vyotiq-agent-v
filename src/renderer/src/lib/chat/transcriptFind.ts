import type { TranscriptRow } from '@renderer/features/chat/utils/transcriptRows'

function toolSummaries(row: Extract<TranscriptRow, { kind: 'activity' | 'card' }>): string {
  if (row.kind === 'card') return row.item.tool.summary ?? ''
  return row.tools.map((item) => item.tool.summary ?? '').join('\n')
}

/** Searchable text for a visible transcript row — not full tool content blobs. */
export function transcriptRowSearchText(row: TranscriptRow): string {
  switch (row.kind) {
    case 'user':
    case 'text':
      return row.item.content
    case 'thinking':
      return row.item.thinking ?? ''
    case 'compaction':
      return [row.summary, ...(row.verifyFailures ?? [])].filter(Boolean).join('\n')
    case 'changes':
      return row.files.map((file) => file.path).join('\n')
    case 'activity':
    case 'card':
      return toolSummaries(row)
    case 'approval':
      return `${row.approval.toolName} ${row.approval.summary}`
    case 'question':
      return [row.question.title, ...row.question.questions.map((q) => q.prompt)]
        .filter(Boolean)
        .join('\n')
    case 'run_error':
      return row.message
    case 'turn':
      return ''
    default: {
      const _exhaustive: never = row
      return _exhaustive
    }
  }
}

/** Indices into `rows` whose searchable text contains `query` (case-insensitive). */
export function findTranscriptRowMatches(
  rows: readonly TranscriptRow[],
  query: string
): number[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const out: number[] = []
  for (let i = 0; i < rows.length; i++) {
    if (transcriptRowSearchText(rows[i]!).toLowerCase().includes(q)) out.push(i)
  }
  return out
}

/** Wrap a possibly-negative step index into `[0, matchCount)`. */
export function wrapMatchIndex(index: number, matchCount: number): number {
  if (matchCount <= 0) return 0
  return ((index % matchCount) + matchCount) % matchCount
}

/** True when the Changes or PR dock is visible and should own Ctrl+F. */
export function isChangesOrPrDockClaimingFind(): boolean {
  if (typeof document === 'undefined') return false
  for (const id of ['dock-panel-changes', 'dock-panel-pr'] as const) {
    const el = document.getElementById(id)
    if (!el) continue
    if (el.hasAttribute('inert')) continue
    if (el.getAttribute('aria-hidden') === 'true') continue
    if (el.classList.contains('hidden')) continue
    return true
  }
  return false
}
