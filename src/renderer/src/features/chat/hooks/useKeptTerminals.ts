import { useCallback, useEffect, useState } from 'react'
import type { KeptTerminalInfo } from '@shared/ipc'

/**
 * Background processes the agent left running past its turn (a dev server, a
 * watcher) for one workspace, kept current: main pushes "sessions changed"
 * when one is kept, exits or is stopped.
 */
export function useKeptTerminals(workspacePath: string | null | undefined): {
  kept: KeptTerminalInfo[]
  stop: (id: string) => Promise<void>
} {
  const [kept, setKept] = useState<KeptTerminalInfo[]>([])

  const refresh = useCallback(async () => {
    if (!workspacePath || !window.vyotiq?.terminalKeptList) {
      setKept([])
      return
    }
    const res = await window.vyotiq.terminalKeptList(workspacePath)
    setKept(res?.ok ? res.data : [])
  }, [workspacePath])

  useEffect(() => {
    void refresh()
    return window.vyotiq?.onPtySessionsChanged?.(() => void refresh())
  }, [refresh])

  const stop = useCallback(
    async (id: string) => {
      if (!workspacePath) return
      await window.vyotiq?.terminalKeptStop?.(id, workspacePath)
      await refresh()
    },
    [refresh, workspacePath]
  )

  return { kept, stop }
}
