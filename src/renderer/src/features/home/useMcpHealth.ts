import { useCallback, useEffect, useRef, useState } from 'react'

export type McpHealthIssue = {
  id: string
  name: string
  /** Connection error the server last reported, when it reported one. */
  error?: string
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
): { issues: McpHealthIssue[]; refresh: () => void } {
  const [issues, setIssues] = useState<McpHealthIssue[]>([])
  const [refreshNonce, setRefreshNonce] = useState(0)
  const generationRef = useRef(0)

  const refresh = useCallback(() => setRefreshNonce((value) => value + 1), [])

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
          .filter((server) => server.enabled && !server.connected)
          .map((server) => ({
            id: server.id,
            name: server.name,
            ...(server.error ? { error: server.error } : {})
          }))
      )
    })
    return () => {
      generationRef.current += 1
    }
  }, [workspacePath, enabled, refreshNonce, refreshVersion])

  return { issues, refresh }
}
