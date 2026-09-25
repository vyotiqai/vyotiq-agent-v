/**
 * Exact added/removed line counts between two texts — the "+52 −4" beside a
 * task that is waiting for review.
 *
 * Myers' O(ND) shortest edit script, counting only. Common leading and
 * trailing lines are stripped first, which makes the usual agent edit (a few
 * hunks in a large file) cost next to nothing. When the edit distance passes
 * `maxEdits` the answer is `null`, not a guess: callers show no numbers rather
 * than numbers that are wrong.
 */
export type LineDiffStat = { add: number; del: number }

export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split(/\r\n|\r|\n/)
  // A trailing newline ends the last line; it does not start an empty one.
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

export function lineDiffStat(
  before: string,
  after: string,
  { maxEdits = 4000 }: { maxEdits?: number } = {}
): LineDiffStat | null {
  const a = splitLines(before)
  const b = splitLines(after)

  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }

  const n = endA - start
  const m = endB - start
  if (n === 0) return { add: m, del: 0 }
  if (m === 0) return { add: 0, del: n }

  const max = Math.min(n + m, maxEdits)
  const offset = max + 1
  // v[k + offset] = furthest x reached on diagonal k.
  const v = new Int32Array(2 * max + 3)
  for (let d = 0; d <= max; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])
          ? v[k + 1 + offset]
          : v[k - 1 + offset] + 1
      let y = x - k
      while (x < n && y < m && a[start + x] === b[start + y]) {
        x += 1
        y += 1
      }
      v[k + offset] = x
      if (x >= n && y >= m) {
        // d edits in total; on diagonal k = n − m the split is fixed.
        const del = (d + (n - m)) / 2
        const add = d - del
        return { add, del }
      }
    }
  }
  return null
}
