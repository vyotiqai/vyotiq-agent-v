import { resolveInsideWorkspace, assertResolvedInsideWorkspace } from '../../workspace/safePath'
import { mkdirSync, readFileSync, existsSync, statSync } from 'fs'
import { dirname } from 'path'
import { atomicWriteFile } from '@main/storage/atomicWrite'
import { withWorkspaceMutation } from '@main/workspace/mutationQueue'
import { assertWritablePath } from './writeGuard'

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

type HunkLine = { tag: ' ' | '-' | '+'; content: string }

type Hunk = {
  oldStart: number
  lines: HunkLine[]
  /** False for bare `@@` headers, which declare no line position. */
  declared: boolean
}

function parseHunks(diff: string): Hunk[] {
  const diffLines = normalizeNewlines(diff).split('\n')
  const hunks: Hunk[] = []
  let i = 0

  while (i < diffLines.length) {
    const header = diffLines[i]
    if (
      header.startsWith('diff ') ||
      header.startsWith('index ') ||
      header.startsWith('---') ||
      header.startsWith('+++') ||
      header.startsWith('new file') ||
      header.startsWith('deleted file')
    ) {
      i++
      continue
    }

    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header)
    // Bare `@@` (no -N,+M) — models emit this; search-based apply still works.
    const bareAt = !match && /^@@(?:\s.*)?$/.test(header)
    if (!match && !bareAt) {
      i++
      continue
    }

    const oldStart = match ? Math.max(0, Number(match[1]) - 1) : 0
    i++
    const lines: HunkLine[] = []

    while (i < diffLines.length && !diffLines[i].startsWith('@@')) {
      const line = diffLines[i]
      if (
        line.startsWith('diff ') ||
        line.startsWith('---') ||
        line.startsWith('+++') ||
        line.startsWith('index ')
      ) {
        break
      }
      if (line.startsWith('\\')) {
        i++
        continue
      }

      // A diff text ending in '\n' yields a final '' split element — the diff
      // terminator, not a blank context line. Treating it as context demanded a
      // phantom blank line after the hunk (the "Diff hunk failed to match ...
      // Expected: <line> \"\"" failure class). Real blank context lines arrive
      // as ' ' lines, which stay untouched.
      if (line === '' && i === diffLines.length - 1) {
        i++
        continue
      }

      const tag = line[0]
      if (tag === ' ' || tag === '-' || tag === '+') {
        lines.push({ tag, content: line.slice(1) })
      } else if (line === '') {
        lines.push({ tag: ' ', content: '' })
      } else {
        // Models sometimes omit the leading marker — treat as context.
        lines.push({ tag: ' ', content: line })
      }
      i++
    }

    hunks.push({ oldStart, lines, declared: Boolean(match) })
  }

  return hunks
}

function matchesAt(lines: string[], pos: number, expected: string[]): boolean {
  if (expected.length === 0) return pos >= 0 && pos <= lines.length
  if (pos < 0 || pos + expected.length > lines.length) return false
  for (let j = 0; j < expected.length; j++) {
    if (lines[pos + j] !== expected[j]) return false
  }
  return true
}

function findHunkStart(lines: string[], hunk: Hunk): number {
  const expected = hunk.lines
    .filter((l) => l.tag === ' ' || l.tag === '-')
    .map((l) => l.content)

  if (matchesAt(lines, hunk.oldStart, expected)) return hunk.oldStart

  // Prefer declared line ± small radius only (avoid silent wrong-block applies).
  const radius = 40
  const nearMatches: number[] = []
  for (let d = 1; d <= radius; d++) {
    if (matchesAt(lines, hunk.oldStart + d, expected)) nearMatches.push(hunk.oldStart + d)
    if (matchesAt(lines, hunk.oldStart - d, expected)) nearMatches.push(hunk.oldStart - d)
  }
  if (nearMatches.length === 1) return nearMatches[0]
  if (nearMatches.length > 1) {
    throw new Error(
      `Diff hunk near line ${hunk.oldStart + 1} matched ${nearMatches.length} locations; re-read the file and provide a more unique context`
    )
  }

  if (expected.length === 0) {
    return Math.min(Math.max(0, hunk.oldStart), lines.length)
  }

  const globalMatches: number[] = []
  for (let pos = 0; pos <= lines.length - expected.length; pos++) {
    if (matchesAt(lines, pos, expected)) globalMatches.push(pos)
  }
  if (globalMatches.length === 1) return globalMatches[0]
  if (globalMatches.length > 1) {
    throw new Error(
      `Diff hunk for line ${hunk.oldStart + 1} matched ${globalMatches.length} places in the file; add more unique context lines`
    )
  }

  const preview = expected
    .slice(0, 3)
    .map((l) => `  ${JSON.stringify(l.slice(0, 100))}`)
    .join('\n')
  // Name where the expected content actually lives — a bare `@@` hunk has no
  // declared position, and even a declared one can point far from the drift.
  const firstKnown = expected.findIndex((l) => l !== '' && lines.includes(l))
  const located =
    firstKnown >= 0
      ? `\nFirst expected line found at file line ${lines.indexOf(expected[firstKnown]) + 1}.`
      : '\nNone of the expected context/removal lines exist in the file — re-read it and regenerate the hunk from current bytes.'
  if (!hunk.declared) {
    throw new Error(
      `Diff hunk failed to match (context/removal mismatch); the bare @@ header declares no line.\nExpected:\n${preview}${located}`
    )
  }
  const around = lines
    .slice(Math.max(0, hunk.oldStart - 1), hunk.oldStart + 3)
    .map((l, i) => `  L${hunk.oldStart + i}: ${JSON.stringify(l.slice(0, 100))}`)
    .join('\n')
  throw new Error(
    `Diff hunk failed to match near line ${hunk.oldStart + 1} (context/removal mismatch).\nExpected:\n${preview}${located}\nAround declared line:\n${around || '  (eof)'}`
  )
}

