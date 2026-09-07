/**
 * Derived codebase indexes live under Electron userData, not the project tree.
 * Layout: {userData}/workspaces/{workspaceId}/codeindex|sparsegrep
 * (same workspace id as sessions — see storage/paths.ts).
 */
import { existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { canonicalizeWorkspacePath } from '../../shared/workspacePath'
import { workspaceIdFromCanonical } from '../../shared/workspaceId'

let workspacesRootOverride: string | null = null

/** Vitest: point index storage at an isolated temp tree. */
export function setWorkspaceIndexStorageRootOverrideForTests(root: string | null): void {
  workspacesRootOverride = root
}

function resolveWorkspacesRoot(): string {
  if (workspacesRootOverride) return workspacesRootOverride
  try {
    // Lazy require — unit tests often run without Electron.
    const { app } = require('electron') as typeof import('electron')
    if (typeof app?.getPath === 'function') {
      return join(app.getPath('userData'), 'workspaces')
    }
  } catch {
    /* non-Electron */
  }
  return join(tmpdir(), 'vyotiq-index-workspaces')
}

export function workspaceIndexStorageId(workspacePath: string): string {
  return workspaceIdFromCanonical(canonicalizeWorkspacePath(workspacePath))
}

export function codeindexRoot(workspacePath: string): string {
  return join(resolveWorkspacesRoot(), workspaceIndexStorageId(workspacePath), 'codeindex')
}

export function codeindexDbPath(workspacePath: string): string {
  return join(codeindexRoot(workspacePath), 'index.sqlite')
}
/**
 * Instance-worktree workspaces live at
 * {userData}/workspaces/{parentWorkspaceId}/instance-worktrees/{runId}; their
 * code index can reuse the parent workspace's stored embeddings for identical
 * model-salted chunk hashes instead of re-embedding them.
 */
export function instanceWorktreeReuseDbPath(workspaceRoot: string): string | null {
  const segments = canonicalizeWorkspacePath(workspaceRoot)
    .split(/[/\\]/)
    .filter(Boolean)
  const wtIdx = segments.lastIndexOf('instance-worktrees')
  if (wtIdx <= 0) return null
  const parentWsId = segments[wtIdx - 1]
  if (!parentWsId) return null
  const parentDb = join(resolveWorkspacesRoot(), parentWsId, 'codeindex', 'index.sqlite')
  if (!existsSync(parentDb)) return null
  const own = codeindexDbPath(workspaceRoot)
  if (parentDb === own) return null
  return parentDb
}

export function sparsegrepRoot(workspacePath: string): string {
  return join(resolveWorkspacesRoot(), workspaceIndexStorageId(workspacePath), 'sparsegrep')
}

export function sparsegrepDbPath(workspacePath: string): string {
  return join(sparsegrepRoot(workspacePath), 'index.sqlite')
}

/** Legacy in-repo cache paths (pre userData move). */
export function legacyCodeindexRoot(workspacePath: string): string {
  return join(workspacePath, '.vyotiq', 'codeindex')
}

export function legacySparsegrepRoot(workspacePath: string): string {
  return join(workspacePath, '.vyotiq', 'sparsegrep')
}
