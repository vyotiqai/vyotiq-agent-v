// Shared by main and renderer, so this must stay free of node:path — the renderer
// bundle externalizes it and the module would resolve to an empty browser shim.

const WINDOWS_DRIVE = /^([a-zA-Z]):([\\/]|$)/
const UNC_PREFIX = /^[\\/]{2}[^\\/]/

export function isWindowsStylePath(path: string): boolean {
  if (WINDOWS_DRIVE.test(path)) return true
  if (UNC_PREFIX.test(path)) return true
  return path.includes('\\') && !path.startsWith('/')
}

function collapseSegments(segments: string[]): string[] {
  const out: string[] = []
  for (const segment of segments) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      out.pop()
      continue
    }
    out.push(segment)
  }
  return out
}

function splitRoot(path: string, windows: boolean): { root: string; rest: string } {
  if (windows) {
    if (UNC_PREFIX.test(path)) return { root: '\\\\', rest: path.slice(2) }
    const drive = WINDOWS_DRIVE.exec(path)
    if (drive) {
      return { root: `${drive[1].toUpperCase()}:\\`, rest: path.slice(drive[0].length) }
    }
    return { root: '', rest: path }
  }
  return path.startsWith('/') ? { root: '/', rest: path.slice(1) } : { root: '', rest: path }
}

/** Normalize separators, drive casing, `.`/`..` segments and trailing slashes. */
export function canonicalizeWorkspacePath(workspacePath: string): string {
  const trimmed = workspacePath
  if (!trimmed) return ''
  const windows = isWindowsStylePath(trimmed)
  const separator = windows ? '\\' : '/'
  const { root, rest } = splitRoot(trimmed, windows)
  const segments = collapseSegments(rest.split(/[\\/]+/))
  const joined = segments.join(separator)
  if (!joined) return root || '.'
  return root + joined
}

function pathKey(path: string): string {
  return isWindowsStylePath(path) ? path.toLowerCase() : path
}

/**
 * Resolve `relPath` against the workspace root and reject anything whose
 * RESOLVED STRING lands outside it. Throws rather than returning null so no
 * caller can accidentally ignore the check.
 *
 * This is the string layer only: it does not read the filesystem, so a symlink
 * inside the workspace that points outside it passes. Any caller that then
 * touches the path must use `resolveInsideWorkspace`
 * (src/main/workspace/safePath.ts), which realpaths and re-checks; this
 * function is what that wrapper is built on.
 */
export function assertInsideWorkspace(workspaceRoot: string, relPath: string): string {
  const root = canonicalizeWorkspacePath(workspaceRoot)
  const windows = isWindowsStylePath(root)
  const separator = windows ? '\\' : '/'
  const candidate =
    splitRoot(relPath, isWindowsStylePath(relPath)).root !== ''
      ? canonicalizeWorkspacePath(relPath)
      : canonicalizeWorkspacePath(`${root}${separator}${relPath}`)

  const rootKey = pathKey(root)
  const candidateKey = pathKey(candidate)
  const inside =
    candidateKey === rootKey ||
    candidateKey.startsWith(rootKey.endsWith(separator) ? rootKey : rootKey + separator)
  if (!inside) throw new Error(`Path escapes workspace: ${relPath}`)
  return candidate
}

/**
 * True when `path` is a workspace-relative file path with no absolute root,
 * drive letter, UNC, empty segments, or `..` escapes.
 */
export function isSafeWorkspaceRelPath(path: string): boolean {
  const t = path.replace(/\\/g, '/')
  if (!t || t === '.') return false
  if (t.includes('\0')) return false
  if (t.startsWith('/') || t.startsWith('//')) return false
  if (WINDOWS_DRIVE.test(t)) return false
  if (UNC_PREFIX.test(t)) return false
  const parts = t.split('/')
  if (parts.some((p) => !p || p === '.' || p === '..')) return false
  // Reject Windows drive-style segments mid-path (e.g. packages/C:/Windows).
  if (parts.some((p) => /^[a-zA-Z]:/.test(p))) return false
  return true
}

/** Curated docs for @-Docs: README*, docs/**, top-level *.md, AGENTS.md / CLAUDE.md. */
export function isCuratedDocPath(rel: string): boolean {
  const n = rel.replace(/\\/g, '/')
  const lower = n.toLowerCase()
  const slash = lower.lastIndexOf('/')
  const base = slash >= 0 ? lower.slice(slash + 1) : lower
  if (lower === 'agents.md' || lower === 'claude.md' || lower === '.cursorrules') return true
  if (base.startsWith('readme')) return true
  if (lower.startsWith('docs/') || lower.includes('/docs/')) {
    return base.endsWith('.md') || base.endsWith('.mdx') || base.endsWith('.mdc')
  }
  if (!n.includes('/') && (base.endsWith('.md') || base.endsWith('.mdx'))) return true
  return false
}

/**
 * Normalize a tool-reported path into one the workspace file IPC can open.
 *
 * The two sides disagree on form: agent tools take whatever the model sent
 * (`readPathArg` does not normalize, and `assertInsideWorkspace` has an
 * explicit branch for rooted paths), while the workspace file service runs
 * every path through `isSafeWorkspaceRelPath`, which rejects drive letters,
 * UNC prefixes and leading slashes. A tool card holding an absolute path
 * would therefore render a link that always fails to open.
 *
 * Returns null when the path escapes the workspace, names the root itself, or
 * cannot be expressed relative to it — callers render inert chrome instead.
 */
export function toWorkspaceRelPath(
  workspaceRoot: string | null | undefined,
  pathArg: string | null | undefined
): string | null {
  const raw = (pathArg ?? '').trim()
  if (!raw || raw.includes('\0')) return null

  // Already relative: normalize separators, `./` and trailing slashes only.
  const slashed = raw.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '')
  if (isSafeWorkspaceRelPath(slashed)) return slashed

  const root = canonicalizeWorkspacePath(workspaceRoot ?? '')
  if (!root) return null

  let absolute: string
  try {
    absolute = assertInsideWorkspace(root, raw)
  } catch {
    return null
  }

  const windows = isWindowsStylePath(root)
  const separator = windows ? '\\' : '/'
  const prefix = root.endsWith(separator) ? root : root + separator
  const absoluteKey = windows ? absolute.toLowerCase() : absolute
  const prefixKey = windows ? prefix.toLowerCase() : prefix
  // Equal to the root (a directory, not a file) fails this too, by design.
  if (!absoluteKey.startsWith(prefixKey)) return null

  const rel = absolute.slice(prefix.length).replace(/\\/g, '/')
  return isSafeWorkspaceRelPath(rel) ? rel : null
}
