import { useCallback, useSyncExternalStore } from 'react'
import {
  COMPOSER_ATTACHMENT_BUCKET_LIMIT,
  type AttachedAudio,
  type AttachedFile,
  type AttachedNativeFile,
  type ComposerAttachmentsBucket
} from '@shared/ipc'
import { HOT_COMPOSER_DRAFT_KEY } from './workspaceHotUiStore'

/**
 * Per-workspace (and per-run) composer attachments (images, files, audio).
 * Survives Composer remounts on run-tab switches, like the hot-UI draft store,
 * and persists to a workspace sidecar via the main process so pending
 * attachments survive an app restart. Send-time and run-delete clears remove
 * both the memory bucket and its persisted counterpart; workspace-close clears
 * memory only (persisted buckets are restored on re-open, matching drafts).
 */

export type ComposerAttachmentState = {
  images: string[]
  files: AttachedFile[]
  nativeFiles: AttachedNativeFile[]
  audio: AttachedAudio[]
}

const EMPTY_ATTACHMENTS: ComposerAttachmentState = Object.freeze({
  images: [],
  files: [],
  nativeFiles: [],
  audio: []
})

const byKey = new Map<string, ComposerAttachmentState>()
const listenersByKey = new Map<string, Set<() => void>>()

const ATTACHMENT_PERSIST_DEBOUNCE_MS = 300
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** Workspaces whose disk view has been read at least once this session. */
const seededWorkspaces = new Set<string>()

/** Persist key for attachments — mirrors hot composer draft run scoping. */
export function composerAttachmentKey(
  workspacePath: string | null | undefined,
  runId?: string | null
): string | null {
  if (!workspacePath) return null
  return `${workspacePath}::${runId ?? HOT_COMPOSER_DRAFT_KEY}`
}

function notify(key: string): void {
  const listeners = listenersByKey.get(key)
  if (!listeners) return
  for (const listener of listeners) listener()
}

export function getComposerAttachments(key: string | null | undefined): ComposerAttachmentState {
  if (!key) return EMPTY_ATTACHMENTS
  return byKey.get(key) ?? EMPTY_ATTACHMENTS
}

/** Workspace path from a persist key (`{workspacePath}::{runKey}`); null for legacy bare keys. */
function workspaceFromKey(key: string): string | null {
  const idx = key.indexOf('::')
  if (idx <= 0) return null
  return key.slice(0, idx)
}

/** Run key (runId or `__draft__`) from a persist key. */
function runKeyFromPersistKey(key: string): string {
  const idx = key.indexOf('::')
  if (idx < 0) return HOT_COMPOSER_DRAFT_KEY
  return key.slice(idx + 2) || HOT_COMPOSER_DRAFT_KEY
}

function clonePart<T extends object>(part: T): T {
  return { ...part }
}

function bucketFromState(state: ComposerAttachmentState): ComposerAttachmentsBucket {
  return {
    images: state.images.slice(0, COMPOSER_ATTACHMENT_BUCKET_LIMIT),
    files: state.files.slice(0, COMPOSER_ATTACHMENT_BUCKET_LIMIT).map(clonePart),
    nativeFiles: state.nativeFiles.slice(0, COMPOSER_ATTACHMENT_BUCKET_LIMIT).map(clonePart),
    audio: state.audio.slice(0, COMPOSER_ATTACHMENT_BUCKET_LIMIT).map(clonePart)
  }
}

function bucketToState(bucket: ComposerAttachmentsBucket): ComposerAttachmentState {
  return {
    images: [...bucket.images],
    files: bucket.files.map(clonePart),
    nativeFiles: bucket.nativeFiles.map(clonePart),
    audio: bucket.audio.map(clonePart)
  }
}

function isStateEmpty(state: ComposerAttachmentState): boolean {
  return (
    state.images.length === 0 &&
    state.files.length === 0 &&
    state.nativeFiles.length === 0 &&
    state.audio.length === 0
  )
}

/**
 * Push the workspace's in-memory buckets as a whole-map replace — an empty map
 * is a delete on main. Never pushes before the workspace's first successful
 * disk read: a partial in-memory view would replace the sidecar and delete
 * keys that were not seeded yet. After seeding, an empty map is a legitimate
 * "everything was removed".
 */
function pushWorkspace(workspacePath: string): Promise<boolean> {
  const api = typeof window !== 'undefined' ? window.vyotiq : undefined
  if (!api?.setComposerAttachments) return Promise.resolve(false)
  if (!seededWorkspaces.has(workspacePath)) return Promise.resolve(false)
  const buckets: Record<string, ComposerAttachmentsBucket> = {}
  const prefix = `${workspacePath}::`
  for (const [key, state] of byKey) {
    // Legacy bare-path keys predate per-run scoping and are never persisted.
    if (!key.startsWith(prefix)) continue
    if (isStateEmpty(state)) continue
    buckets[runKeyFromPersistKey(key)] = bucketFromState(state)
  }
  return api
    .setComposerAttachments({ workspacePath, buckets })
    .then((res) => res.ok, () => false)
}

