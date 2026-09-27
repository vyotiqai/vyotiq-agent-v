import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

type ParsedPattern = {
  negated: boolean
  dirOnly: boolean
  regex: RegExp
  raw: string
}

/**
 * `anchored` patterns match from the start of the path relative to their
 * `.gitignore`'s directory; the rest match at any depth. Git anchors a pattern
 * with a leading or interior slash — `/lib` is only the top-level `lib`, and
 * `docs/gen` only that path — where both used to match anywhere below.
 */
function patternToRegex(pattern: string, anchored: boolean): RegExp {
  let p = pattern.replace(/\\/g, '/')
  if (p.startsWith('/')) p = p.slice(1)
  const escaped = p
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '§§')
    .replace(/\*/g, '[^/]*')
    .replace(/§§/g, '.*')
  if (anchored) return new RegExp(`^${escaped}(?:/|$)`)
  return new RegExp(`(?:^|/)${escaped}(?:/|$)|^${escaped}$`)
}

function parseGitignoreLines(text: string): ParsedPattern[] {
  const out: ParsedPattern[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    let raw = trimmed
    let negated = false
    if (raw.startsWith('!')) {
      negated = true
      raw = raw.slice(1).trim()
    }
    if (!raw) continue
    const dirOnly = raw.endsWith('/')
    if (dirOnly) raw = raw.slice(0, -1)
    const rootOnly = raw.startsWith('/')
    if (rootOnly) raw = raw.slice(1)
    // A leading `**/` already means "at any depth".
    if (raw.startsWith('**/')) raw = raw.slice(3)
    const anchored = rootOnly || raw.includes('/')
    try {
      out.push({
        raw,
        negated,
        dirOnly,
        regex: patternToRegex(raw, anchored)
      })
    } catch {
      // skip invalid patterns
    }
  }
  return out
}

function matchesPattern(norm: string, isDirectory: boolean, pat: ParsedPattern): boolean {
  if (pat.dirOnly) {
    // A trailing slash means directories only. Anything *inside* a matched
    // directory is ignored whatever its own type, so test the ancestors
    // separately from the entry itself — testing the whole path at once also
    // matched a plain file sharing the directory's name (`build/` hid `build`).
    const slash = norm.lastIndexOf('/')
    if (slash > 0) {
      const parent = norm.slice(0, slash)
      if (pat.regex.test(`${parent}/`) || pat.regex.test(parent)) return true
    }
    if (!isDirectory) return false
    return norm === pat.raw || pat.regex.test(`${norm}/`)
  }
  // Testing the basename too is redundant: an unanchored regex starts with
  // `(?:^|/)`, so anything matching the trailing segment already matches the
  // full path at the preceding slash.
  return pat.regex.test(norm)
}

/** `base`: the `.gitignore`'s directory relative to the workspace root ('' = root). */
type RuleSet = { base: string; patterns: ParsedPattern[] }

function readRuleSet(dir: string, base: string): RuleSet | null {
  const path = join(dir, '.gitignore')
  if (!existsSync(path)) return null
  try {
    const patterns = parseGitignoreLines(readFileSync(path, 'utf8'))
    return patterns.length ? { base, patterns } : null
  } catch {
    return null
  }
}

export type GitignoreMatcher = {
  shouldIgnoreEntry: (entryName: string, isDirectory: boolean) => boolean
}

const EMPTY_MATCHER: GitignoreMatcher = {
  shouldIgnoreEntry: () => false
}

const matcherCache = new Map<string, GitignoreMatcher>()

/** True when a mutated workspace-relative path is a `.gitignore` file. */
export function isGitignoreRelPath(relPath: string): boolean {
  const n = relPath.replace(/\\/g, '/')
  return n === '.gitignore' || n.endsWith('/.gitignore')
}

/** Drop cached matchers after `.gitignore` (or tree) mutations so walks see fresh rules. */
export function clearGitignoreMatcherCache(workspaceRoot?: string): void {
  if (!workspaceRoot) {
    matcherCache.clear()
    return
  }
  const prefix = `${workspaceRoot}::`
  for (const key of matcherCache.keys()) {
    if (key.startsWith(prefix)) matcherCache.delete(key)
  }
}

/** Matcher for a directory path relative to workspace root (empty string = root). */
export function gitignoreMatcherForDir(
  workspaceRoot: string,
  relDir: string
): GitignoreMatcher {
  const key = `${workspaceRoot}::${relDir || '.'}`
  const cached = matcherCache.get(key)
  if (cached) return cached

  const ruleSets: RuleSet[] = []
  const parts = relDir ? relDir.replace(/\\/g, '/').split('/').filter(Boolean) : []
  for (let i = 0; i <= parts.length; i++) {
    const dir =
      i === 0 ? workspaceRoot : join(workspaceRoot, ...parts.slice(0, i))
    const rules = readRuleSet(dir, parts.slice(0, i).join('/'))
    if (rules) ruleSets.push(rules)
  }

  if (!ruleSets.length) {
    matcherCache.set(key, EMPTY_MATCHER)
    return EMPTY_MATCHER
  }

  const matcher: GitignoreMatcher = {
    shouldIgnoreEntry(entryName: string, isDirectory: boolean): boolean {
      const suffix = relDir ? `${relDir}/${entryName}`.replace(/\\/g, '/') : entryName
      // Last match wins (deepest .gitignore last, last line within it), so
      // scanning newest-first and stopping at the first hit yields the same
      // verdict without evaluating every remaining pattern.
      for (let i = ruleSets.length - 1; i >= 0; i--) {
        const { base, patterns } = ruleSets[i]!
        // Patterns are relative to their own .gitignore's directory.
        const rel = base ? suffix.slice(base.length + 1) : suffix
        for (let k = patterns.length - 1; k >= 0; k--) {
          const pat = patterns[k]!
          if (matchesPattern(rel, isDirectory, pat)) return !pat.negated
        }
      }
      return false
    }
  }
  matcherCache.set(key, matcher)
  return matcher
}
