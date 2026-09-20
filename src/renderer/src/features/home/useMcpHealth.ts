import { useCallback, useEffect, useRef, useState } from 'react'
import type { McpServerStatus } from '@shared/ipc'

export type McpHealthIssue = {
  id: string
  name: string
  /** Connection error the server last reported, when it reported one. */
  error?: string
  /** What kind of failure it is, so the row can offer the matching control. */
  errorKind?: McpServerStatus['errorKind']
}

/**
 * Enabled MCP servers that are not connected, for the active workspace scope
 * (`mcpStatus` with a workspace path resolves that workspace's overrides).
 * This is a read of already-known connection state — it never dials a server,
 * so it is safe to call whenever Home mounts or regains attention.
 */
export function useMcpHealth(
  workspacePath: string | null,
  enabled: boolean,
  refreshVersion = 0
): { issues: McpHealthIssue[]; refresh: () => void; retry: () => Promise<void> } {
  const [issues, setIssues] = useState<McpHealthIssue[]>([])
  const [refreshNonce, setRefreshNonce] = useState(0)
  const generationRef = useRef(0)

  const refresh = useCallback(() => setRefreshNonce((value) => value + 1), [])

  /**
   * Unlike `refresh`, this one dials: `mcpRefresh` drops the sessions and
   * reconnects. It is only ever called from a button the user pressed.
   */
  const retry = useCallback(async (): Promise<void> => {
    try {
      await window.vyotiq?.mcpRefresh?.({ workspacePath })
    } finally {
      refresh()
    }
  }, [refresh, workspacePath])

  useEffect(() => {
    const onRegainAttention = (): void => {
      if (document.visibilityState === 'visible') refresh()
    }
    window.addEventListener('focus', onRegainAttention)
    document.addEventListener('visibilitychange', onRegainAttention)
    return () => {
      window.removeEventListener('focus', onRegainAttention)
      document.removeEventListener('visibilitychange', onRegainAttention)
    }
  }, [refresh])

  useEffect(() => {
    const api = window.vyotiq?.mcpStatus
    if (!api || !enabled) {
      setIssues([])
      return
    }
    const generation = ++generationRef.current
    void api({ workspacePath }).then((result) => {
      if (generation !== generationRef.current) return
      if (!result.ok) {
        // A failed status read is not evidence that a server is down.
        setIssues([])
        return
      }
      setIssues(
        result.data.servers
          // A connect still in flight is not a fault. Without this the first
          // seconds of a launch render every enabled server as broken.
          .filter((server) => server.enabled && !server.connected && !server.connecting)
          .map((server) => ({
            id: server.id,
            name: server.name,
            ...(server.error ? { error: server.error } : {}),
            ...(server.errorKind ? { errorKind: server.errorKind } : {})
          }))
      )
    })
    return () => {
      generationRef.current += 1
    }
  }, [workspacePath, enabled, refreshNonce, refreshVersion])

  return { issues, refresh, retry }
}
