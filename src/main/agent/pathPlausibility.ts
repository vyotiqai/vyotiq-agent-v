/**
 * Two deliberately different "is this a workspace path?" tests, and the two
 * normalizers they are paired with.
 *
 * These lived as same-named copies in `context/foldFacts.ts` and `loopPolicy.ts`
 * and drifted: on the 20-input table below they disagreed 17 times. The
 * divergence is real and wanted — the two sides read different input
 * distributions — so the copies are merged here under names that say which is
 * which, and `tests/main/unit/pathPlausibility.test.ts` pins the whole table.
 *
 * `isStrictWorkspaceFilePath` reads MODEL PROSE. A compaction summary's "Files
 * Touched" bullets run through it, and anything it admits that the fold did not
 * actually touch is reported as an invented path, which discards the fold. Its
 * rejections are prose-shaped — CLI flags, package specs, `file.ts:28` line
 * refs, URLs, `process.env`-style identifiers — and it ends with an allowlist:
 * a known source extension, or a dotfile. Directories are rejected, because
 * `src/core` in a summary is a topic, not a claim about a file.
 *
 * `looksLikeWorkspacePath` reads TOOL ARGS AND SHELL COMMANDS. Checkpoints,
 * run receipts and terminal-write scraping run through it, and anything it
 * rejects is dropped from what the run reports as touched — so it errs the
 * other way. Its rejections are shell-shaped (`;|&<>`, comma-glued args,
 * `$env:` paths) and it admits directories: `mkdir src/stores` must be
 * recorded, and `checkpoints.recordPrior` stores recursive dir deletes as bare
 * directory names.
 *
 * The normalizers differ for the same reason, and each difference is
 * load-bearing:
 *   - `normalizeWorkspaceRelPath` KEEPS a trailing slash, because for the loose
 *     side the slash is the only thing marking `docs/` as a directory rather
 *     than an extensionless junk token.
 *   - `normalizeWorkspaceFileRelPath` DROPS it, because the strict side
 *     compares paths for identity (`verifyCompaction` matches a claimed path
 *     against the fold facts) and `src/a.ts/` must equal `src/a.ts` there, or a
 *     real file gets reported as invented.
 */

/** Trim, backslashes to forward slashes. Trailing slashes are KEPT — see the module note. */
export function normalizeWorkspaceRelPath(path: string): string {
  return path.trim().replace(/\\/g, '/')
}

/** `normalizeWorkspaceRelPath` plus trailing-slash removal, for file identity. */
export function normalizeWorkspaceFileRelPath(path: string): string {
  const n = normalizeWorkspaceRelPath(path)
  if (!n || n === '/') return n
  return n.replace(/\/+$/, '')
}

/** True when a path/glob string names a single concrete entry (no wildcards). */
export function isConcreteWorkspacePath(value: string): boolean {
  const path = normalizeWorkspaceRelPath(value)
  if (!path || path === '.' || path === '..') return false
  if (/[*?[{]/.test(path)) return false
  return true
}

const SOURCE_EXT_RE =
  /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json|md|mdc|txt|yml|yaml|toml|css|scss|less|html|astro|vue|svelte|ps1|lock|svg|png|gif|jpe?g|webp|ico|map|wasm|env|sql|py|rs|go|java|kt|kts|swift|rb|php|cs|cpp|cxx|h|hpp|c|mm|xml|ini|cfg|conf|sh|bash|zsh|bat|cmd|ttf|woff2?)$/i
const DOTFILE_RE = /^\.[A-Za-z0-9][\w.-]*$/
const IDENTIFIER_STEM_RE =
  /^(?:process|import|logger|console|module|globalThis|window|document)\./

/**
 * Strict test for paths a MODEL CLAIMED in prose (compaction verification).
 * Requires a known source extension or a dotfile, so directories and prose
 * tokens never become "invented path" accusations. See the module note.
 */
export function isStrictWorkspaceFilePath(value: string): boolean {
  const path = normalizeWorkspaceFileRelPath(value)
  if (!isConcreteWorkspacePath(path)) return false
  if (/\s/.test(path)) return false
  if (path.includes(',')) return false
  if (/^[=+-]+$/.test(path)) return false
  if (path.startsWith('--')) return false
  if (path.startsWith('@')) return false
  // PowerShell env paths (`$env:TEMP/…`) are not workspace files. The loose test
  // has always rejected these; this copy did not, and admitted
  // `$env:TEMP/ext.ps1` because its basename carries a source extension.
  if (path.startsWith('$')) return false
  if (path === '/' || /^\/+$/.test(path)) return false
  if (/:\d+$/.test(path)) return false
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path) && !/^[A-Za-z]:\//.test(path)) return false
  if (path.includes(')') && !path.includes('(')) return false
  if (!/[A-Za-z0-9]/.test(path.replace(/[./\\_-]/g, ''))) return false
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  if (IDENTIFIER_STEM_RE.test(base) || IDENTIFIER_STEM_RE.test(path)) return false
  if (!(DOTFILE_RE.test(base) || SOURCE_EXT_RE.test(base))) return false
  return true
}

/**
 * Loose test for paths taken from TOOL ARGS AND SHELL COMMANDS (checkpoints,
 * receipts, terminal scraping). Admits directories; rejects shell junk —
 * comma-glued args, operators, `$env:` paths, bare punctuation. See the module
 * note.
 */
export function looksLikeWorkspacePath(value: string): boolean {
  const path = normalizeWorkspaceRelPath(value)
  if (!isConcreteWorkspacePath(path)) return false
  if (path.includes(',')) return false
  if (/[;|&<>]/.test(path)) return false
  // PowerShell env paths (`$env:TEMP/…`) are not workspace files.
  if (path.startsWith('$')) return false
  if (/^[=+-]+$/.test(path)) return false
  if (path.includes(')') && !path.includes('(')) return false
  if (!path.includes('/') && !/\.[a-zA-Z0-9][\w.-]*$/.test(path)) return false
  return true
}
