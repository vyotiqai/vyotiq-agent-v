import { useEffect, useRef, useState } from 'react'
import type { ActiveRun, AgentQuestionRequest, ToolApprovalRequest } from '@shared/ipc'

export type PendingAsk =
  | { kind: 'approval'; request: ToolApprovalRequest }
  | { kind: 'question'; request: AgentQuestionRequest }

/**
 * What each waiting run is waiting on, read from main's pending tables: the
 * oldest approval or question per run. Read again whenever the waits change —
 * a new ask moves `since`, an answer drops the run from the list — so a row
 * never offers a decision main has already taken.
 */
export function usePendingAsks(waiting: readonly ActiveRun[]): Readonly<Record<string, PendingAsk | null>> {
  const key = waiting.map((run) => `${run.runId}:${run.waiting?.kind ?? ''}:${run.waiting?.since ?? ''}`).join('|')
  const runsRef = useRef(waiting)
  runsRef.current = waiting
  const [asks, setAsks] = useState<Readonly<Record<string, PendingAsk | null>>>({})

  useEffect(() => {
    const api = window.vyotiq
    if (!api || key === '') {
      setAsks({})
      return
    }
    let cancelled = false
    void Promise.all(
      runsRef.current.map(async (run): Promise<[string, PendingAsk | null]> => {
        if (run.waiting?.kind === 'approval' && api.listPendingToolApprovals) {
          const res = await api.listPendingToolApprovals(run.runId)
          const first = res.ok ? res.data[0] : undefined
          return [run.runId, first ? { kind: 'approval', request: first } : null]
        }
        if (run.waiting?.kind === 'question' && api.listPendingAgentQuestions) {
          const res = await api.listPendingAgentQuestions(run.runId)
          const first = res.ok ? res.data[0] : undefined
          return [run.runId, first ? { kind: 'question', request: first } : null]
        }
        return [run.runId, null]
      })
    ).then((entries) => {
      if (!cancelled) setAsks(Object.fromEntries(entries))
    })
    return () => {
      cancelled = true
    }
  }, [key])

  return asks
}
