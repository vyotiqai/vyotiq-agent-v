import { existsSync, readdirSync, realpathSync, rmSync, statSync } from 'fs'
import { resolve } from 'path'
import { resolveInsideWorkspace, assertResolvedInsideWorkspace } from '../../workspace/safePath'
import {
  withExclusiveWorkspaceMutation,
  withWorkspaceMutation
} from '@main/workspace/mutationQueue'
import { missingPathHint } from './read'

/** Delete a file, or a directory when the caller opts into recursion. */
export function toolDelete(workspaceRoot: string, pathArg: string, recursive = false): string {
  const target = (pathArg ?? '').trim()
  if (!target) throw new Error('delete requires a non-empty path')

  const resolved = resolveInsideWorkspace(workspaceRoot, target)
  // resolved is realpath-resolved inside resolveInsideWorkspace; compare
  // against the real root too, or a symlinked/aliased root (macOS /var →
  // /private/var, Windows 8.3 CI temp paths) never matches and '.' deletes
  // walk into the entry-count error instead of the root refusal.
  if (resolve(resolved) === resolve(realpathSync(workspaceRoot))) {
    throw new Error('Refusing to delete the workspace root')
  }
  if (!existsSync(resolved)) {
    throw new Error(missingPathHint(workspaceRoot, target))
  }

  assertResolvedInsideWorkspace(workspaceRoot, resolved)
  const stat = statSync(resolved)
  if (stat.isDirectory()) {
    const entries = readdirSync(resolved)
    if (entries.length > 0 && !recursive) {
      throw new Error(
        `${target} is a directory with ${entries.length} entries. Pass recursive=true to delete it.`
      )
    }
    rmSync(resolved, { recursive: true, force: false })
    return `Deleted directory ${target}${entries.length ? ` (${entries.length} entries)` : ''}`
  }

  rmSync(resolved, { force: false })
  return `Deleted ${target}`
}

export async function toolDeleteAsync(
  workspaceRoot: string,
  pathArg: string,
  recursive = false
): Promise<string> {
  const target = (pathArg ?? '').trim()
  if (!target) throw new Error('delete requires a non-empty path')
  if (recursive) {
    return withExclusiveWorkspaceMutation(workspaceRoot, () =>
      toolDelete(workspaceRoot, target, recursive)
    )
  }
  return withWorkspaceMutation(workspaceRoot, target, () =>
    toolDelete(workspaceRoot, target, recursive)
  )
}
