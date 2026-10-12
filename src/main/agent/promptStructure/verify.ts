import { existsSync } from 'fs'
import { isAbsolute, join } from 'path'
import type { StructureKnown } from './context'

/**
 * The brief may only point at what is there. A model asked to "be specific"
 * invents plausible paths (`src/utils/auth.ts`) and scripts (`npm run lint`)
 * that the agent then hunts for; every backticked path and package-script
 * command is checked against the workspace before the person sees the brief.
 */

const PATH_EXT_RE =
  /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json|jsonc|jsonl|md|mdx|mdc|txt|yml|yaml|toml|css|scss|sass|less|html|htm|astro|vue|svelte|ps1|psm1|lock|svg|png|gif|jpe?g|webp|ico|wasm|sql|py|pyi|ipynb|rs|go|java|kt|kts|swift|rb|php|cs|csproj|sln|fs|cpp|cxx|cc|h|hpp|c|m|mm|xml|ini|cfg|conf|sh|bash|zsh|fish|bat|cmd|gradle|dart|ex|exs|erl|lua|r|scala|clj|tf|proto|graphql|gql|prisma|dockerfile)$/i
const DOTFILE_RE = /^\.[A-Za-z0-9][\w.-]*$/
/** Names that look like files and are not. */
const NOT_PATHS = new Set(['node.js', 'next.js', 'nuxt.js', 'vue.js', 'react.js', 'express.js', 'three.js', 'd3.js', 'chart.js', 'nest.js', 'socket.io', 'asp.net'])

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
/** The managers' own commands: not package scripts, never checked against them. */
const PM_BUILTINS = new Set(
  (
    'install i add remove rm uninstall un update up upgrade exec dlx x create init why list ls outdated audit ' +
    'publish pack link unlink store config help version ci prune rebuild dedupe import patch patch-commit ' +
    'licenses env setup fetch root bin info view workspace workspaces cache login logout whoami global ' +
    'install-test it'
  ).split(' ')
)

