import type { DiffLine } from '../toolUi'

/** Added and removed lines: what a cut diff's note counts, not the context around them. */
export function changedCount(lines: readonly DiffLine[]): number {
  let n = 0
  for (const line of lines) if (line.kind === 'add' || line.kind === 'del') n += 1
  return n
}

/**
 * What a cut leaves out, counted: "3 more changed lines" under a diff cut at
 * its foot, "1 earlier line" over output kept to its last lines.
 */
export function linesLeftOut(n: number, where: 'more' | 'earlier', kind?: 'changed'): string {
  return `${n} ${where}${kind ? ` ${kind}` : ''} ${n === 1 ? 'line' : 'lines'}`
}
