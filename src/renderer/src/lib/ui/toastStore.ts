import { useCallback, useSyncExternalStore } from 'react'

/**
 * Global transient notifications. One surface for app-level notices that do
 * not belong to a specific view — auto-dismiss, stacked, screen-reader live.
 */

export type ToastKind = 'info' | 'success' | 'error'

export type ToastItem = {
  id: number
  kind: ToastKind
  message: string
  onClick?: () => void
  durationMs: number
  /** Timestamp when the toast will auto-dismiss. Null while paused. */
  expiresAt: number | null
  /** Remaining milliseconds when paused. */
  remainingMs: number
}

const MAX_TOASTS = 4
const DEFAULT_DURATION_MS = 6000

let nextId = 1
let toasts: ToastItem[] = []
const listeners = new Set<() => void>()
const timers = new Map<number, ReturnType<typeof setTimeout>>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function dismissToast(id: number): void {
  const timer = timers.get(id)
  if (timer) {
    clearTimeout(timer)
    timers.delete(id)
  }
  if (!toasts.some((t) => t.id === id)) return
  toasts = toasts.filter((t) => t.id !== id)
  emit()
}

export function pauseToast(id: number): void {
  const toast = toasts.find((t) => t.id === id)
  if (!toast || toast.durationMs <= 0 || toast.expiresAt == null) return
  const timer = timers.get(id)
  if (timer) {
    clearTimeout(timer)
    timers.delete(id)
  }
  toast.remainingMs = Math.max(0, toast.expiresAt - Date.now())
  toast.expiresAt = null
  emit()
}

export function resumeToast(id: number): void {
  const toast = toasts.find((t) => t.id === id)
  if (!toast || toast.durationMs <= 0 || toast.expiresAt != null) return
  toast.expiresAt = Date.now() + toast.remainingMs
  timers.set(id, setTimeout(() => dismissToast(id), toast.remainingMs))
  emit()
}

export function pushToast(
  message: string,
  kind: ToastKind = 'info',
  durationMs = DEFAULT_DURATION_MS,
  onClick?: () => void
): number {
  const text = message.trim()
  if (!text) return -1
  const id = nextId++
  // Replace an identical visible toast instead of stacking duplicates.
  const dupe = toasts.find((t) => t.message === text && t.kind === kind)
  if (dupe) {
    dismissToast(dupe.id)
  }
  const now = Date.now()
  const item: ToastItem = {
    id,
    kind,
    message: text,
    durationMs,
    expiresAt: durationMs > 0 ? now + durationMs : null,
    remainingMs: durationMs > 0 ? durationMs : 0,
    ...(onClick ? { onClick } : {})
  }
  toasts = [...toasts, item].slice(-MAX_TOASTS)
  if (durationMs > 0) {
    timers.set(id, setTimeout(() => dismissToast(id), durationMs))
  }
  emit()
  return id
}

export function getToasts(): readonly ToastItem[] {
  return toasts
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useToasts(): readonly ToastItem[] {
  const subscribe = useCallback((onStoreChange: () => void) => subscribeToasts(onStoreChange), [])
  return useSyncExternalStore(subscribe, getToasts, getToasts)
}

/** Test helper — clear toasts, timers, and listeners between cases. */
export function resetToastStoreForTests(): void {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  toasts = []
  listeners.clear()
}
