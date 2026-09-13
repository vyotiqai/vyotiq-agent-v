import { useSyncExternalStore } from 'react'

/**
 * Publishes ChatView immersive dock state so Sidebar can hide the session list
 * without prop-drilling through AppShell.
 */
let dockImmersive = false
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function setDockImmersive(next: boolean): void {
  if (dockImmersive === next) return
  dockImmersive = next
  emit()
}

export function getDockImmersive(): boolean {
  return dockImmersive
}

export function subscribeDockImmersive(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useDockImmersive(): boolean {
  return useSyncExternalStore(subscribeDockImmersive, getDockImmersive, () => false)
}

/** Test helper — reset between cases. */
export function resetDockImmersiveStore(): void {
  dockImmersive = false
  listeners.clear()
}
