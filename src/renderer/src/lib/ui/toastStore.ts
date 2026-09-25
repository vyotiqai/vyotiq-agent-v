import { useCallback, useSyncExternalStore } from 'react'
import type { IconName } from '@renderer/lib/icons'
import type { TaskState } from './StatusGlyph'

/**
 * Global transient notifications. One surface for app-level notices that do
 * not belong to a specific view — auto-dismiss, stacked, screen-reader live.
 */

export type ToastKind = 'info' | 'success' | 'error'

/** A button on the toast; pressing it also dismisses the toast. */
export type ToastAction = { label: string; onClick: () => void }

export type ToastItem = {
  id: number
  kind: ToastKind
  /** The toast's line, or its title when it has a detail. */
  message: string
  /** A second, quieter line: what the title is about. */
  detail?: string
  /** A task's state, drawn as the navigator draws it, in place of the kind's mark. */
  state?: TaskState
  /** A mark for what the toast is about, in place of the kind's. */
  icon?: IconName
  action?: ToastAction
  onClick?: () => void
  durationMs: number
  /** Timestamp when the toast will auto-dismiss. Null while paused. */
  expiresAt: number | null
  /** Remaining milliseconds when paused. */
  remainingMs: number
}

export type ToastOptions = {
  kind?: ToastKind
  detail?: string
  state?: TaskState
  icon?: IconName
  action?: ToastAction
  durationMs?: number
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

/** Replace one toast, so the snapshot changes and the host redraws it. */
function update(id: number, patch: Partial<ToastItem>): void {
  toasts = toasts.map((t) => (t.id === id ? { ...t, ...patch } : t))
  emit()
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
  update(id, { remainingMs: Math.max(0, toast.expiresAt - Date.now()), expiresAt: null })
}

export function resumeToast(id: number): void {
  const toast = toasts.find((t) => t.id === id)
  if (!toast || toast.durationMs <= 0 || toast.expiresAt != null) return
  timers.set(id, setTimeout(() => dismissToast(id), toast.remainingMs))
  update(id, { expiresAt: Date.now() + toast.remainingMs })
}

/**
 * Show a toast. The short form is a line of text; the options form adds a
 * detail line, a task state or icon, and an action button.
 */
export function pushToast(message: string, kind?: ToastKind, durationMs?: number, onClick?: () => void): number
export function pushToast(message: string, options: ToastOptions): number
export function pushToast(
  message: string,
  kindOrOptions: ToastKind | ToastOptions = 'info',
  durationMsArg = DEFAULT_DURATION_MS,
  onClick?: () => void
): number {
  const options: ToastOptions =
    typeof kindOrOptions === 'string' ? { kind: kindOrOptions, durationMs: durationMsArg } : kindOrOptions
  const kind = options.kind ?? 'info'
  const durationMs = options.durationMs ?? DEFAULT_DURATION_MS
  const text = message.trim()
  if (!text) return -1
  const detail = options.detail?.trim() || undefined
  const id = nextId++
  // Replace an identical visible toast instead of stacking duplicates.
  const dupe = toasts.find((t) => t.message === text && t.kind === kind && t.detail === detail)
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
    ...(detail ? { detail } : {}),
    ...(options.state ? { state: options.state } : {}),
    ...(options.icon ? { icon: options.icon } : {}),
    ...(options.action ? { action: options.action } : {}),
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
