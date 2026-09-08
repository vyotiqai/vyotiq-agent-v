import { useEffect, useMemo, useRef, useState } from 'react'
import type { RunStat } from '@shared/ipc'
import type { WorkspaceSidebarRuns } from '@renderer/app/sidebar/types'

export type HomePageRunStats = Record<string, RunStat>

/**
 * One-shot real usage stats for the displayed parent sessions — one request per
 * open workspace, refetched only when the displayed run-id set changes. No
 * polling; no bridge (tests, missing main) → empty map and the strip stays
 * hidden rather than zero-filled.
 */
export function useRunStats(
  openWorkspaces: readonly string[],
  runsByWorkspacePath: Record<string, WorkspaceSidebarRuns>
): HomePageRunStats {
  const [stats, setStats] = useState<HomePageRunStats>({})

  const requests = useMemo(() => {
    const out: Array<{ workspacePath: string; runIds: string[] }> = []
    for (const workspacePath of openWorkspaces) {
      const runIds = (runsByWorkspacePath[workspacePath]?.runs ?? []).map((r) => r.runId)
      if (runIds.length > 0) out.push({ workspacePath, runIds })
    }
    return out
  }, [openWorkspaces, runsByWorkspacePath])

  const requestKey = useMemo(
    () =>
      requests
        .map((req) => `${req.workspacePath}\u0000${req.runIds.join('\u0000')}`)
        .join('\u0001'),
    [requests]
  )

  const requestsRef = useRef(requests)
  requestsRef.current = requests

  useEffect(() => {
    const api = window.vyotiq?.runStats
    if (!api || requestKey === '') return
    let cancelled = false
    void (async () => {
      const results = await Promise.all(
        requestsRef.current.map(async (req) => {
          const res = await api({ workspacePath: req.workspacePath, runIds: req.runIds })
          return res.ok ? res.data.stats : []
        })
      )
      if (cancelled) return
      const next: HomePageRunStats = {}
      for (const list of results) {
        for (const stat of list) next[stat.runId] = stat
      }
      setStats(next)
    })()
    return () => {
      cancelled = true
    }
  }, [requestKey])

  return stats
}
