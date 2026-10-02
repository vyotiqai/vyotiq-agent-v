/**
 * Added folders ("extra roots"): folders outside the workspace a task may also
 * read and edit, as Claude Code's `--add-dir` does. The workspace stays the
 * task's cwd, its git/worktree/review root, and its memory and instructions
 * root; an added folder is reached by absolute path only.
 *
 * Shared by main (validation, routing, checkpoints) and the renderer (the
 * brief's folder chips, the Changes grouping).
 */

/** The most folders one task may add. */
export const MAX_EXTRA_ROOTS = 5

/** Longest path accepted for one added folder. */
export const EXTRA_ROOT_MAX_CHARS = 4096

/** Forward slashes, no trailing slash (a bare drive or `/` keeps its own). */
export function slashPath(path: string): string {
  const s = path.replace(/\\/g, '/')
  if (/^[A-Za-z]:\/$/.test(s) || s === '/') return s
  return s.replace(/\/+$/, '')
}

/** True for an absolute path in either Windows (`C:\`, `C:/`, UNC) or POSIX form. */
export function isAbsolutePathLike(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\\\')
}

function windowsLike(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

/** Comparison key: slash form, case-folded for Windows-style paths. */
export function extraRootKey(path: string): string {
  const s = slashPath(path.trim())
  return windowsLike(path.trim()) ? s.toLowerCase() : s
}

/** True when `path` is `root` or inside it (string containment; callers resolve symlinks). */
export function isPathInsideRoot(path: string, root: string): boolean {
  const p = extraRootKey(path)
  const r = extraRootKey(root)
  if (!p || !r) return false
  return p === r || p.startsWith(r.endsWith('/') ? r : `${r}/`)
}

/** The added folder that holds `path`, or null. Absolute `path` only. */
export function extraRootFor(path: string, roots: readonly string[]): string | null {
  if (!isAbsolutePathLike(path.trim())) return null
  for (const root of roots) {
    if (isPathInsideRoot(path, root)) return root
  }
  return null
}

/** What a folder is called on a chip: its last segment. */
export function extraRootLabel(root: string): string {
  const s = slashPath(root.trim())
  const last = s.split('/').filter(Boolean).pop()
  return last ?? s
}

/** `path` relative to `root`, forward slashes; '' for the root itself. Assumes containment. */
export function relativeToExtraRoot(path: string, root: string): string {
  const s = slashPath(path.trim())
  const r = slashPath(root.trim())
  if (s.length <= r.length) return ''
  return s.slice(r.endsWith('/') ? r.length : r.length + 1)
}

/** A root-relative path as the model should cite it: absolute, forward slashes. */
export function extraRootDisplayPath(root: string, rel: string): string {
  const r = slashPath(root)
  if (!rel) return r
  return r.endsWith('/') ? `${r}${rel}` : `${r}/${rel}`
}

/** Drop blanks and duplicates (case-insensitively for Windows paths), keep order, cap the count. */
export function dedupeExtraRoots(roots: readonly string[] | undefined, cap: number = MAX_EXTRA_ROOTS): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of roots ?? []) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const key = extraRootKey(trimmed)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
    if (out.length >= cap) break
  }
  return out
}
