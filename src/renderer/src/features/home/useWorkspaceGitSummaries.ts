import { useEffect, useState } from 'react'

export type WorkspaceGitSummary = {
  branch: string | null
  changedFiles: number
}

export function useWorkspaceGitSummaries(
  paths: string[],
  enabled: boolean
): Record<string, WorkspaceGitSummary> {
  const [summaries, setSummaries] = useState<Record<string, WorkspaceGitSummary>>({})
  const pathsKey = enabled ? JSON.stringify([...new Set(paths)]) : ''

  useEffect(() => {
    if (!enabled) return
    let active = true

    const load = (): void => {
      const uniquePaths: string[] = JSON.parse(pathsKey)
      void Promise.all(
        uniquePaths.map(async (workspacePath) => {
          try {
            const result = await window.vyotiq.gitStatus(workspacePath)
            if (!result.ok || result.data.kind !== 'ok') return null
            const status = result.data.status
            const summary: WorkspaceGitSummary = {
              branch: status.branch,
              changedFiles: status.truncated ? status.fileCount : status.files.length
            }
            return [workspacePath, summary] as const
          } catch {
            return null
          }
        })
      ).then((entries) => {
        if (!active) return
        const next: Record<string, WorkspaceGitSummary> = {}
        for (const entry of entries) {
          if (entry) next[entry[0]] = entry[1]
        }
        setSummaries(next)
      })
    }

    load()

    // Event-driven refresh (no timers): the window regaining focus or becoming
    // visible is the signal that the Home surface is being looked at again.
    const onRegainAttention = (): void => {
      if (document.visibilityState === 'visible') load()
    }
    window.addEventListener('focus', onRegainAttention)
    document.addEventListener('visibilitychange', onRegainAttention)
    return () => {
      active = false
      window.removeEventListener('focus', onRegainAttention)
      document.removeEventListener('visibilitychange', onRegainAttention)
    }
  }, [enabled, pathsKey])

  return enabled ? summaries : {}
}
