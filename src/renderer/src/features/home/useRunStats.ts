import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RunStat } from '@shared/ipc'
import type { WorkspaceSidebarRuns } from '@renderer/app/sidebar/types'
import { pinnedRunKey } from './pinnedRuns'

export type HomePageRunStats = Record<string, RunStat>

export type HomeRunStatsState = {
  data: HomePageRunStats
  loading: boolean
  error: string | null
  updatedAt: string | null
  refresh: () => void
}

export function useRunStats(
  openWorkspaces: readonly string[],
  runsByWorkspacePath: Record<string, WorkspaceSidebarRuns>,
  refreshVersion = 0
): HomeRunStatsState {
  const [data, setData] = useState<HomePageRunStats>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const generationRef = useRef(0)

  const requests = useMemo(() => {
    const out: Array<{ workspacePath: string; runIds: string[] }> = []
    for (const workspacePath of openWorkspaces) {
      const runIds = (runsByWorkspacePath[workspacePath]?.runs ?? []).map((run) => run.runId)
      if (runIds.length > 0) out.push({ workspacePath, runIds })
    }
    return out
  }, [openWorkspaces, runsByWorkspacePath])

  const requestKey = useMemo(
    () =>
      requests
        .map((request) => `${request.workspacePath}\u0000${request.runIds.join('\u0000')}`)
        .join('\u0001'),
    [requests]
  )

  // Latest-ref pattern: the fetch effect keys on requestKey (a stable string), so a
  // fresh `requests` array identity from an unrelated re-render must not re-fire
  // the IPC batch on every render.
  const requestsRef = useRef(requests)
  requestsRef.current = requests

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
    const api = window.vyotiq?.runStats
    if (!api || requestKey === '') {
      setLoading(false)
      if (requestKey === '') {
        setData({})
        setError(null)
      }
      return
    }

    const generation = ++generationRef.current
    setLoading(true)
    void Promise.all(
      requestsRef.current.map(async (request) => {
        const result = await api(request)
        return { request, result }
      })
    ).then((results) => {
      if (generation !== generationRef.current) return
      const next: HomePageRunStats = {}
      const failures: string[] = []
      for (const { request, result } of results) {
        if (!result.ok) {
          failures.push(result.error)
          continue
        }
        for (const stat of result.data.stats) {
          next[pinnedRunKey(request.workspacePath, stat.runId)] = stat
        }
      }
      setData(next)
      setError(failures.length > 0 ? failures[0]! : null)
      setUpdatedAt(new Date().toISOString())
      setLoading(false)
    })

    return () => {
      generationRef.current += 1
    }
  }, [requestKey, refreshNonce, refreshVersion])

  return { data, loading, error, updatedAt, refresh }
}
