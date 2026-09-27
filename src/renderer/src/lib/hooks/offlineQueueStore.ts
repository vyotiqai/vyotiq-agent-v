import type { AttachedFile, ComposerSendExtras } from '@shared/ipc'
import { logger } from '@shared/logger'

export type OfflineQueuedSend = {
  id: string
  text: string
  images?: string[]
  files?: AttachedFile[]
  extras?: ComposerSendExtras
  /** Pane/run that queued the send — flush must not use whatever is focused later. */
  runId?: string | null
  /** Stable pane id so a draft can flush after it is promoted to a real run. */
  paneId?: string
  /** Workspace that owned the send — do not substitute the focused workspace. */
  workspacePath?: string
  queuedAt: string
}

export type OfflineFlushPane = {
  paneId: string
  workspacePath: string
  runId: string | null
}

/**
 * Resolve the controller binding for an offline flush.
 * Never falls back to the currently focused pane for `runId: null`.
 */
export function resolveOfflineFlushTarget(
  entry: OfflineQueuedSend,
  panes: readonly OfflineFlushPane[],
  fallbackWorkspacePath?: string
): { workspacePath: string; runId: string | null } | null {
  if (entry.paneId) {
    const pane = panes.find((p) => p.paneId === entry.paneId)
    if (pane) {
      return { workspacePath: pane.workspacePath, runId: pane.runId }
    }
  }
  if (typeof entry.runId === 'string' && entry.runId.length > 0) {
    const path = entry.workspacePath || fallbackWorkspacePath
    if (typeof path === 'string' && path.length > 0) {
      return { workspacePath: path, runId: entry.runId }
    }
  }
  return null
}

function storageKey(workspacePath: string): string {
  return `vyotiq.offlineQueue.${encodeURIComponent(workspacePath)}`
}

/**
 * In-memory fallback for quota/AV-blocked localStorage writes: a silently
 * dropped queue lost the user's typed message for the whole session even
 * though the UI acknowledged it. The fallback survives until reload — still
 * better than losing the send entirely — and readQueue prefers disk.
 */
const memoryFallback = new Map<string, OfflineQueuedSend[]>()

/** A reader that is replaced on every write, so React sees each change. */
export type OfflineQueueSnapshot = {
  readonly version: number
  list: (workspacePath: string) => OfflineQueuedSend[]
}

/**
 * Replaced on every write, so the line can show what is waiting without
 * polling localStorage: a queued instruction used to vanish from the line with
 * no sign it had been kept.
 */
let snapshot: OfflineQueueSnapshot = { version: 0, list: (workspacePath) => readQueue(workspacePath) }
const listeners = new Set<() => void>()

function notifyQueueChanged(): void {
  snapshot = { version: snapshot.version + 1, list: (workspacePath) => readQueue(workspacePath) }
  for (const listener of listeners) listener()
}

export function subscribeOfflineQueue(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function offlineQueueSnapshot(): OfflineQueueSnapshot {
  return snapshot
}

function readQueue(workspacePath: string): OfflineQueuedSend[] {
  if (!workspacePath || typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(storageKey(workspacePath))
    if (!raw) return memoryFallback.get(workspacePath) ?? []
    const parsed = JSON.parse(raw) as OfflineQueuedSend[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return memoryFallback.get(workspacePath) ?? []
  }
}

function writeQueue(workspacePath: string, queue: OfflineQueuedSend[]): boolean {
  if (!workspacePath || typeof localStorage === 'undefined') return false
  try {
    return writeQueueUnnotified(workspacePath, queue)
  } finally {
    notifyQueueChanged()
  }
}

function writeQueueUnnotified(workspacePath: string, queue: OfflineQueuedSend[]): boolean {
  try {
    if (queue.length === 0) {
      localStorage.removeItem(storageKey(workspacePath))
      memoryFallback.delete(workspacePath)
      return true
    }
    localStorage.setItem(storageKey(workspacePath), JSON.stringify(queue))
    memoryFallback.delete(workspacePath)
    return true
  } catch (err) {
    memoryFallback.set(workspacePath, queue)
    logger.warn('Offline queue localStorage write failed; kept in memory for this session', {
      scope: 'offline-queue',
      err
    })
    return true
  }
}

export function offlineQueueLength(workspacePath: string): number {
  return readQueue(workspacePath).length
}

/** Drop one waiting send; false when it was already sent or removed. */
export function removeOfflineMessage(workspacePath: string, id: string): boolean {
  const queue = readQueue(workspacePath)
  const next = queue.filter((entry) => entry.id !== id)
  if (next.length === queue.length) return false
  return writeQueue(workspacePath, next)
}

/** Change a waiting send's text, keeping its attachments and binding. */
export function editOfflineMessage(workspacePath: string, id: string, text: string): boolean {
  const queue = readQueue(workspacePath)
  if (!queue.some((entry) => entry.id === id)) return false
  return writeQueue(
    workspacePath,
    queue.map((entry) => (entry.id === id ? { ...entry, text } : entry))
  )
}

export function enqueueOfflineMessage(
  workspacePath: string,
  payload: Omit<OfflineQueuedSend, 'id' | 'queuedAt'>
): OfflineQueuedSend | null {
  const entry: OfflineQueuedSend = {
    ...payload,
    id: crypto.randomUUID(),
    queuedAt: new Date().toISOString()
  }
  return writeQueue(workspacePath, [...readQueue(workspacePath), entry]) ? entry : null
}

export function peekOfflineQueue(workspacePath: string): OfflineQueuedSend | null {
  return readQueue(workspacePath)[0] ?? null
}

export function dequeueOfflineMessage(workspacePath: string): OfflineQueuedSend | null {
  const queue = readQueue(workspacePath)
  if (queue.length === 0) return null
  const [head, ...rest] = queue
  writeQueue(workspacePath, rest)
  return head ?? null
}

export function clearOfflineQueue(workspacePath: string): void {
  writeQueue(workspacePath, [])
}

/** Drop queued sends bound to a deleted run (null/undefined entries are kept). */
export function removeOfflineQueueEntriesForRun(
  workspacePath: string,
  runId: string
): void {
  if (!workspacePath || !runId) return
  const next = readQueue(workspacePath).filter((entry) => entry.runId !== runId)
  writeQueue(workspacePath, next)
}

/** Test helper: clear the in-memory fallback so cases are isolated. */
export function resetOfflineQueueMemoryForTests(): void {
  memoryFallback.clear()
}
