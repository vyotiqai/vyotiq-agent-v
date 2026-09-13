import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

type ParsedPattern = {
  negated: boolean
  dirOnly: boolean
  rootOnly: boolean
  regex: RegExp
  raw: string
}

function patternToRegex(pattern: string): RegExp {
  let p = pattern.replace(/\\/g, '/')
  if (p.startsWith('/')) p = p.slice(1)
  const escaped = p
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '§§')
    .replace(/\*/g, '[^/]*')
    .replace(/§§/g, '.*')
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
    try {
      out.push({
        raw,
        negated,
        dirOnly,
        rootOnly,
        regex: patternToRegex(raw)
      })
    } catch {
      // skip invalid patterns
    }
  }
  return out
}

function matchesPattern(norm: string, isDirectory: boolean, pat: ParsedPattern): boolean {
  if (pat.dirOnly) {
    if (norm === pat.raw || norm.startsWith(`${pat.raw}/`)) return true
    return pat.regex.test(`${norm}/`) || pat.regex.test(norm)
  }
  if (pat.rootOnly) {
    return pat.regex.test(norm)
  }
  const base = norm.split('/').pop() ?? norm
  return pat.regex.test(norm) || pat.regex.test(base)
}

type RuleSet = { patterns: ParsedPattern[] }

function readRuleSet(dir: string): RuleSet | null {
  const path = join(dir, '.gitignore')
  if (!existsSync(path)) return null
  try {
    const patterns = parseGitignoreLines(readFileSync(path, 'utf8'))
    return patterns.length ? { patterns } : null
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
    const rules = readRuleSet(dir)
    if (rules) ruleSets.push(rules)
  }

  if (!ruleSets.length) {
    matcherCache.set(key, EMPTY_MATCHER)
    return EMPTY_MATCHER
  }

  const matcher: GitignoreMatcher = {
    shouldIgnoreEntry(entryName: string, isDirectory: boolean): boolean {
      const suffix = relDir ? `${relDir}/${entryName}`.replace(/\\/g, '/') : entryName
      let ignored = false
      for (const { patterns } of ruleSets) {
        for (const pat of patterns) {
          if (matchesPattern(suffix, isDirectory, pat)) {
            ignored = !pat.negated
          }
        }
      }
      return ignored
    }
  }
  matcherCache.set(key, matcher)
  return matcher
}
