import { splitLines } from './lineDiffStat'

/**
 * A line diff two texts can be reviewed from: hunks with real old and new line
 * numbers and git's function-name context, the shape `git diff` prints.
 *
 * Myers' shortest edit script, so the counts agree with {@link lineDiffStat}
 * for the same texts. Common leading and trailing lines are stripped before the
 * search, which keeps the usual agent edit (a few hunks in a large file) cheap.
 * Past `maxEdits` the script is not searched for: the change is returned as a
 * full replacement (`full: true`), which is a correct diff but not the smallest
 * one, so its counts are not the line counts a reviewer would expect.
 */
export type DiffHunkLine = { kind: ' ' | '-' | '+'; text: string }

export type DiffHunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** The nearest line above the hunk that starts a definition, as git finds it. */
  context: string
  lines: DiffHunkLine[]
}

export type LineDiff = {
  hunks: DiffHunk[]
  add: number
  del: number
  /** True when the texts were too far apart to search: one delete-all, add-all hunk. */
  full: boolean
}

type Op = 0 | 1 | 2 // equal, delete (from before), insert (from after)

const EQUAL: Op = 0
const DELETE: Op = 1
const INSERT: Op = 2

/** Git's default `xfuncname`: a line that starts with a letter, `_` or `$`. */
const FUNCNAME_RE = /^[A-Za-z_$]/
/** Git keeps at most this much of the function line in a hunk header. */
const FUNCNAME_MAX = 80

/**
 * The edit script between `a[start..endA)` and `b[start..endB)`, or null past
 * `maxEdits`. Keeps each step's frontier so the path can be walked back.
 */
function editScript(a: string[], b: string[], maxEdits: number): Op[] | null {
  const n = a.length
  const m = b.length
  if (n === 0) return new Array<Op>(m).fill(INSERT)
  if (m === 0) return new Array<Op>(n).fill(DELETE)

  const max = Math.min(n + m, maxEdits)
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  // trace[d] = the frontier before step d, for diagonals −d−1 … d+1.
  const trace: Int32Array[] = []
  let found = -1
  outer: for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[k - 1 + offset]! < v[k + 1 + offset]!)
          ? v[k + 1 + offset]!
          : v[k - 1 + offset]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x += 1
        y += 1
      }
      v[k + offset] = x
      if (x >= n && y >= m) {
        found = d
        break outer
      }
    }
  }
  if (found < 0) return null

  const ops: Op[] = []
  let x = n
  let y = m
  for (let d = found; d > 0; d -= 1) {
    const frame = trace[d]!
    const at = (k: number): number => frame[k + d + 1]!
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push(EQUAL)
      x -= 1
      y -= 1
    }
    ops.push(x === prevX ? INSERT : DELETE)
    x = prevX
    y = prevY
  }
  // Step 0 is the snake from the origin.
  while (x > 0 && y > 0) {
    ops.push(EQUAL)
    x -= 1
    y -= 1
  }
  ops.reverse()
  return ops
}

/**
 * Slides each run of only-deletes or only-inserts as far down as its lines
 * allow, as git does before printing: an added function then reads as
 * `+function b() {` … `+}` rather than starting on the previous one's `}`.
 */
function slideDown(ops: Op[], a: string[], b: string[]): void {
  let ai = 0
  let bi = 0
  let i = 0
  while (i < ops.length) {
    const op = ops[i]!
    if (op === EQUAL) {
      ai += 1
      bi += 1
      i += 1
      continue
    }
    let j = i
    while (j < ops.length && ops[j] === op) j += 1
    const k = j - i
    const pure = j >= ops.length || ops[j] === EQUAL
    if (pure && (i === 0 || ops[i - 1] === EQUAL)) {
      const lines = op === DELETE ? a : b
      let start = op === DELETE ? ai : bi
      // The group [start, start + k) moves down one line while its first line
      // equals the unchanged line right after it.
      while (j < ops.length && ops[j] === EQUAL && lines[start] === lines[start + k]) {
        ops[i] = EQUAL
        ops[j] = op
        i += 1
        j += 1
        start += 1
        ai += 1
        bi += 1
      }
    }
    if (op === DELETE) ai += k
    else bi += k
    i = j
  }
}

