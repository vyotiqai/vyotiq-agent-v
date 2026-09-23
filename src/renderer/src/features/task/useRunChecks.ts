import { useEffect, useState } from 'react'
import { DONE_WHEN_CHECKS_FILE, parseDoneWhenChecks, type DoneWhenCheck } from '@shared/doneWhenChecks'

/**
 * The run's done-when checks from `checks.json`. Only `create_plan` and
 * `check_done_when` write that file during a run, so the caller bumps
 * `revision` when one of them finishes (and on a rewind) instead of polling.
 */
export function useRunChecks(workspacePath: string | null, runId: string | null, revision: string): DoneWhenCheck[] {
  const [checks, setChecks] = useState<DoneWhenCheck[]>([])
  useEffect(() => {
    if (!workspacePath || !runId || !window.vyotiq?.readRunArtifact) {
      setChecks([])
      return undefined
    }
    let cancelled = false
    void window.vyotiq
      .readRunArtifact({ workspacePath, runId, name: DONE_WHEN_CHECKS_FILE })
      .then((res) => {
        if (cancelled) return
        setChecks(res.ok && res.data.exists ? parseDoneWhenChecks(res.data.content) : [])
      })
      .catch(() => {
        if (!cancelled) setChecks([])
      })
    return () => {
      cancelled = true
    }
  }, [workspacePath, runId, revision])
  return checks
}
