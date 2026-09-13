import { existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname } from 'path'
import { resolveInsideWorkspace, assertResolvedInsideWorkspace } from '../../workspace/safePath'
import { atomicWriteFile } from '@main/storage/atomicWrite'
import { withWorkspaceMutation } from '@main/workspace/mutationQueue'
import { assertWritablePath } from './writeGuard'

/** Count non-overlapping occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let from = 0
  while (from <= haystack.length - needle.length) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) break
    count += 1
    from = at + needle.length
  }
  return count
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function sharedPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i
}

/** Best-effort line hint when old_string is missing (first non-empty needle line). */
function closestLineHint(normalizedFile: string, oldString: string): string {
  const needleLine = normalizeNewlines(oldString).split('\n').find((l) => l.trim().length > 0)
  if (!needleLine || needleLine.length < 4) {
    return 'Re-read the file with read (startLine/endLine) and retry with an exact snippet.'
  }
  const lines = normalizedFile.split('\n')
  const sample = needleLine.slice(0, Math.min(80, needleLine.length))
  const sampleTrim = sample.trim()
  let bestI = -1
  let bestScore = 0
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim()
    // Empty/`{`/`}` lines made `sample.includes("")` always true (75135925 line 8: "").
    if (trimmed.length < 8) continue
    let score = 0
    if (lines[i]!.includes(sample)) score = sample.length
    else if (sample.includes(trimmed)) score = trimmed.length
    else score = sharedPrefixLength(trimmed, sampleTrim)
    if (score > bestScore) {
      bestScore = score
      bestI = i
    }
  }
  if (bestI < 0 || bestScore < 8) {
    return 'Re-read the file with read (startLine/endLine) and retry with an exact snippet (match indentation and newlines).'
  }
  return `Closest match near line ${bestI + 1}: ${JSON.stringify(lines[bestI]!.slice(0, 120))}. Re-read with startLine/endLine and retry.`
}

/**
 * Replace exact text in a workspace file.
 * Fails when old_string is missing, or (unless replace_all) matches more than once.
 * Newlines are normalized (CRLF/LF) before matching so cross-platform reads succeed.
 */
export function toolStrReplace(
  workspaceRoot: string,
  pathArg: string,
  oldString: string,
  newString: string,
  replaceAll = false
): string {
  const path = (pathArg ?? '').trim()
  if (!path) throw new Error('str_replace requires a non-empty path')
  if (!oldString) throw new Error('str_replace requires a non-empty old_string')

  const resolved = resolveInsideWorkspace(workspaceRoot, path)
  if (!existsSync(resolved)) {
    throw new Error(`File not found: ${path}`)
  }

  const original = readFileSync(resolved, 'utf8')
  const useCrlf = original.includes('\r\n')
  const normalizedOriginal = normalizeNewlines(original)
  const normalizedOld = normalizeNewlines(oldString)
  const normalizedNew = normalizeNewlines(newString)

  const matches = countOccurrences(normalizedOriginal, normalizedOld)
  if (matches === 0) {
    throw new Error(
      `old_string not found in ${path}. ${closestLineHint(normalizedOriginal, normalizedOld)}`
    )
  }
  if (!replaceAll && matches > 1) {
    throw new Error(
      `old_string matched ${matches} times in ${path}; pass replace_all=true or provide a more unique old_string`
    )
  }

  const nextNormalized = replaceAll
    ? normalizedOriginal.split(normalizedOld).join(normalizedNew)
    : normalizedOriginal.replace(normalizedOld, normalizedNew)

  if (nextNormalized === normalizedOriginal) {
    throw new Error(`str_replace left ${path} unchanged`)
  }

  const next = useCrlf ? nextNormalized.replace(/\n/g, '\r\n') : nextNormalized
  assertWritablePath(path)
  assertResolvedInsideWorkspace(workspaceRoot, dirname(resolved))
  mkdirSync(dirname(resolved), { recursive: true })
  assertResolvedInsideWorkspace(workspaceRoot, resolved)
  atomicWriteFile(resolved, next)
  const label = replaceAll && matches > 1 ? `${matches} occurrences` : '1 occurrence'
  return `Replaced ${label} in ${path}`
}

export async function toolStrReplaceAsync(
  workspaceRoot: string,
  pathArg: string,
  oldString: string,
  newString: string,
  replaceAll = false
): Promise<string> {
  const path = (pathArg ?? '').trim()
  if (!path) throw new Error('str_replace requires a non-empty path')
  return withWorkspaceMutation(workspaceRoot, path, () =>
    toolStrReplace(workspaceRoot, path, oldString, newString, replaceAll)
  )
}
