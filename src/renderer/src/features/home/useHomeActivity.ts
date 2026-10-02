import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { HomeActivityResult } from '@shared/ipc'

/** Request cap from `HomeActivityRequestSchema` — extra workspaces are dropped. */
export const ACTIVITY_WORKSPACE_CAP = 12
const WORKSPACE_CAP = ACTIVITY_WORKSPACE_CAP

export type ActivityWindowDays = 7 | 30

export type HomeActivityOptions = {
  /** Last local day (YYYY-MM-DD) of a custom range; absent ends the window today. */
  endDay?: string
  /** Per-workspace and per-task totals (the Usage page). */
  breakdown?: boolean
}

export type HomeActivityState = {
  data: HomeActivityResult | null
  loading: boolean
  error: string | null
  refresh: () => void
}

/**
 * Aggregate usage for the open workspaces over a local-day window, read from
 * persisted run receipts and per-step usage ledgers by the main process. One
 * fetch per window change plus a refetch when the window regains attention —
 * no polling. Absent bridge or a failed read leaves `data` null so the panel
 * can say so instead of rendering zeros.
 */
export function useHomeActivity(
  openWorkspaces: readonly string[],
  windowDays: number,
  refreshVersion = 0,
  options: HomeActivityOptions = {}
): HomeActivityState {
  const { endDay, breakdown } = options
  const [data, setData] = useState<HomeActivityResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const generationRef = useRef(0)

  const paths = useMemo(
    () => [...new Set(openWorkspaces)].slice(0, WORKSPACE_CAP),
    [openWorkspaces]
  )
  const pathsKey = paths.join('\0')
  const pathsRef = useRef(paths)
  pathsRef.current = paths

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
    const api = window.vyotiq?.homeActivity
    if (!api || pathsKey === '') {
      setData(null)
      setError(null)
      setLoading(false)
      return
    }

    const generation = ++generationRef.current
    setLoading(true)
    void api({
      workspacePaths: pathsRef.current,
      windowDays,
      ...(endDay ? { endDay } : {}),
      ...(breakdown ? { breakdown: true } : {})
    }).then((result) => {
      if (generation !== generationRef.current) return
      if (result.ok) {
        setData(result.data)
        setError(null)
      } else {
        setData(null)
        setError(result.error)
      }
      setLoading(false)
    }, (err: unknown) => {
      // A rejected bridge call would otherwise leave "Reading receipts…" up for good.
      if (generation !== generationRef.current) return
      setData(null)
      setError(err instanceof Error ? err.message : String(err))
      setLoading(false)
    })

    return () => {
      generationRef.current += 1
    }
  }, [pathsKey, windowDays, endDay, breakdown, refreshNonce, refreshVersion])

  return { data, loading, error, refresh }
}
