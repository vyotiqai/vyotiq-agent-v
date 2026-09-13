import type { ListRunsResult } from '../../shared/ipc'

const LIST_RUNS_CACHE_TTL_MS = 3_000

type ListRunsCacheEntry = {
  result: ListRunsResult
  builtAt: number
}

const listRunsCache = new Map<string, ListRunsCacheEntry>()
const listRunsInflight = new Map<string, Promise<ListRunsResult>>()

export function invalidateListRunsCache(workspacePath?: string): void {
  if (workspacePath) {
    listRunsCache.delete(workspacePath)
    listRunsInflight.delete(workspacePath)
    return
  }
  listRunsCache.clear()
  listRunsInflight.clear()
}

export function resetListRunsCacheForTests(): void {
  invalidateListRunsCache()
}

export async function getCachedListRuns(
  workspacePath: string,
  load: () => Promise<ListRunsResult>
): Promise<ListRunsResult> {
  const cached = listRunsCache.get(workspacePath)
  if (cached && Date.now() - cached.builtAt < LIST_RUNS_CACHE_TTL_MS) {
    return cached.result
  }

  const inflight = listRunsInflight.get(workspacePath)
  if (inflight) return inflight

  const promise = load()
    .then((result) => {
      listRunsCache.set(workspacePath, {
        result,
        builtAt: Date.now()
      })
      return result
    })
    .finally(() => {
      listRunsInflight.delete(workspacePath)
    })
  listRunsInflight.set(workspacePath, promise)
  return promise
}
