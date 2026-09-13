/**
 * Coalesce overlapping `readGitStatus` calls and briefly reuse results.
 * Startup often fires 2× git:status for the same workspace within the same second.
 */
import type { GitStatusResult } from '../../shared/ipc'
import { canonicalizeWorkspacePath } from '../../shared/workspacePath'
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

function currentGeneration(key: string): number {
  return generationByKey.get(key) ?? 0
}

export function invalidateGitStatusCache(cwd?: string): void {
  if (cwd == null) {
    cache.clear()
    inflight.clear()
    for (const key of generationByKey.keys()) {
      generationByKey.set(key, (generationByKey.get(key) ?? 0) + 1)
    }
    return
  }
  const key = cacheKey(cwd)
  cache.delete(key)
  inflight.delete(key)
  generationByKey.set(key, currentGeneration(key) + 1)
}

/** Status read with in-flight coalesce + short TTL. */
export async function readGitStatusCached(cwd: string): Promise<GitStatusResult> {
  const key = cacheKey(cwd)
  const hit = cache.get(key)
  if (hit && Date.now() <= hit.expiresAt && hit.generation === currentGeneration(key)) {
    return hit.status
  }

  const pending = inflight.get(key)
  if (pending) return pending

  const generation = currentGeneration(key)
  const run = (async () => {
    const status = await readGitStatusUncached(cwd)
    // Drop result if invalidate raced while we were shelling out.
    if (generation === currentGeneration(key)) {
      cache.set(key, { status, expiresAt: Date.now() + TTL_MS, generation })
    }
    return status
  })()

  inflight.set(key, run)
  try {
    return await run
  } finally {
    if (inflight.get(key) === run) inflight.delete(key)
  }
}

/** @internal */
export function resetGitStatusCacheForTests(): void {
  cache.clear()
  inflight.clear()
  generationByKey.clear()
}
