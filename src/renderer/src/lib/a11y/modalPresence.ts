import { useSyncExternalStore } from 'react'

/**
 * How many modal dialogs are open. The agent browser is a native view painted
 * above the page's DOM, so while any modal is up the browser panel hides it —
 * otherwise a centred dialog (an image preview, a confirm) draws underneath.
 */
let openCount = 0
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/** Mark one modal open; call the returned function once when it closes. */
export function retainModal(): () => void {
  openCount += 1
  emit()
  let released = false
  return () => {
    if (released) return
    released = true
    openCount = Math.max(0, openCount - 1)
    emit()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function snapshot(): boolean {
  return openCount > 0
}

export function useAnyModalOpen(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
