import { useEffect, useMemo, useRef, useState } from 'react'
import type { ActiveRun, AgentQuestionRequest, ToolApprovalDecision, ToolApprovalRequest } from '@shared/ipc'
import { workspacePathsEqual } from '@shared/workspacePathMatch'

export type PendingAsk =
  | { kind: 'approval'; request: ToolApprovalRequest }
  | { kind: 'question'; request: AgentQuestionRequest }

/**
 * What each waiting run is waiting on, read from main's pending tables: the
 * oldest approval or question per run. Read again whenever the waits change —
 * a new ask moves `since`, an answer drops the run from the list — so a row
 * never offers a decision main has already taken. A move of `epoch` reads them
 * again too: two asks made in the same millisecond leave `since` where it was.
 */
export function usePendingAsks(waiting: readonly ActiveRun[], epoch = 0): Readonly<Record<string, PendingAsk | null>> {
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
  }, [key, epoch])

  return asks
}

type RespondApproval = (workspacePath: string, runId: string, requestId: string, decision: ToolApprovalDecision) => Promise<void>

/**
 * What the waiting tasks in the open workspaces ask, and an answer that reads
 * them again once it lands, so the next ask gets its buttons. One source for
 * every place that answers from outside the task: the list's rows, its Inbox
 * and the rail's.
 */
export function useWaitingAsks(
  activeRuns: readonly ActiveRun[],
  openPaths: readonly string[],
  respond: RespondApproval | undefined
): { asks: Readonly<Record<string, PendingAsk | null>>; respond: RespondApproval | undefined } {
  const waiting = useMemo(
    () => activeRuns.filter((run) => run.waiting && openPaths.some((path) => workspacePathsEqual(path, run.workspacePath))),
    [activeRuns, openPaths]
  )
  const [epoch, setEpoch] = useState(0)
  const answer = useMemo<RespondApproval | undefined>(
    () =>
      respond
        ? async (path, runId, requestId, decision) => {
            await respond(path, runId, requestId, decision)
            setEpoch((n) => n + 1)
          }
        : undefined,
    [respond]
  )
  return { asks: usePendingAsks(waiting, epoch), respond: answer }
}
