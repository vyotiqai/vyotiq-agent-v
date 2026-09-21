import { useCallback, useRef, useState } from 'react'

export type GitInitState = {
  busy: boolean
  /** The real message from git / the bridge, never a placeholder. */
  error: string | null
  /** Resolves true only when the workspace is a repository afterwards. */
  init: () => Promise<boolean>
}

/**
 * `git init` for a workspace, driven by an explicit user action.
 *
 * Deliberately a hook with no effects: nothing here runs on mount, on
 * workspace open, or on an agent's behalf. The two surfaces that offer it
 * (the empty-session context strip and the Changes panel) both call `init`
 * from a button's onClick and nowhere else.
 */
export function useGitInit(
  workspacePath: string | null | undefined,
  onDone?: () => void
): GitInitState {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // `disabled` only takes effect on the next render, so the guard that makes a
  // double click impossible has to be synchronous.
  const inFlight = useRef(false)

  const init = useCallback(async (): Promise<boolean> => {
    if (!workspacePath || inFlight.current) return false
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      // Bridge surface is versioned — an older preload without the method
      // must say so rather than look like a silently ignored click.
      const request = window.vyotiq.gitInit?.({ workspacePath })
      if (!request) {
        setError('This build cannot initialize repositories')
        return false
      }
      const res = await request
      if (!res.ok) {
        setError(res.error)
        return false
      }
      onDone?.()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not initialize the repository')
      return false
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }, [onDone, workspacePath])

  return { busy, error, init }
}
