import type { WorkspaceFileReadResult } from '@shared/ipc'

/** How the find-in-files query matches. */
export type FindOptions = {
  query: string
  /** Treat the query as a JavaScript regular expression. */
  regex: boolean
  matchCase: boolean
  wholeWord: boolean
}

export type TextEdit = { from: number; to: number; insert: string }

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The regex source for a query: escaped unless it is a regex, wrapped in word
 * boundaries for whole words. The same source goes to the workspace grep (which
 * reads every query as a case-insensitive regex) and to the planner, so the
 * files grep finds are a superset of the files the planner edits.
 */
export function findPatternSource(options: FindOptions): string {
  const body = options.regex ? options.query : escapeRegExp(options.query)
  return options.wholeWord ? `\\b(?:${body})\\b` : body
}

/** The compiled query, or the reason it does not compile. */
export function compileFind(
  options: FindOptions
): { ok: true; regex: RegExp } | { ok: false; error: string } {
  if (!options.query) return { ok: false, error: 'Type something to find.' }
  try {
    // `m` so ^/$ are per line, as the grep reads them.
    const regex = new RegExp(findPatternSource(options), options.matchCase ? 'gm' : 'gim')
    return { ok: true, regex }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Invalid regular expression' }
  }
}

/** True when a line (a grep hit's text) matches — to drop the grep's case-insensitive extras. */
export function lineMatches(regex: RegExp, line: string): boolean {
  regex.lastIndex = 0
  const found = regex.test(line)
  regex.lastIndex = 0
  return found
}

/**
 * Expand `$&`, `$1`…`$99`, `$<name>` and `$$` in a regex replacement, the way
 * `String.prototype.replace` does. A literal query inserts the text as typed.
 */
export function expandReplacement(template: string, match: RegExpExecArray): string {
  return template.replace(/\$(\$|&|`|'|\d{1,2}|<([^>]*)>)/g, (whole: string, token: string, name?: string) => {
    if (token === '$') return '$'
    if (token === '&') return match[0]
    if (token === '`') return match.input.slice(0, match.index)
    if (token === "'") return match.input.slice(match.index + match[0].length)
    if (name !== undefined) return match.groups?.[name] ?? ''
    const index = Number(token)
    if (index >= 1 && index < match.length) return match[index] ?? ''
    // `$12` with one group reads as `$1` then "2", as replace() does.
    if (token.length === 2) {
      const first = Number(token[0])
      if (first >= 1 && first < match.length) return `${match[first] ?? ''}${token[1]}`
    }
    return whole
  })
}

/**
 * Every match of `options` in `text` as an edit to `replacement`, in order
 * and non-overlapping, plus the text with all of them applied.
 */
export function planReplaceInText(
  text: string,
  options: FindOptions,
  replacement: string
): { edits: TextEdit[]; next: string } {
  const compiled = compileFind(options)
  if (!compiled.ok) return { edits: [], next: text }
  const { regex } = compiled
  const edits: TextEdit[] = []
  regex.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    const from = match.index
    const to = from + match[0].length
    edits.push({ from, to, insert: options.regex ? expandReplacement(replacement, match) : replacement })
    // A zero-length match (`^`, `\b`) must still move on.
    if (to === from) regex.lastIndex = from + 1
  }
  if (edits.length === 0) return { edits, next: text }
  let next = ''
  let at = 0
  for (const edit of edits) {
    next += text.slice(at, edit.from) + edit.insert
    at = edit.to
  }
  next += text.slice(at)
  return { edits, next }
}

/** One file's share of a replace-all: what it reads now and what it will read. */
export type ReplaceFilePlan = {
  path: string
  count: number
  next: string
  read: WorkspaceFileReadResult
}

/** Files left out of a replace-all, and why — said in the confirm and the result. */
export type ReplaceSkip = { path: string; reason: 'unsaved' | 'binary' | 'truncated' | 'unreadable' }

export type ReplacePlan = {
  files: ReplaceFilePlan[]
  skipped: ReplaceSkip[]
  matches: number
}

/**
 * Read each candidate file and plan its replacements. Files with unsaved edits
 * in an open tab are refused rather than merged: the person's buffer and the
 * disk disagree, and either choice would silently drop one of them. Binary and
 * truncated reads are refused too — writing them back would corrupt the file.
 */
export async function planReplaceAll({
  paths,
  options,
  replacement,
  hasUnsavedEdits,
  readFile
}: {
  paths: readonly string[]
  options: FindOptions
  replacement: string
  hasUnsavedEdits: (path: string) => boolean
  readFile: (path: string) => Promise<WorkspaceFileReadResult | null>
}): Promise<ReplacePlan> {
  const files: ReplaceFilePlan[] = []
  const skipped: ReplaceSkip[] = []
  let matches = 0
  for (const path of paths) {
    if (hasUnsavedEdits(path)) {
      skipped.push({ path, reason: 'unsaved' })
      continue
    }
    const read = await readFile(path)
    if (!read) {
      skipped.push({ path, reason: 'unreadable' })
      continue
    }
    if (read.kind !== 'text') {
      skipped.push({ path, reason: 'binary' })
      continue
    }
    if (read.truncated) {
      skipped.push({ path, reason: 'truncated' })
      continue
    }
    const { edits, next } = planReplaceInText(read.content, options, replacement)
    if (edits.length === 0 || next === read.content) continue
    files.push({ path, count: edits.length, next, read })
    matches += edits.length
  }
  return { files, skipped, matches }
}

/** Grep hits name a file once per matching line; the planner wants each file once, in order. */
export function uniquePaths(hits: ReadonlyArray<{ path: string }>): string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  for (const hit of hits) {
    if (seen.has(hit.path)) continue
    seen.add(hit.path)
    paths.push(hit.path)
  }
  return paths
}

/** "3 matches in 2 files". */
export function describeReplaceCount(matches: number, files: number): string {
  return `${matches} match${matches === 1 ? '' : 'es'} in ${files} file${files === 1 ? '' : 's'}`
}