function schedulePersist(persistKey: string): void {
  const workspacePath = workspaceFromKey(persistKey)
  if (!workspacePath) return
  const existing = persistTimers.get(workspacePath)
  if (existing) clearTimeout(existing)
  persistTimers.set(
    workspacePath,
    setTimeout(() => {
      persistTimers.delete(workspacePath)
      void pushWorkspace(workspacePath)
    }, ATTACHMENT_PERSIST_DEBOUNCE_MS)
  )
}

/** Push pending debounce timers immediately (beforeunload best-effort). */
export async function flushComposerAttachmentsToDisk(): Promise<void> {
  for (const timer of persistTimers.values()) clearTimeout(timer)
  persistTimers.clear()
  const workspaces = new Set<string>()
  for (const key of byKey.keys()) {
    const workspacePath = workspaceFromKey(key)
    if (workspacePath) workspaces.add(workspacePath)
  }
  await Promise.all([...workspaces].map((ws) => pushWorkspace(ws)))
}

/** Merge persisted buckets into memory without clobbering newer in-memory state. */
export async function seedComposerAttachmentsFromDisk(workspacePath: string): Promise<void> {
  if (seededWorkspaces.has(workspacePath)) return
  const api = typeof window !== 'undefined' ? window.vyotiq : undefined
  if (!api?.getComposerAttachments) return
  const res = await api.getComposerAttachments(workspacePath).catch(() => null)
  if (!res?.ok) return
  seededWorkspaces.add(workspacePath)
  let changed = false
  for (const [runKey, bucket] of Object.entries(res.data.buckets)) {
    const persistKey = `${workspacePath}::${runKey}`
    const existing = byKey.get(persistKey)
    if (existing && !isStateEmpty(existing)) continue
    byKey.set(persistKey, bucketToState(bucket))
    changed = true
  }
  if (!changed) return
  const prefix = `${workspacePath}::`
  for (const key of byKey.keys()) {
    if (key === workspacePath || key.startsWith(prefix)) notify(key)
  }
}

export function setComposerAttachments(
  key: string,
  patch: Partial<ComposerAttachmentState>
): void {
  const prev = byKey.get(key) ?? EMPTY_ATTACHMENTS
  const next: ComposerAttachmentState = {
    images: patch.images !== undefined ? patch.images : prev.images,
    files: patch.files !== undefined ? patch.files : prev.files,
    nativeFiles: patch.nativeFiles !== undefined ? patch.nativeFiles : prev.nativeFiles,
    audio: patch.audio !== undefined ? patch.audio : prev.audio
  }
  const unchanged =
    next.images === prev.images &&
    next.files === prev.files &&
    next.nativeFiles === prev.nativeFiles &&
    next.audio === prev.audio
  if (unchanged && byKey.has(key)) return
  byKey.set(key, next)
  notify(key)
  // Becoming empty must still propagate: a seeded push sends an empty map,
  // which deletes the key on main (user removed the last attachment).
  if (!unchanged) schedulePersist(key)
}

export function clearComposerAttachments(key: string): void {
  const had = byKey.delete(key)
  notify(key)
  if (!had) return
  const workspacePath = workspaceFromKey(key)
  const api = typeof window !== 'undefined' ? window.vyotiq : undefined
  if (workspacePath && api?.clearComposerAttachments) {
    void api.clearComposerAttachments({ workspacePath, key: runKeyFromPersistKey(key) })
  }
}

/**
 * Drop every in-memory attachment bucket for a workspace (all run keys + legacy
 * bare path) and forget its seeded state so a re-open re-reads disk. Persisted
 * buckets are intentionally kept — workspace close must not destroy staged
 * attachments, matching draft-text survival.
 */
export function clearComposerAttachmentsForWorkspace(workspacePath: string): void {
  const prefix = `${workspacePath}::`
  const timer = persistTimers.get(workspacePath)
  if (timer) {
    clearTimeout(timer)
    persistTimers.delete(workspacePath)
  }
  seededWorkspaces.delete(workspacePath)
  const keys = [...byKey.keys()].filter((k) => k === workspacePath || k.startsWith(prefix))
  for (const key of keys) {
    byKey.delete(key)
    notify(key)
  }
}

export function subscribeComposerAttachments(
  key: string | null | undefined,
  listener: () => void
): () => void {
  if (!key) return () => {}
  let set = listenersByKey.get(key)
  if (!set) {
    set = new Set()
    listenersByKey.set(key, set)
  }
  set.add(listener)
  return () => {
    set!.delete(listener)
    if (set!.size === 0) listenersByKey.delete(key)
  }
}

/** Subscribe to one persist-key's composer attachments (no-op when unbound). */
export function useComposerAttachments(key: string | null | undefined): ComposerAttachmentState {
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeComposerAttachments(key, onStoreChange),
    [key]
  )
  const getSnapshot = useCallback(() => getComposerAttachments(key), [key])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Test helper — reset module state between cases. */
export function resetComposerAttachmentStoreForTests(): void {
  for (const timer of persistTimers.values()) clearTimeout(timer)
  persistTimers.clear()
  seededWorkspaces.clear()
  byKey.clear()
  listenersByKey.clear()
}
