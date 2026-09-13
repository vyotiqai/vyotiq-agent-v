import { existsSync, realpathSync } from 'fs'
import { basename, dirname, join } from 'path'
import {
  assertInsideWorkspace,
  canonicalizeWorkspacePath,
  isWindowsStylePath
} from '../../shared/utils/workspacePath'

function pathKey(path: string): string {
  return isWindowsStylePath(path) ? path.toLowerCase() : path
}

/** True when `resolved` is `realRoot` or a path under it (symlink-aware callers pass realpaths). */
export function isInsideRoot(resolved: string, realRoot: string): boolean {
  const rootKey = pathKey(canonicalizeWorkspacePath(realRoot))
  const resolvedKey = pathKey(canonicalizeWorkspacePath(resolved))
  const sep = isWindowsStylePath(realRoot) ? '\\' : '/'
  return resolvedKey === rootKey || resolvedKey.startsWith(rootKey + sep)
}

/** Resolve symlinks for an existing path, or for the longest existing ancestor. */
export function realpathIfExists(path: string): string {
  const canonical = canonicalizeWorkspacePath(path)
  const tail: string[] = []
  let probe = canonical
  while (probe && !existsSync(probe)) {
    const parent = dirname(probe)
    if (parent === probe) break
    tail.unshift(basename(probe))
    probe = parent
  }
  if (!existsSync(probe)) return canonical
  try {
    const real = realpathSync(probe)
    return tail.length ? join(real, ...tail) : real
  } catch {
    return canonical
  }
}

/**
 * Resolve a workspace-relative path and reject symlink escapes.
 * String containment alone is not enough — a symlink inside the workspace can
 * point outside it.
 */
export function resolveInsideWorkspace(workspaceRoot: string, relPath: string): string {
  const candidate = assertInsideWorkspace(workspaceRoot, relPath)
  const realRoot = realpathSync(canonicalizeWorkspacePath(workspaceRoot))

  if (existsSync(candidate)) {
    const real = realpathSync(candidate)
    if (!isInsideRoot(real, realRoot)) {
      throw new Error(`Path escapes workspace: ${relPath}`)
    }
    return real
  }

  // New file — walk up to the nearest existing ancestor and resolve from there.
  const tail: string[] = []
  let probe = candidate
  while (!existsSync(probe)) {
    tail.unshift(basename(probe))
    const parent = dirname(probe)
    if (parent === probe) break
    probe = parent
  }

  if (!existsSync(probe)) {
    return candidate
  }

  const realBase = realpathSync(probe)
  if (!isInsideRoot(realBase, realRoot)) {
    throw new Error(`Path escapes workspace: ${relPath}`)
  }

  const resolved = tail.length ? join(realBase, ...tail) : realBase
  if (!isInsideRoot(resolved, realRoot)) {
    throw new Error(`Path escapes workspace: ${relPath}`)
  }
  return resolved
}

/**
 * Re-check containment after mkdir/create. Closes the gap where a parent
 * directory is swapped for an escaping symlink between resolve and write.
 */
export function assertResolvedInsideWorkspace(
  workspaceRoot: string,
  absolutePath: string
): void {
  const realRoot = realpathSync(canonicalizeWorkspacePath(workspaceRoot))
  let probe = absolutePath
  while (!existsSync(probe)) {
    const parent = dirname(probe)
    if (parent === probe) {
      throw new Error(`Path escapes workspace: ${absolutePath}`)
    }
    probe = parent
  }
  const real = realpathSync(probe)
  if (!isInsideRoot(real, realRoot)) {
    throw new Error(`Path escapes workspace: ${absolutePath}`)
  }
}
