import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentInstanceUiState } from '@shared/utils/agentInstance'

export type InlineInstanceGate = {
  runId: string
  kind: 'approval' | 'question'
}

function isActiveChildPhase(phase: AgentInstanceUiState['phase'] | undefined): boolean {
  return phase === 'started'
}

/** Order-sensitive identity check so an unchanged scan never re-renders consumers. */
function sameGates(a: readonly InlineInstanceGate[], b: readonly InlineInstanceGate[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.runId !== b[i]!.runId || a[i]!.kind !== b[i]!.kind) return false
  }
  return true
}

/**
 * Tracks which inline instance sub-session is open under the parent chat,
 * plus pending approval/question gates for child runs.
 */
export function useInlineInstanceUi(
  agentInstances: Record<string, AgentInstanceUiState> | undefined,
  /** Parent chat run — leaving it clears the nested sub-session. */
  parentRunId?: string | null,
  controlled?: {
    openInstanceRunId: string | null
    setOpenInstanceRunId: (runId: string | null) => void
  }
) {
  const [uncontrolledOpenId, setUncontrolledOpenId] = useState<string | null>(null)
  const isControlled = controlled != null
  const openInstanceRunId = controlled?.openInstanceRunId ?? uncontrolledOpenId
  const setOpenInstanceRunId = controlled?.setOpenInstanceRunId ?? setUncontrolledOpenId
  const [pendingGates, setPendingGates] = useState<InlineInstanceGate[]>([])
  const scanGenerationRef = useRef(0)

  // Uncontrolled only — App owns clearing when openInstanceRunId is controlled
  // (avoids ChatView + SessionChatColumn both wiping sidebar-driven opens).
  useEffect(() => {
    if (isControlled) return
    setUncontrolledOpenId(null)
  }, [parentRunId, isControlled])

  const isKnownChild = useCallback(
    (runId: string): boolean => Boolean(agentInstances?.[runId]),
    [agentInstances]
  )

  const upsertGate = useCallback((gate: InlineInstanceGate): void => {
    setPendingGates((prev) => {
      const without = prev.filter((g) => g.runId !== gate.runId)
      return [...without, gate]
    })
  }, [])

  const removeGate = useCallback((runId: string): void => {
    setPendingGates((prev) => prev.filter((g) => g.runId !== runId))
  }, [])

  const scanPendingGates = useCallback(async (): Promise<void> => {
    const generation = ++scanGenerationRef.current
    const known = agentInstances ?? {}
    const childIds = Object.keys(known).filter((id) =>
      isActiveChildPhase(known[id]?.phase)
    )
    if (childIds.length === 0) {
      if (generation === scanGenerationRef.current) {
        setPendingGates((prev) => (prev.length === 0 ? prev : []))
      }
      return
    }

    const next: InlineInstanceGate[] = []
    for (const childId of childIds) {
      if (openInstanceRunId === childId) continue
      if (window.vyotiq?.listPendingToolApprovals) {
        const approvals = await window.vyotiq.listPendingToolApprovals(childId)
        if (generation !== scanGenerationRef.current) return
        if (approvals.ok && approvals.data.length > 0) {
          next.push({ runId: childId, kind: 'approval' })
          continue
        }
      }
      if (window.vyotiq?.listPendingAgentQuestions) {
        const questions = await window.vyotiq.listPendingAgentQuestions(childId)
        if (generation !== scanGenerationRef.current) return
        if (questions.ok && questions.data.length > 0) {
          next.push({ runId: childId, kind: 'question' })
        }
      }
    }
    if (generation === scanGenerationRef.current) {
      setPendingGates((prev) => (sameGates(prev, next) ? prev : next))
    }
  }, [agentInstances, openInstanceRunId])

  useEffect(() => {
    const onApproval = (request: { runId: string }): void => {
      if (!isKnownChild(request.runId)) return
      if (openInstanceRunId === request.runId) {
        removeGate(request.runId)
        return
      }
      upsertGate({ runId: request.runId, kind: 'approval' })
    }
    const onQuestion = (request: { runId: string }): void => {
      if (!isKnownChild(request.runId)) return
      if (openInstanceRunId === request.runId) {
        removeGate(request.runId)
        return
      }
      upsertGate({ runId: request.runId, kind: 'question' })
    }
    const unsubApproval = window.vyotiq?.onToolApprovalRequest?.(onApproval)
    const unsubQuestion = window.vyotiq?.onAgentQuestionRequest?.(onQuestion)
    return () => {
      unsubApproval?.()
      unsubQuestion?.()
    }
  }, [isKnownChild, openInstanceRunId, removeGate, upsertGate])

  useEffect(() => {
    void scanPendingGates()
  }, [scanPendingGates])

  useEffect(() => {
    setPendingGates((prev) => {
      const next = prev.filter((gate) => {
        const phase = agentInstances?.[gate.runId]?.phase
        return isActiveChildPhase(phase)
      })
      // Same reference when nothing dropped — avoids a re-render on every
      // agentInstances update.
      return next.length === prev.length ? prev : next
    })
  }, [agentInstances])

  const closeInstancePane = useCallback((): void => {
    setOpenInstanceRunId(null)
    void scanPendingGates()
  }, [scanPendingGates, setOpenInstanceRunId])

  const openInstancePane = useCallback(
    (runId: string): void => {
      setOpenInstanceRunId(runId)
      removeGate(runId)
    },
    [removeGate, setOpenInstanceRunId]
  )

  return {
    openInstanceRunId,
    openInstancePane,
    closeInstancePane,
    pendingGates
  }
}
