import { useCallback, useEffect, useState } from 'react'
import type { WorkspaceAgentContextResult } from '@shared/ipc/schemas/agent'
import { workspacePathsEqual } from '@shared/workspacePathMatch'

/**
 * What the agent will see in a workspace — branch, rules, memory, index —
 * read once, then kept current by main's push whenever one of the watched
 * paths changes it. No polling. `failed` means the bridge could not answer;
 * callers then show nothing rather than a guess.
 */
export function useAgentContext(workspacePath: string | null): {
  context: WorkspaceAgentContextResult | null
  failed: boolean
  /** Read again now, e.g. after `git init`, which a watcher may not carry. */
  reload: () => void
} {
  const [context, setContext] = useState<WorkspaceAgentContextResult | null>(null)
  const [failed, setFailed] = useState(false)
  // Bumped to re-run the read below. Re-running it rather than firing a second
  // fetch keeps one code path, with its cancelled/pushed guards, as the only
  // thing that writes `context`.
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    setContext(null)
    setFailed(false)
    if (!workspacePath) return undefined
    let cancelled = false
    let pushed = false

    // Subscribe before requesting, so a change landing while the first read is
    // in flight is not lost. Panes can show different workspaces, so filter.
    const off = window.vyotiq.onAgentContextChanged?.((payload) => {
      if (cancelled || !workspacePathsEqual(payload.workspacePath, workspacePath)) return
      pushed = true
      setFailed(false)
      setContext(payload.context)
    })
    const stop = (): void => {
      cancelled = true
      off?.()
    }

    // Bridge surface is versioned — an older/partial preload without the
    // method must render nothing (never throw inside the effect).
    const request = window.vyotiq.agentContext?.({ workspacePath })
    if (!request) {
      setFailed(true)
      return stop
    }
    request
      .then((res) => {
        // A push that got here first is newer than this reply — never regress.
        if (cancelled || pushed) return
        if (res.ok) setContext(res.data)
        else setFailed(true)
      })
      .catch(() => {
        if (!cancelled && !pushed) setFailed(true)
      })
    return stop
  }, [workspacePath, reloadToken])

  const reload = useCallback(() => setReloadToken((token) => token + 1), [])
  return { context, failed, reload }
}
