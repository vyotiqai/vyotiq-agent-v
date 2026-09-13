import { canonicalizeWorkspacePath } from '../../../shared/workspacePath'
import type { SlashCommandDescriptor } from '../../../shared/ipc'

export const LIST_TTL_MS = 5_000

type ListCacheEntry = {
  commands: SlashCommandDescriptor[]
  expiresAt: number
}

const listCache = new Map<string, ListCacheEntry>()
const listInflight = new Map<string, Promise<SlashCommandDescriptor[]>>()

export function listCacheKey(workspacePath?: string | null): string {
  if (!workspacePath?.trim()) return ''
  return canonicalizeWorkspacePath(workspacePath)
}

export function invalidateSlashCommandsCache(workspacePath?: string | null): void {
  if (workspacePath === undefined) {
    listCache.clear()
    listInflight.clear()
    return
  }
  const key = listCacheKey(workspacePath)
  listCache.delete(key)
  listInflight.delete(key)
}

export function getSlashListCacheEntry(
  key: string
): ListCacheEntry | undefined {
  return listCache.get(key)
}

export function setSlashListCacheEntry(key: string, entry: ListCacheEntry): void {
  listCache.set(key, entry)
}

export function getSlashListInflight(
  key: string
): Promise<SlashCommandDescriptor[]> | undefined {
  return listInflight.get(key)
}

export function setSlashListInflight(
  key: string,
  promise: Promise<SlashCommandDescriptor[]>
): void {
  listInflight.set(key, promise)
}

export function clearSlashListInflight(
  key: string,
  promise: Promise<SlashCommandDescriptor[]>
): void {
  if (listInflight.get(key) === promise) listInflight.delete(key)
}