function funcnameAbove(lines: string[], index: number): string {
  for (let i = index - 1; i >= 0; i -= 1) {
    const line = lines[i]!
    if (FUNCNAME_RE.test(line)) return line.trimEnd().slice(0, FUNCNAME_MAX)
  }
  return ''
}

export function lineDiff(
  before: string,
  after: string,
  { context = 3, maxEdits = 1500 }: { context?: number; maxEdits?: number } = {}
): LineDiff {
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

  const middle = editScript(a.slice(start, endA), b.slice(start, endB), maxEdits)
  const full = middle === null
  const ops: Op[] = [
    ...new Array<Op>(start).fill(EQUAL),
    ...(middle ?? [...new Array<Op>(endA - start).fill(DELETE), ...new Array<Op>(endB - start).fill(INSERT)]),
    ...new Array<Op>(a.length - endA).fill(EQUAL)
  ]
  slideDown(ops, a, b)

  // Positions in a and b before each op.
  const aAt = new Int32Array(ops.length + 1)
  const bAt = new Int32Array(ops.length + 1)
  for (let i = 0; i < ops.length; i += 1) {
    aAt[i + 1] = aAt[i]! + (ops[i] === INSERT ? 0 : 1)
    bAt[i + 1] = bAt[i]! + (ops[i] === DELETE ? 0 : 1)
  }

  const changed: number[] = []
  ops.forEach((op, i) => {
    if (op !== EQUAL) changed.push(i)
  })

  const hunks: DiffHunk[] = []
  let add = 0
  let del = 0
  let i = 0
  while (i < changed.length) {
    let last = changed[i]!
    let j = i + 1
    // Changes closer than two contexts apart share a hunk, as in git.
    while (j < changed.length && changed[j]! - last <= 2 * context + 1) {
      last = changed[j]!
      j += 1
    }
    const from = Math.max(0, changed[i]! - context)
    const to = Math.min(ops.length, last + context + 1)
    const lines: DiffHunkLine[] = []
    for (let p = from; p < to; p += 1) {
      const op = ops[p]!
      if (op === EQUAL) lines.push({ kind: ' ', text: a[aAt[p]!]! })
      else if (op === DELETE) {
        lines.push({ kind: '-', text: a[aAt[p]!]! })
        del += 1
      } else {
        lines.push({ kind: '+', text: b[bAt[p]!]! })
        add += 1
      }
    }
    const oldLines = aAt[to]! - aAt[from]!
    const newLines = bAt[to]! - bAt[from]!
    hunks.push({
      // An empty side names the line it follows, as git does (0 before the first).
      oldStart: oldLines === 0 ? aAt[from]! : aAt[from]! + 1,
      oldLines,
      newStart: newLines === 0 ? bAt[from]! : bAt[from]! + 1,
      newLines,
      context: funcnameAbove(a, aAt[from]!),
      lines
    })
    i = j
  }

  return { hunks, add, del, full }
}

function range(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`
}

/** The diff as `git diff` prints it for one file, headers included. */
export function formatUnifiedDiff(path: string, diff: LineDiff, action?: 'created' | 'modified' | 'deleted'): string {
  const out = [
    action === 'created' ? '--- /dev/null' : `--- a/${path}`,
    action === 'deleted' ? '+++ /dev/null' : `+++ b/${path}`
  ]
  for (const hunk of diff.hunks) {
    const header = `@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@`
    out.push(hunk.context ? `${header} ${hunk.context}` : header)
    for (const line of hunk.lines) out.push(`${line.kind}${line.text}`)
  }
  return `${out.join('\n')}\n`
}
