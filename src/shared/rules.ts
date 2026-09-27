/**
 * One frontmatter parser and one root-instruction-file list, shared by every
 * surface that asks "will this rule be injected?".
 *
 * These used to be hand-synced copies (agent context, composer mentions, the
 * rule editor, and workspace slash commands), each with its own `---` split,
 * key regex and quote strip. The decision drifted between the agent and the UI
 * whenever one copy was edited. Parsing lives here; *policy* stays with each
 * caller, because they genuinely differ: the editor wants raw values it can
 * round-trip, the agent wants the inject decision.
 *
 * Shared by main and renderer, so this must stay free of node imports.
 */

/**
 * Project instruction files, read in precedence order. A workspace that ships
 * conventions in AGENTS.md expects the agent to follow them without being told
 * in every prompt, so they belong in the system prompt rather than the history.
 */
export const ROOT_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', '.cursorrules'] as const

const ROOT_INSTRUCTION_NAMES = new Set<string>(
  ROOT_INSTRUCTION_FILES.map((name) => name.toLowerCase())
)

/** True for a bare file name (no directory part) that is a root instruction file. */
export function isRootInstructionFileName(name: string): boolean {
  return ROOT_INSTRUCTION_NAMES.has(name.toLowerCase())
}

/**
 * True when `rel` names a root instruction file *at the workspace root*.
 * Only root-level copies are read into the prompt, so `packages/app/AGENTS.md`
 * is an ordinary file here.
 */
export function isRootInstructionFilePath(rel: string): boolean {
  const norm = rel.replace(/\\/g, '/').replace(/^\.\//, '')
  if (norm.includes('/')) return false
  return isRootInstructionFileName(norm)
}

export type FrontmatterSplit = {
  /** Raw text between the fences, or null when the file has no frontmatter. */
  block: string | null
  /**
   * `block` as verbatim lines (no wrapping `---`), or null when absent; an
   * empty frontmatter block gives `[]`. Lines keep their original indentation
   * so an editor can write unrecognized keys back untouched.
   */
  lines: string[] | null
  /** Text after the closing fence, with one leading newline removed. Not trimmed. */
  body: string
}

/**
 * Split leading `---` frontmatter off a markdown file.
 *
 * Deliberately not a YAML parser: an unterminated fence is treated as body
 * rather than an error, because these files are workspace-authored and a
 * half-written rule should still inject its prose.
 */
export function splitFrontmatter(raw: string): FrontmatterSplit {
  const text = raw.replace(/^\uFEFF/, '')
  if (!text.startsWith('---')) return { block: null, lines: null, body: text }
  const end = text.indexOf('\n---', 3)
  if (end < 0) return { block: null, lines: null, body: text }
  const block = text.slice(3, end)
  const inner = block.replace(/^\r?\n/, '').replace(/\r?\n$/, '')
  return {
    block,
    lines: inner.length > 0 ? inner.split(/\r?\n/) : [],
    body: text.slice(end + 4).replace(/^\r?\n/, '')
  }
}

/** Body with frontmatter removed, trimmed — for surfaces that inject prose only. */
export function frontmatterBody(raw: string): string {
  return splitFrontmatter(raw).body.trim()
}

const KEY_LINE = /^([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/

/**
 * Match one `key: value` frontmatter line, with the value trimmed.
 *
 * Anchored with no leading-whitespace tolerance on purpose: an indented line
 * belongs to the block above it, and treating it as top-level would let the
 * rule editor flatten nested keys on save. Trailing whitespace *is* tolerated,
 * because `.` does not match a CR — without that, the last key in a
 * CRLF-authored rule read as absent on the surfaces that scan lines verbatim.
 */
export function matchFrontmatterKey(line: string): { key: string; value: string } | null {
  const m = KEY_LINE.exec(line)
  if (!m) return null
  return { key: m[1]!, value: m[2]!.trim() }
}

export function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, '')
}

export type RuleFrontmatter = {
  alwaysApply?: boolean
  globs?: string[]
  description?: string
}

/**
 * Parse Cursor-style YAML frontmatter from a rule file.
 * Supports `alwaysApply`, `globs` (comma or YAML-list style), and `description`.
 */
export function parseRuleFrontmatter(raw: string): {
  meta: RuleFrontmatter
  body: string
} {
  const split = splitFrontmatter(raw)
  const meta: RuleFrontmatter = {}
  if (split.lines === null) return { meta, body: split.body.trim() }
  for (const line of split.lines) {
    const entry = matchFrontmatterKey(line)
    if (!entry) continue
    const { key, value } = entry
    if (key === 'alwaysApply') {
      // Empty / missing value ⇒ leave unset (auto-inject). Only explicit false skips.
      if (!value) {
        /* absent */
      } else if (/^(true|yes|1)$/i.test(value)) {
        meta.alwaysApply = true
      } else if (/^(false|no|0)$/i.test(value)) {
        meta.alwaysApply = false
      }
    } else if (key === 'description') {
      meta.description = stripQuotes(value)
    } else if (key === 'globs') {
      const inner = value.replace(/^\[|\]$/g, '')
      meta.globs = inner
        .split(',')
        .map((s) => stripQuotes(s.trim()))
        .filter(Boolean)
    }
  }
  return { meta, body: split.body.trim() }
}

function globToRegExp(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, '/')
  const escaped = normalized
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\0/g, '.*')
    .replace(/\?/g, '[^/]')
  return new RegExp(`^${escaped}$`)
}

/**
 * Auto-inject when alwaysApply is true/absent and there are no globs.
 * `alwaysApply: false` without globs is requestable only.
 * Globs inject when the focused file matches, even if alwaysApply is false.
 */
export function shouldAutoInjectRule(
  meta: RuleFrontmatter,
  focusedFile?: string | null
): boolean {
  if (meta.alwaysApply === true) return true
  if (meta.globs && meta.globs.length > 0) {
    if (!focusedFile) return false
    const path = focusedFile.replace(/\\/g, '/')
    return meta.globs.some((glob) => globToRegExp(glob).test(path))
  }
  if (meta.alwaysApply === false) return false
  return true
}

export type WorkspaceRuleApplies = 'always' | 'matching' | 'request'

/** Mirrors `shouldAutoInjectRule` without a focused file to test against. */
export function workspaceRuleApplies(meta: RuleFrontmatter): WorkspaceRuleApplies {
  if (meta.alwaysApply === true) return 'always'
  if (meta.globs && meta.globs.length > 0) return 'matching'
  return meta.alwaysApply === false ? 'request' : 'always'
}

/**
 * The `alwaysApply` flag the mention surfaces report: false only when the
 * frontmatter says so. Coarser than `workspaceRuleApplies` — a glob rule
 * without the key reads as true here. Both the main-side rule list and the
 * composer call this, so the two cannot drift apart the way the hand-synced
 * copies did.
 */
export function isAlwaysApplyRule(meta: RuleFrontmatter): boolean {
  return meta.alwaysApply !== false
}
