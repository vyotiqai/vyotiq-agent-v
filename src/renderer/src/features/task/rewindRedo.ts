import { useCallback, useEffect, useState } from 'react'
import type { RewindRedoStatus } from '@shared/ipc'
import { pushToast } from '@renderer/lib/ui'

/** Ask App to read a task's record from disk again — after Redo rewrote it there. */
export const RELOAD_RUN_EVENT = 'vyotiq:reload-run'
export type ReloadRunDetail = { workspacePath: string; runId: string }

/**
 * A rewind finished in main. The record shows the rewind before main is done
 * with it, so whether it can be redone is only worth asking after this.
 */
export const REWOUND_EVENT = 'vyotiq:rewound'

export function announceRewound(workspacePath: string, runId: string): void {
  window.dispatchEvent(new CustomEvent<ReloadRunDetail>(REWOUND_EVENT, { detail: { workspacePath, runId } }))
}

/**
 * Redo the task's last rewind: main puts the record and the files back while
 * nothing has changed since, then the record is read again. False (with the
 * reason said) when it could not.
 */
export async function redoRewindAndReload(workspacePath: string, runId: string): Promise<boolean> {
  const redo = window.vyotiq?.redoRewind
  if (!redo) return false
  const res = await redo(workspacePath, runId)
  if (!res.ok) {
    pushToast(`Couldn’t redo: ${res.error}`, 'error')
    return false
  }
  window.dispatchEvent(new CustomEvent<ReloadRunDetail>(RELOAD_RUN_EVENT, { detail: { workspacePath, runId } }))
  pushToast('Redone — the rewound runs and their files are back', { icon: 'redo' })
  return true
}

/**
 * Whether this task's last rewind can still be redone. Asked again when the
 * record changes (`revision`) and when the window regains focus — a file
 * changed elsewhere ends it — and never while the task runs.
 */
export function useRewindRedo(
  workspacePath: string | null,
  runId: string | null,
  revision: number,
  live: boolean
): { redo: Extract<RewindRedoStatus, { available: true }> | null; busy: boolean; onRedo: () => void } {
  const [status, setStatus] = useState<RewindRedoStatus | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    const ask = window.vyotiq?.rewindRedoStatus
    if (!workspacePath || !runId || live || !ask) {
      setStatus(null)
      return
    }
    const res = await ask(workspacePath, runId)
    setStatus(res.ok ? res.data : null)
  }, [workspacePath, runId, live])

  useEffect(() => {
    void refresh()
  }, [refresh, revision])

  useEffect(() => {
    const onFocus = (): void => void refresh()
    const onRewound = (event: Event): void => {
      if ((event as CustomEvent<ReloadRunDetail>).detail?.runId === runId) void refresh()
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener(REWOUND_EVENT, onRewound)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener(REWOUND_EVENT, onRewound)
    }
  }, [refresh, runId])

  const onRedo = useCallback(() => {
    if (!workspacePath || !runId || busy) return
    setBusy(true)
    void redoRewindAndReload(workspacePath, runId)
      .then((done) => {
        if (done) setStatus(null)
        else void refresh()
      })
      .finally(() => setBusy(false))
  }, [workspacePath, runId, busy, refresh])

  return { redo: status?.available ? status : null, busy, onRedo }
}
