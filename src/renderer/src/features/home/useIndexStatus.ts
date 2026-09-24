import { useEffect, useState } from 'react'
import type { CodeIndexModelPhase } from '@shared/ipc'

export type IndexStatus = {
  phase: CodeIndexModelPhase
  /** The workspace the phase is about; absent until a sync names one. */
  workspacePath?: string
}

/**
 * The code index's phase, live, and the workspace it belongs to. One status
 * serves every workspace, so `syncing` says that one is being indexed — no
 * other.
 */
export function useIndexStatus(enabled: boolean): IndexStatus | null {
  const [status, setStatus] = useState<IndexStatus | null>(null)

  useEffect(() => {
    const api = window.vyotiq
    if (!enabled || !api?.codeIndexStatus) {
      setStatus(null)
      return
    }
    let live = true
    const take = (next: { phase: CodeIndexModelPhase; workspacePath?: string }): void => {
      if (live) setStatus({ phase: next.phase, ...(next.workspacePath ? { workspacePath: next.workspacePath } : {}) })
    }
    void api.codeIndexStatus().then((res) => {
      if (res.ok) take(res.data)
    })
    const off = typeof api.onCodeIndexStatus === 'function' ? api.onCodeIndexStatus(take) : undefined
    return () => {
      live = false
      off?.()
    }
  }, [enabled])

  return status
}
