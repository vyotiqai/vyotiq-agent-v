import { canonicalizeWorkspacePath, isWindowsStylePath } from './workspacePath'

/** Compare two workspace paths, ignoring case only for Windows-style paths. */
export function workspacePathsEqual(a: string, b: string): boolean {
  const left = canonicalizeWorkspacePath(a)
  const right = canonicalizeWorkspacePath(b)
  if (isWindowsStylePath(left) || isWindowsStylePath(right)) {
    return left.toLowerCase() === right.toLowerCase()
  }
  return left === right
}

/** True when `path` is `root` or a file/dir under it. */
export function workspacePathIsInside(root: string, path: string): boolean {
  if (workspacePathsEqual(root, path)) return true
  const base = canonicalizeWorkspacePath(root)
  const target = canonicalizeWorkspacePath(path)
  const windows = isWindowsStylePath(base) || isWindowsStylePath(target)
  const sep = windows ? '\\' : '/'
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`
  if (windows) {
    return target.toLowerCase().startsWith(prefix.toLowerCase())
  }
  return target.startsWith(prefix)
}

/**
 * Look up a path-keyed record with equality that matches Windows casing and
 * path canonicalization — direct index alone misses legacy / alternate keys.
 */
export function findByWorkspacePath<T>(
  map: Record<string, T | undefined>,
  path: string
): T | null {
  if (map[path] !== undefined) return map[path] ?? null
  for (const key of Object.keys(map)) {
    if (workspacePathsEqual(key, path)) return map[key] ?? null
  }
  return null
}
