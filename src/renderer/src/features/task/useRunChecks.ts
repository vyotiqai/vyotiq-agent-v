import { useEffect, useState } from 'react'
import { DONE_WHEN_CHECKS_FILE, parseDoneWhenChecks, type DoneWhenCheck } from '@shared/doneWhenChecks'
import type { UiItem } from '@shared/transcript'

/**
 * When to read `checks.json` again: `create_plan` and `check_done_when` are
 * the only writers, so the revision moves when one of them settles, and when
 * the run starts or stops (a rewind or a new run can drop checks).
 */
export function checksRevisionOf(items: readonly UiItem[], live: boolean): string {
  let n = 0
  let lastId = ''
  for (const item of items) {
    if (item.kind !== 'tool' || item.tool.status === 'running') continue
    if (item.tool.name !== 'create_plan' && item.tool.name !== 'check_done_when') continue
    n += 1
    lastId = item.id
  }
  return `${n}:${lastId}:${live ? 1 : 0}`
}

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
