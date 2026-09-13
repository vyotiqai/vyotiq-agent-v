import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitStatus, GitStatusResult } from '@shared/ipc'

export type GitStatusState = {
  status: GitStatus | null
  /** Discriminated probe result (ok / not_repo / unavailable), or null while loading. */
  result: GitStatusResult | null
  /** IPC / unexpected failure message when the invoke itself failed. */
  error: string | null
  /** True until the first answer arrives, so the bar can stay out of the way. */
  loading: boolean
  refresh: () => void
}

/** Keep git chrome off the open critical path (pty/runs/models first). */
const STARTUP_DEFER_MS = 2_500

/**
 * Track the workspace's git state.
 *
 * Refreshed on demand rather than polled: shelling out to git on a timer costs
 * real work on a large repository, and the interesting moments (a turn ending,
 * a commit landing) are all things the caller already knows about. `enabled`
 * lets a caller skip the work entirely on screens with nowhere to show it.
 *
 * First fetch after enable waits past first paint + idle so it does not contend
 * with pty/runs startup IPC.
 */
export function useGitStatus(
  workspacePath: string | null,
  revision: number,
  enabled = true,
  /** Skip the cold-start idle defer (Changes panel should fetch as soon as it opens). */
  deferStartupMs: number = STARTUP_DEFER_MS
): GitStatusState {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [result, setResult] = useState<GitStatusResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [manualRevision, setManualRevision] = useState(0)
  const requestRef = useRef(0)

  useEffect(() => {
    if (!workspacePath || !enabled) {
      setStatus(null)
      setResult(null)
      setError(null)
      setLoading(false)
      return undefined
    }

    const request = ++requestRef.current
    let cancelled = false
    let idleId: number | undefined
    let timer: ReturnType<typeof setTimeout> | undefined

    const start = (): void => {
      if (cancelled || request !== requestRef.current) return
      setLoading(true)
      void window.vyotiq
        .gitStatus(workspacePath)
        .then((ipcResult) => {
          if (cancelled || request !== requestRef.current) return
          if (!ipcResult.ok) {
            setStatus(null)
            setResult(null)
            setError(ipcResult.error)
            return
          }
          setError(null)
          setResult(ipcResult.data)
          setStatus(ipcResult.data.kind === 'ok' ? ipcResult.data.status : null)
        })
        .catch((err) => {
          if (cancelled) return
          setStatus(null)
          setResult(null)
          setError(err instanceof Error ? err.message : String(err))
        })
        .finally(() => {
          if (!cancelled && request === requestRef.current) setLoading(false)
        })
    }

    const scheduleIdle = (): void => {
      if (cancelled || request !== requestRef.current) return
      if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
        idleId = window.requestIdleCallback(start, { timeout: 2_000 })
      } else {
        start()
      }
    }

    // Manual refresh / revision bumps should not wait for startup deferral.
    const deferStartup = deferStartupMs > 0 && manualRevision === 0 && revision === 0
    if (deferStartup) {
      setLoading(false)
      timer = setTimeout(scheduleIdle, deferStartupMs)
    } else {
      start()
    }

    return () => {
      cancelled = true
      if (idleId != null && typeof window !== 'undefined' && 'cancelIdleCallback' in window) {
        window.cancelIdleCallback(idleId)
      }
      if (timer != null) clearTimeout(timer)
    }
  }, [workspacePath, revision, manualRevision, enabled, deferStartupMs])

  const refresh = useCallback(() => setManualRevision((value) => value + 1), [])

  return { status, result, error, loading, refresh }
}
