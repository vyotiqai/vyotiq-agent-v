import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export type WorkspaceGitSummary = {
  branch: string | null
  changedFiles: number
  ahead?: number
  behind?: number
  topFiles?: Array<{ path: string; lines: number }>
}

export type WorkspaceGitSummaryState = {
  data: Record<string, WorkspaceGitSummary>
  loading: boolean
  errors: Record<string, string>
  updatedAt: string | null
  refresh: () => void
}

export function useWorkspaceGitSummaries(
  paths: string[],
  enabled: boolean,
  refreshVersion = 0
): WorkspaceGitSummaryState {
  const [data, setData] = useState<Record<string, WorkspaceGitSummary>>({})
  const [loading, setLoading] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const generationRef = useRef(0)
  const pathsKey = enabled ? JSON.stringify([...new Set(paths)]) : ''
  const uniquePaths = useMemo<string[]>(() => (pathsKey ? JSON.parse(pathsKey) : []), [pathsKey])
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
    if (!enabled || pathsKey === '') {
      setData({})
      setErrors({})
      setLoading(false)
      return
    }
    const generation = ++generationRef.current
    setLoading(true)
    void Promise.all(
      uniquePaths.map(async (workspacePath) => {
        try {
          const result = await window.vyotiq.gitStatus(workspacePath)
          if (!result.ok) return { workspacePath, error: result.error }
          if (result.data.kind !== 'ok') {
            return { workspacePath, error: 'Repository status unavailable' }
          }
          const status = result.data.status
          const summary: WorkspaceGitSummary = {
            branch: status.branch,
            changedFiles: status.truncated ? status.fileCount : status.files.length,
            ...(status.ahead != null && status.behind != null
              ? { ahead: status.ahead, behind: status.behind }
              : {}),
            ...(status.truncated
              ? {}
              : {
                  topFiles: status.files
                    .map((file) => ({ path: file.path, lines: file.added + file.removed }))
                    .filter((file) => file.lines > 0)
                    .sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path))
                    .slice(0, 3)
                })
          }
          if (summary.topFiles?.length === 0) delete summary.topFiles
          return { workspacePath, summary }
        } catch (cause) {
          return {
            workspacePath,
            error: cause instanceof Error ? cause.message : 'Repository status unavailable'
          }
        }
      })
    ).then((entries) => {
      if (generation !== generationRef.current) return
      const nextData: Record<string, WorkspaceGitSummary> = {}
      const nextErrors: Record<string, string> = {}
      for (const entry of entries) {
        if (entry.summary) nextData[entry.workspacePath] = entry.summary
        if (entry.error) nextErrors[entry.workspacePath] = entry.error
      }
      setData(nextData)
      setErrors(nextErrors)
      setUpdatedAt(new Date().toISOString())
      setLoading(false)
    })
    return () => {
      generationRef.current += 1
    }
  }, [enabled, pathsKey, refreshNonce, refreshVersion, uniquePaths])

  return { data: enabled ? data : {}, loading, errors, updatedAt, refresh }
}
