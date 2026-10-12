/**
 * Coalesce overlapping `readGitStatus` calls and briefly reuse results.
 * Startup often fires 2× git:status for the same workspace within the same second.
 */
import { GIT_STATUS_FILE_LIMIT_DEFAULT, type GitStatusResult } from '../../shared/ipc'
import { canonicalizeWorkspacePath } from '../../shared/workspacePath'
import { invalidateWorkspaceFileListCache } from '../workspace/fileListCache'
import { readGitStatus as readGitStatusUncached } from './git'

const TTL_MS = 750

type CacheEntry = {
  status: GitStatusResult
  expiresAt: number
  generation: number
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<GitStatusResult>>()
/** Bumped on invalidate so in-flight reads cannot re-cache stale status. */
const generationByKey = new Map<string, number>()

function cacheKey(cwd: string): string {
  return canonicalizeWorkspacePath(cwd)
}

/** One entry per workspace and file limit; generations stay per workspace. */
function entryKey(key: string, limit: number): string {
  return `${key}\0${limit}`
}

function dropEntries(key: string): void {
  const prefix = `${key}\0`
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k)
  for (const k of [...inflight.keys()]) if (k.startsWith(prefix)) inflight.delete(k)
}

function currentGeneration(key: string): number {
  return generationByKey.get(key) ?? 0
}

export function invalidateGitStatusCache(cwd?: string): void {
  // Whatever can move git status can add or remove files, so the path
  // pickers' walked list goes stale with it.
  invalidateWorkspaceFileListCache(cwd)
  if (cwd == null) {
    cache.clear()
    inflight.clear()
    for (const key of generationByKey.keys()) {
      generationByKey.set(key, (generationByKey.get(key) ?? 0) + 1)
    }
    return
  }
  const key = cacheKey(cwd)
  dropEntries(key)
  generationByKey.set(key, currentGeneration(key) + 1)
}

/** Status read with in-flight coalesce + short TTL. */
export async function readGitStatusCached(
  cwd: string,
  limit: number = GIT_STATUS_FILE_LIMIT_DEFAULT
): Promise<GitStatusResult> {
  const key = cacheKey(cwd)
  const slot = entryKey(key, limit)
  const hit = cache.get(slot)
  if (hit && Date.now() <= hit.expiresAt && hit.generation === currentGeneration(key)) {
    return hit.status
  }

  const pending = inflight.get(slot)
  if (pending) return pending

  const generation = currentGeneration(key)
  const run = (async () => {
    const status = await readGitStatusUncached(cwd, limit)
    // Drop result if invalidate raced while we were shelling out.
    if (generation === currentGeneration(key)) {
      cache.set(slot, { status, expiresAt: Date.now() + TTL_MS, generation })
    }
    return status
  })()

  inflight.set(slot, run)
  try {
    return await run
  } finally {
    if (inflight.get(slot) === run) inflight.delete(slot)
  }
}

/** @internal */
export function resetGitStatusCacheForTests(): void {
  cache.clear()
  inflight.clear()
  generationByKey.clear()
}
