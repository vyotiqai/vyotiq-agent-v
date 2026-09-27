import { existsSync, realpath, realpathSync, type Stats } from 'fs'
import { lstat } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { promisify } from 'util'
import {
  assertInsideWorkspace,
  canonicalizeWorkspacePath,
  isWindowsStylePath
} from '../../shared/utils/workspacePath'

/** The JS realpath, as `realpathSync` is — not `.native`, which differs on subst drives. */
const realpathAsync = promisify(realpath)

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

type ResolvedPath = { real: string; exists: boolean }

/**
 * `resolveInsideWorkspace` for many paths at once, off the main thread's
 * back: the same containment and symlink rules, async, with each directory
 * resolved once per resolver. The sync form realpaths the root and walks every
 * missing path up to its nearest existing ancestor on every call — thousands of
 * blocking calls for a task that wrote thousands of files.
 *
 * Resolves to the real path and whether it exists, or null when the path is
 * invalid or escapes the workspace.
 */
export function createWorkspacePathResolver(
  workspaceRoot: string
): (relPath: string) => Promise<ResolvedPath | null> {
  const realRoot = realpathAsync(canonicalizeWorkspacePath(workspaceRoot)).catch(() => null)
  const memo = new Map<string, Promise<ResolvedPath | null>>()

  // Component by component, as realpath does, so a symlink anywhere on the way
  // is followed; null when not even the filesystem root resolves.
  const resolve = (abs: string): Promise<ResolvedPath | null> => {
    let pending = memo.get(abs)
    if (!pending) {
      pending = resolveUncached(abs)
      memo.set(abs, pending)
    }
    return pending
  }
  const resolveUncached = async (abs: string): Promise<ResolvedPath | null> => {
    const parent = dirname(abs)
    if (parent === abs) {
      try {
        return { real: await realpathAsync(abs), exists: true }
      } catch {
        return null
      }
    }
    const up = await resolve(parent)
    if (!up) return null
    const joined = join(up.real, basename(abs))
    if (!up.exists) return { real: joined, exists: false }
    let st: Stats
    try {
      st = await lstat(joined)
    } catch {
      return { real: joined, exists: false }
    }
    if (!st.isSymbolicLink()) return { real: joined, exists: true }
    try {
      return { real: await realpathAsync(joined), exists: true }
    } catch {
      // Dangling link: nothing there, as existsSync would say.
      return { real: joined, exists: false }
    }
  }

  return async (relPath) => {
    let candidate: string
    try {
      candidate = assertInsideWorkspace(workspaceRoot, relPath)
    } catch {
      return null
    }
    const root = await realRoot
    if (root === null) return null
    const resolved = await resolve(candidate)
    if (!resolved) return { real: candidate, exists: false }
    return isInsideRoot(resolved.real, root) ? resolved : null
  }
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
