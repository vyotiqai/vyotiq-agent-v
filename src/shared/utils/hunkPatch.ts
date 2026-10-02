import type { DiffHunk, DiffHunkLine } from './unifiedDiff'

/**
 * One hunk of a file's diff, taken back or put again on its own: the per-hunk
 * Undo in the task's Changes.
 *
 * A hunk is named by where it sits and what it says — old and new start and
 * length plus a hash of its lines — never by its index alone, so a diff that
 * moved under the reviewer cannot hand an Undo the wrong hunk. The whole diff
 * text is fingerprinted the same way: main refuses when the diff it computes
 * now is not the one that was on screen.
 *
 * Applying works line by line on the file as it is, keeping each kept line's
 * own line ending (CRLF, LF or CR), giving new lines the file's usual one, and
 * leaving the file's last line ending — newline or none — as it was.
 */

export type HunkIdentity = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** {@link textHash} of the hunk's lines, sign and text. */
  hash: string
}

/**
 * Lines to find and change, from `start` (0-based) in the target: ` ` must be
 * there and stays, `-` must be there and goes, `+` is put in.
 */
export type HunkPatch = { start: number; lines: DiffHunkLine[] }

export type HunkApplyResult = { ok: true; text: string; at: number } | { ok: false }

/** cyrb53: a quick 53-bit hash, enough to tell one text from another. Not for security. */
export function textHash(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

type HunkShape = Pick<DiffHunk, 'oldStart' | 'oldLines' | 'newStart' | 'newLines' | 'lines'>

export function hunkIdentity(hunk: HunkShape): HunkIdentity {
  return {
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    hash: textHash(hunk.lines.map((line) => `${line.kind}${line.text}`).join('\n'))
  }
}

export function sameHunk(a: HunkIdentity, b: HunkIdentity): boolean {
  return (
    a.oldStart === b.oldStart &&
    a.oldLines === b.oldLines &&
    a.newStart === b.newStart &&
    a.newLines === b.newLines &&
    a.hash === b.hash
  )
}

/** The fingerprint of a whole diff's text, as shown. Line endings in the text itself do not count. */
export function diffFingerprint(diffText: string): string {
  return textHash(diffText.replace(/\r\n/g, '\n'))
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/

/** The hunks of one file's `git diff` text, in order. Headers before the first hunk are skipped. */
export function parseUnifiedHunks(diffText: string): DiffHunk[] {
  const hunks: DiffHunk[] = []
  let current: DiffHunk | null = null
  for (const raw of diffText.split(/\r?\n/)) {
    const header = HUNK_HEADER_RE.exec(raw)
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        context: header[5] ?? '',
        lines: []
      }
      hunks.push(current)
      continue
    }
    if (!current) continue
    const sign = raw[0]
    if (sign === ' ' || sign === '-' || sign === '+') current.lines.push({ kind: sign, text: raw.slice(1) })
  }
  return hunks
}

/** An empty side names the line it follows (0 before the first); otherwise its first line. */
function startIndex(start: number, count: number): number {
  return count === 0 ? start : start - 1
}

const SWAP: Record<DiffHunkLine['kind'], DiffHunkLine['kind']> = { ' ': ' ', '-': '+', '+': '-' }

/** Takes the hunk back out of the new file: its added lines go, its removed lines return. */
export function reverseHunk(hunk: HunkShape): HunkPatch {
  return {
    start: startIndex(hunk.newStart, hunk.newLines),
    lines: hunk.lines.map((line) => ({ kind: SWAP[line.kind], text: line.text }))
  }
}

/** The hunk as written: applied to the old file, it gives the new one. */
export function forwardHunk(hunk: HunkShape): HunkPatch {
  return { start: startIndex(hunk.oldStart, hunk.oldLines), lines: hunk.lines.map((line) => ({ ...line })) }
}

/** The patch that undoes `patch` once it has been applied at `at`. */
export function invertPatch(patch: HunkPatch, at: number): HunkPatch {
  return { start: at, lines: patch.lines.map((line) => ({ kind: SWAP[line.kind], text: line.text })) }
}

/** Lines and the ending each one had, split as {@link splitLines} splits them. */
function splitWithEndings(text: string): { lines: string[]; endings: string[] } {
  const lines: string[] = []
  const endings: string[] = []
  const re = /\r\n|\r|\n/g
  let last = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    lines.push(text.slice(last, m.index))
    endings.push(m[0])
    last = m.index + m[0].length
  }
  if (last < text.length) {
    lines.push(text.slice(last))
    endings.push('')
  }
  return { lines, endings }
}

/** The ending most of the file's lines use, or `fallback` when none has one. */
function usualEnding(endings: readonly string[], fallback: string): string {
  const counts = new Map<string, number>()
  for (const e of endings) if (e) counts.set(e, (counts.get(e) ?? 0) + 1)
  let best = fallback
  let most = 0
  for (const [e, n] of counts) {
    if (n > most) {
      best = e
      most = n
    }
  }
  return best
}

function matchesAt(lines: readonly string[], expected: readonly string[], at: number): boolean {
  if (at < 0 || at + expected.length > lines.length) return false
  for (let i = 0; i < expected.length; i += 1) if (lines[at + i] !== expected[i]) return false
  return true
}

/**
 * Apply one hunk patch to `text`. It must match exactly at `patch.start`, or —
 * with `maxOffset` — at the nearest line within that many of it, as `patch`
 * finds a hunk that moved. A patch with nothing to match (no context, nothing
 * removed) only goes where it says.
 *
 * `eol` is the line ending for new lines when the file has none to copy (an
 * empty or one-line file); `finalEol` the ending of the last line when the
 * file was empty before.
 */
export function applyHunkPatch(
  text: string,
  patch: HunkPatch,
  { maxOffset = 0, eol = '\n', finalEol }: { maxOffset?: number; eol?: string; finalEol?: string } = {}
): HunkApplyResult {
  const { lines, endings } = splitWithEndings(text)
  const expected = patch.lines.filter((line) => line.kind !== '+').map((line) => line.text)

  let at = -1
  if (expected.length === 0) {
    if (patch.start >= 0 && patch.start <= lines.length) at = patch.start
  } else {
    for (let d = 0; d <= maxOffset && at < 0; d += 1) {
      if (matchesAt(lines, expected, patch.start + d)) at = patch.start + d
      else if (d > 0 && matchesAt(lines, expected, patch.start - d)) at = patch.start - d
      if (patch.start + d >= lines.length && patch.start - d < 0) break
    }
  }
  if (at < 0) return { ok: false }

  const nl = usualEnding(endings, eol)
  const outLines = lines.slice(0, at)
  const outEndings = endings.slice(0, at)
  let q = at
  for (const line of patch.lines) {
    if (line.kind === ' ') {
      outLines.push(lines[q]!)
      outEndings.push(endings[q]!)
      q += 1
    } else if (line.kind === '-') {
      q += 1
    } else {
      outLines.push(line.text)
      outEndings.push(nl)
    }
  }
  const reachedEnd = q === lines.length
  outLines.push(...lines.slice(q))
  outEndings.push(...endings.slice(q))

  const n = outLines.length
  // Every line but the last ends in a newline; the last keeps the file's own.
  for (let i = 0; i < n - 1; i += 1) if (!outEndings[i]) outEndings[i] = nl
  if (n > 0 && reachedEnd) {
    outEndings[n - 1] = lines.length > 0 ? endings[lines.length - 1]! : (finalEol ?? nl)
  }
  let out = ''
  for (let i = 0; i < n; i += 1) out += outLines[i]! + outEndings[i]!
  return { ok: true, text: out, at }
}
