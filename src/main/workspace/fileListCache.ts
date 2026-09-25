import { collectWorkspaceFiles } from '../agent/tools/walk'
import { canonicalizeWorkspacePath, isWindowsStylePath } from '../../shared/utils/workspacePath'

/**
 * The walked file list behind the path pickers (Ctrl K files, @ files, @ docs),
 * kept per workspace. Every query used to walk the tree itself — over 3s cold
 * on a large workspace — only to filter the same paths again.
 *
 * Nothing in main watches the whole tree, so the list is dropped by what already
 * reports file changes: every `invalidateGitStatusCache` (agent writes and
 * terminal commands, rewind and Undo, in-app git, a HEAD move), the Files
 * panel's create, move, delete and new-file save, and closing the workspace.
 * The next query walks again and sees the change. What nothing reports — another
 * editor, the integrated terminal — is caught by age instead: a list older than
 * FILE_LIST_REVALIDATE_AFTER_MS is still served, and walked again behind it for
 * the queries that follow.
 */

/** The cap each picker walked with. */
const WALK_CAP = 8_000

/** Closing a workspace drops its list; this bounds only a close that never reached here. */
export const FILE_LIST_MAX_WORKSPACES = 8

/** A list this old still answers, but the query that finds it starts a walk behind it. */
export const FILE_LIST_REVALIDATE_AFTER_MS = 10_000

type Entry = {
  /** Workspace-relative, forward slashes, in walk order; null until the first walk lands. */
  files: readonly string[] | null
  /** When the walk behind `files` started. */
  walkedAt: number
  /** The walk in flight: every query that arrives meanwhile shares it. */
  walk: Promise<readonly string[]> | null
}

/** Map order is recency: the first key is the workspace searched longest ago. */
const entries = new Map<string, Entry>()

function cacheKey(workspacePath: string): string {
  const canonical = canonicalizeWorkspacePath(workspacePath)
  return isWindowsStylePath(canonical) ? canonical.toLowerCase() : canonical
}

function startWalk(key: string, entry: Entry, workspacePath: string): Promise<readonly string[]> {
  const startedAt = Date.now()
  const walk = collectWorkspaceFiles(workspacePath, WALK_CAP).then((files) =>
    files.map((file) => file.rel.replace(/\\/g, '/'))
  )
  entry.walk = walk
  walk.then(
    (files) => {
      entry.walk = null
      entry.files = files
      entry.walkedAt = startedAt
    },
    () => {
      entry.walk = null
      // The next query walks again, and reports the error if it is still there.
      if (entries.get(key) === entry) entries.delete(key)
    }
  )
  return walk
}

/**
 * The workspace's files as the pickers list them. Walks only when there is no
 * list yet; the result is shared, so callers must not mutate it.
 */
export async function readWorkspaceFileListCached(
  workspacePath: string
): Promise<readonly string[]> {
  const key = cacheKey(workspacePath)
  const entry = entries.get(key) ?? { files: null, walkedAt: 0, walk: null }
  entries.delete(key)
  entries.set(key, entry)
  if (entries.size > FILE_LIST_MAX_WORKSPACES) {
    const oldest = entries.keys().next().value
    if (oldest !== undefined) entries.delete(oldest)
  }
  if (!entry.files) return entry.walk ?? startWalk(key, entry, workspacePath)
  if (!entry.walk && Date.now() - entry.walkedAt >= FILE_LIST_REVALIDATE_AFTER_MS) {
    void startWalk(key, entry, workspacePath)
  }
  return entry.files
}

/** Drop one workspace's list (every list, without a path) so its next query walks. */
export function invalidateWorkspaceFileListCache(workspacePath?: string): void {
  if (workspacePath == null) entries.clear()
  else entries.delete(cacheKey(workspacePath))
}