/** True for the two context/removal mismatch failures — the only recoverable hunk class. */
function isHunkMismatchError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('(context/removal mismatch)')
}

/**
 * Bare-`@@` fallback (audit M11): anchor the hunk on its removal lines alone.
 * Models emit stale context lines around an otherwise valid edit; the removals
 * are the semantic core, so when they occur exactly once in the file the `-`/`+`
 * cluster is applied there and the stale context lines are neither trusted nor
 * re-emitted — the file's real lines flow through. Declined (caller rethrows the
 * original mismatch error) when there are no removals, removals are split across
 * clusters, or the removal block is absent or ambiguous.
 */
function applyHunkByRemovals(lines: string[], hunk: Hunk): string[] | undefined {
  const body = hunk.lines
  const firstRemoval = body.findIndex((l) => l.tag === '-')
  if (firstRemoval < 0) return undefined

  // One contiguous '-'/'+' cluster must hold every removal line.
  let first = firstRemoval
  while (first > 0 && body[first - 1].tag !== ' ') first--
  let last = firstRemoval
  while (last + 1 < body.length && body[last + 1].tag !== ' ') last++
  for (let i = last + 1; i < body.length; i++) {
    if (body[i].tag === '-') return undefined
  }

  const removals = body
    .slice(first, last + 1)
    .filter((l) => l.tag === '-')
    .map((l) => l.content)
  const hits: number[] = []
  for (let pos = 0; pos + removals.length <= lines.length; pos++) {
    if (matchesAt(lines, pos, removals)) hits.push(pos)
  }
  if (hits.length !== 1) return undefined

  const out = lines.slice(0, hits[0])
  let cursor = hits[0]
  for (const { tag, content } of body.slice(first, last + 1)) {
    if (tag === '-') cursor++
    else out.push(content)
  }
  return [...out, ...lines.slice(cursor)]
}

function applyHunk(lines: string[], hunk: Hunk): string[] {
  let start: number
  try {
    start = findHunkStart(lines, hunk)
  } catch (err) {
    // Bare-@@ hunks carry no line anchor (audit M11) — try locating the
    // removal lines before surfacing the mismatch.
    if (hunk.declared || !isHunkMismatchError(err)) throw err
    const recovered = applyHunkByRemovals(lines, hunk)
    if (recovered) return recovered
    throw err
  }
  const before = lines.slice(0, start)
  const out: string[] = []
  let cursor = start

  for (const { tag, content } of hunk.lines) {
    if (tag === ' ') {
      out.push(content)
      cursor++
    } else if (tag === '-') {
      cursor++
    } else {
      out.push(content)
    }
  }

  return [...before, ...out, ...lines.slice(cursor)]
}

/** Apply unified diff hunks; validates context and tolerates nearby drift. */
export function applyUnifiedDiff(original: string, diff: string): string {
  const hunks = parseHunks(diff)
  if (hunks.length === 0) {
    throw new Error('No unified-diff hunks found (need @@ headers)')
  }

  // Rejoin with the file's dominant EOL: normalizeNewlines is for matching
  // only — writing back LF would flip CRLF files on Windows.
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  let lines = normalizeNewlines(original).split('\n')
  // Apply bottom-up so earlier original line numbers stay valid.
  for (const hunk of [...hunks].reverse()) {
    lines = applyHunk(lines, hunk)
  }
  return lines.join(eol)
}

export function toolEdit(
  workspaceRoot: string,
  pathArg: string,
  contents?: string,
  diff?: string
): string {
  const path = (pathArg ?? '').trim()
  if (!path) throw new Error('edit requires a non-empty path')
  const resolved = resolveInsideWorkspace(workspaceRoot, path)
  assertResolvedInsideWorkspace(workspaceRoot, dirname(resolved))
  mkdirSync(dirname(resolved), { recursive: true })
  assertResolvedInsideWorkspace(workspaceRoot, resolved)

  const existed = existsSync(resolved)

  if (typeof contents === 'string') {
    if (existed && contents.length === 0 && statSync(resolved).size > 0) {
      throw new Error(
        `edit refuses to replace non-empty ${path} with empty contents; use diff to remove contents explicitly`
      )
    }
    assertWritablePath(path)
    atomicWriteFile(resolved, contents)
    return existed
      ? `Wrote ${path} (${contents.length} chars)`
      : `Created ${path} (${contents.length} chars)`
  }

  if (typeof diff === 'string' && diff.trim()) {
    const original = existed ? readFileSync(resolved, 'utf8') : ''
    let next: string
    try {
      next = applyUnifiedDiff(original, diff)
    } catch (err) {
      // One-shot re-read + retry (audit M11): the file may have changed on disk
      // since the read above. Never retried further — the original mismatch
      // error surfaces if the re-read bytes still do not match.
      if (!existed || !isHunkMismatchError(err)) throw err
      const fresh = readFileSync(resolved, 'utf8')
      if (fresh === original) throw err
      try {
        next = applyUnifiedDiff(fresh, diff)
      } catch {
        throw err
      }
    }
    assertWritablePath(path)
    atomicWriteFile(resolved, next)
    return existed ? `Applied diff to ${path}` : `Created ${path}`
  }

  throw new Error('edit requires contents or diff')
}

export async function toolEditAsync(
  workspaceRoot: string,
  pathArg: string,
  contents?: string,
  diff?: string
): Promise<string> {
  const path = (pathArg ?? '').trim()
  if (!path) throw new Error('edit requires a non-empty path')
  return withWorkspaceMutation(workspaceRoot, path, () =>
    toolEdit(workspaceRoot, path, contents, diff)
  )
}
