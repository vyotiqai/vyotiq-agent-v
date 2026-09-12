import type { CodeIndexRuntimeStatus } from '../../../shared/ipc/schemas/settings'

let status: CodeIndexRuntimeStatus = {
  phase: 'idle',
  progress: null,
  message: null,
  error: null,
  indexProgress: null
}

const listeners = new Set<(s: CodeIndexRuntimeStatus) => void>()

export function getCodeIndexRuntimeStatus(): CodeIndexRuntimeStatus {
  return { ...status, indexProgress: status.indexProgress ? { ...status.indexProgress } : null }
}

export function setCodeIndexRuntimeStatus(partial: Partial<CodeIndexRuntimeStatus>): void {
  status = { ...status, ...partial }
  const snap = getCodeIndexRuntimeStatus()
  for (const fn of listeners) {
    try {
      fn(snap)
    } catch {
      /* ignore listener errors */
    }
  }
}

export function resetCodeIndexRuntimeStatusForTests(): void {
  status = {
    phase: 'idle',
    progress: null,
    message: null,
    error: null,
    indexProgress: null
  }
  listeners.clear()
}

export function onCodeIndexRuntimeStatus(fn: (s: CodeIndexRuntimeStatus) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