/** The backticked spans of a brief, code fences included line by line. */
export function backtickedSpans(brief: string): string[] {
  const out: string[] = []
  for (const m of brief.matchAll(/`([^`\n]{1,300})`/g)) out.push(m[1]!.trim())
  return out.filter(Boolean)
}

/** A span as a workspace path to check, or null when it is not a path claim. */
export function asPathClaim(span: string): string | null {
  const s = span.trim()
  if (!s || /\s/.test(s)) return null
  if (/:\/\//.test(s) || /^[-$<>]|[=()<>{}|,;]/.test(s)) return null
  if (/^@[\w.-]+\/[\w.-]+(?:@[\w.^~-]+)?$/.test(s)) return null // a scoped package
  if (/[*?[\]]/.test(s)) return null // a glob: a pattern, not a claim that one file exists
  const path = s
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/#L\d+.*$/, '')
    .replace(/:\d+(?::\d+)?$/, '')
  if (!path || path === '.' || path === '..' || path === '/') return null
  if (NOT_PATHS.has(path.toLowerCase())) return null
  const base = path.replace(/\/+$/, '').split('/').at(-1) ?? ''
  if (path.includes('/')) return /[A-Za-z]/.test(path) ? path : null
  return PATH_EXT_RE.test(base) || DOTFILE_RE.test(base) ? path : null
}

export type VerifyInput = {
  brief: string
  known: StructureKnown
  workspacePath: string
  /** The person's own words and attached paths: what they named is allowed, even if it does not exist yet. */
  instruction: string
  mentionPaths: readonly string[]
}

function pathKnown(path: string, input: VerifyInput, files: readonly string[], dirs: readonly string[]): boolean {
  const lower = path.toLowerCase().replace(/\/+$/, '')
  if (input.instruction.toLowerCase().includes(lower)) return true
  if (input.mentionPaths.some((p) => p.toLowerCase().replace(/\\/g, '/').includes(lower))) return true
  if (input.known.rulesText.toLowerCase().includes(lower)) return true
  if (isAbsolute(path) || /^[A-Za-z]:\//.test(path)) return existsSync(path)
  const asSuffix = `/${lower}`
  if (files.some((f) => f === lower || f.endsWith(asSuffix))) return true
  if (dirs.some((d) => d === lower || d.endsWith(asSuffix))) return true
  // Not in the walk does not prove absence — it stops at a cap and skips
  // folders like `.vyotiq/` — so ask the disk before calling it invented.
  if (lower.split('/').includes('..')) return false
  try {
    return existsSync(join(input.workspacePath, path))
  } catch {
    return false
  }
}

/** The script a package-manager command runs, or null when it runs none (a builtin, flags first). */
export function scriptOf(tokens: readonly string[]): string | null {
  const [pm, sub, next] = tokens
  if (!pm || !PACKAGE_MANAGERS.has(pm) || !sub) return null
  if (sub === 'run' || sub === 'run-script') return next && !next.startsWith('-') ? next : null
  if (sub.startsWith('-')) return null
  if (pm === 'npm') return sub === 'test' || sub === 'start' || sub === 'stop' || sub === 'restart' ? sub : null
  return PM_BUILTINS.has(sub) ? null : sub
}

function commandKnown(command: string, input: VerifyInput): boolean {
  const tokens = command.split(/\s+/)
  const lowerCommand = command.toLowerCase()
  if (input.instruction.toLowerCase().includes(lowerCommand)) return true
  if (input.known.rulesText.toLowerCase().includes(lowerCommand)) return true
  const [first, second] = tokens
  if (first && PACKAGE_MANAGERS.has(first)) {
    const script = scriptOf(tokens)
    return script == null || input.known.scripts.has(script)
  }
  if (first === 'make') return !second || second.startsWith('-') || input.known.makeTargets.has(second)
  if (first === 'just') return !second || second.startsWith('-') || input.known.justRecipes.has(second)
  return true
}

/**
 * A line that offers a file to make, not one to find: "write the report to
 * …", "a new test in …", "name it …". Not "add": "add a guard in `x.ts`"
 * points at a file that should already be there.
 */
const NEW_FILE_LINE_RE = /\b(?:new|create[sd]?|creating|write|writes|save|named?|name it|call it|e\.g\.|such as|like)\b/i

/** The path's folder is a real one (or it has none): a new file there is plausible. */
function parentKnown(path: string, input: VerifyInput, dirs: readonly string[]): boolean {
  const trimmed = path.replace(/\/+$/, '')
  const cut = trimmed.lastIndexOf('/')
  if (cut < 0) return true
  const parent = trimmed.slice(0, cut).toLowerCase()
  if (dirs.some((d) => d === parent || d.endsWith(`/${parent}`))) return true
  if (parent.split('/').includes('..')) return false
  try {
    return existsSync(join(input.workspacePath, parent))
  } catch {
    return false
  }
}

/** Backticked paths and commands in the brief that the workspace does not have, as written. */
export function findUnknownReferences(input: VerifyInput): string[] {
  const files = input.known.files.map((f) => f.toLowerCase())
  const dirs = input.known.dirs.map((d) => d.toLowerCase())
  const unknown = new Set<string>()
  for (const line of input.brief.split('\n')) {
    // The line's own words, not its code: `src/new/x.ts` does not offer a new file.
    const offersNewFile = NEW_FILE_LINE_RE.test(line.replace(/`[^`\n]*`/g, ' '))
    for (const span of backtickedSpans(line)) {
      if (/\s/.test(span)) {
        if (!commandKnown(span, input)) unknown.add(span)
        continue
      }
      const path = asPathClaim(span)
      if (!path || pathKnown(path, input, files, dirs)) continue
      // A file the brief asks the agent to make, in a folder that exists.
      if (offersNewFile && parentKnown(path, input, dirs)) continue
      unknown.add(span)
    }
  }
  return [...unknown]
}

/** What survived the second try is left in, marked, for the person to fix while they edit. */
export function markNotFound(brief: string, notFound: readonly string[]): string {
  let text = brief
  for (const span of notFound) {
    text = text.split(`\`${span}\``).join(`\`${span}\` (not found in this workspace)`)
  }
  return text
}
