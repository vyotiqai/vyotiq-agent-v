import { CodeIndexStore } from './store'

type CacheEntry = { store: CodeIndexStore; workspaceRoot: string }

const cache = new Map<string, CacheEntry>()

export function workspaceKey(workspaceRoot: string): string {
  return process.platform === 'win32' ? workspaceRoot.toLowerCase() : workspaceRoot
}

function cacheKey(workspaceRoot: string): string {
  return workspaceKey(workspaceRoot)
}

/** Open (and cache) the per-workspace store; one SQLite handle per workspace. */
export function getOrOpenCodeIndexStore(workspaceRoot: string): CodeIndexStore {
  const key = cacheKey(workspaceRoot)
  const existing = cache.get(key)
  if (existing) return existing.store
  const store = CodeIndexStore.open(workspaceRoot)
  cache.set(key, { store, workspaceRoot })
  return store
}

export function closeCodeIndexStore(workspaceRoot?: string): void {
  if (workspaceRoot == null) {
    for (const [, v] of cache) v.store.close()
    cache.clear()
    return
  }
  const key = cacheKey(workspaceRoot)
  const entry = cache.get(key)
  if (entry) {
    entry.store.close()
    cache.delete(key)
  }
}
