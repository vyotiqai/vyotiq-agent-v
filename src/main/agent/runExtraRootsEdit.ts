import type { UpdateRunExtraRootsResult } from '../../shared/ipc'
import { MAX_EXTRA_ROOTS, extraRootKey } from '../../shared/extraRoots'
import { resolveRunDir } from '../storage/paths'
import { loadStatus, runExists, updateStatus } from './state'
import { invalidateListRunsCache } from './runListCache'
import { isActive } from './runRegistry'
import { validateExtraRoots } from './extraRoots'

/**
 * Change the added folders of a task that already exists (extraRoots.ts):
 * `/add-dir` or the task menu's Add folder… / Remove on a started task.
 *
 * The list is saved on the run's status, which is what every invoke reads
 * (`liveExtraRoots` in loop.ts). A running invoke keeps the folders it started
 * with — its checkpoint, permissions and sandbox were built from them — so the
 * change takes effect when the task next starts: a follow-up after it
 * finishes, Resume or Retry. A finished task's next follow-up carries it.
 */
export type RunExtraRootsChange = { add: string } | { remove: string }

export async function updateRunExtraRoots(
  workspacePath: string,
  runId: string,
  change: RunExtraRootsChange,
  opts: { userDataDir?: string | null } = {}
): Promise<UpdateRunExtraRootsResult> {
  if (!runExists(workspacePath, runId)) throw new Error('Run not found')
  const runDir = resolveRunDir(workspacePath, runId)
  const status = loadStatus(runDir)
  if (!status) throw new Error('Invalid run status')
  const current = status.extraRoots ?? []
  const live = isActive(runId)
  const unchanged = (refused: string): UpdateRunExtraRootsResult => ({ extraRoots: [...current], live, refused })
  if (status.imported != null) return unchanged('an imported task is read-only. Fork it to continue.')
  // A helper works in its parent's tree and is merged back through its git.
  if (status.inlineInstance) return unchanged("a helper works in its parent task's folders")

  if ('remove' in change) {
    const key = extraRootKey(change.remove)
    const next = current.filter((root) => extraRootKey(root) !== key)
    if (next.length === current.length) return unchanged(`${change.remove}: not one of this task's folders`)
    await save(workspacePath, runDir, next)
    const removed = current.find((root) => extraRootKey(root) === key)!
    return { extraRoots: next, live, removed }
  }

  const picked = change.add.trim()
  if (current.length >= MAX_EXTRA_ROOTS) return unchanged(`${picked}: at most ${MAX_EXTRA_ROOTS} folders`)
  // The saved folders are checked again too, but only to find overlaps: one
  // that is missing right now stays on the task (it may be a drive not mounted).
  const checked = validateExtraRoots(workspacePath, [...current, picked], opts)
  const refusal = checked.refused.find((r) => r.path === picked)
  if (refusal) return unchanged(`${refusal.path}: ${refusal.reason}`)
  const known = new Set(current.map(extraRootKey))
  const added = checked.roots.find((root) => !known.has(extraRootKey(root)))
  if (!added) return unchanged(`${picked}: already added`)
  const next = [...current, added]
  await save(workspacePath, runDir, next)
  return { extraRoots: next, live, added }
}

async function save(workspacePath: string, runDir: string, extraRoots: string[]): Promise<void> {
  // Through the per-dir status chain, so a running loop's own status writes
  // merge with it instead of putting the old list back.
  await updateStatus(runDir, { extraRoots }, { sync: true })
  invalidateListRunsCache(workspacePath)
}
