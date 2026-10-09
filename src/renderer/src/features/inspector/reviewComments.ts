import type { AskTarget } from './ReviewDiffTable'
import { lineLabel } from './reviewDiff'

/** A line comment waiting in a review, until the review is sent as one instruction. */
export type ReviewComment = { id: string; target: AskTarget; comment: string }

/** "12" or "12–15": the line or range a comment is on. */
export function reviewLineLabel(target: AskTarget): string {
  const first = target.lines?.[0]
  return first && first !== target.line ? `${lineLabel(first)}–${lineLabel(target.line)}` : String(lineLabel(target.line))
}

function quotedLines(target: AskTarget): string {
  return (target.lines ?? [target.line]).map((l) => l.text).join('\n')
}

function whereOf(target: AskTarget): string {
  const removed = target.line.kind === 'del'
  const label = reviewLineLabel(target)
  const lines = target.lines && target.lines.length > 1 ? `lines ${label}` : `line ${label}`
  return removed ? `${lines} as ${target.lines && target.lines.length > 1 ? 'they were' : 'it was'} before the change (removed)` : lines
}

/** One comment as the agent reads it: where, the code, then what was said. */
export function reviewCommentText(target: AskTarget, comment: string): string {
  return [`In \`${target.path}\`, ${whereOf(target)}:`, '```', quotedLines(target), '```', '', comment].join('\n')
}

/** A whole review as one instruction, comments in the order they were made, numbered. */
export function reviewInstruction(comments: readonly ReviewComment[]): string {
  if (comments.length === 1) return reviewCommentText(comments[0]!.target, comments[0]!.comment)
  const body = comments.map((c, i) => `### ${i + 1}. ${reviewCommentText(c.target, c.comment)}`).join('\n\n')
  return `Review comments on your changes — address each one:\n\n${body}`
}
