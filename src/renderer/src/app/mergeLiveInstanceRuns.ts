import type { RunSummary } from '@shared/ipc'
import type { AgentInstanceUiState } from '@shared/utils/agentInstance'

function liveInstanceStatus(
  phase: AgentInstanceUiState['phase']
): RunSummary['status'] {
  switch (phase) {
    case 'done':
      return 'done'
    case 'error':
      return 'error'
    case 'cancelled':
      return 'cancelled'
    case 'started':
      return 'running'
    default: {
      const _exhaustive: never = phase
      return _exhaustive
    }
  }
}

/** Merge disk-listed instance runs with live parent `agentInstances` (status + goal). */
export function mergeLiveInstanceRuns(
  listed: RunSummary[],
  agentInstances: Record<string, AgentInstanceUiState> | undefined,
  parentRunId: string | null
): RunSummary[] {
  if (!agentInstances || !parentRunId) return listed
  const byId = new Map(listed.map((run) => [run.runId, run]))
  for (const inst of Object.values(agentInstances)) {
    const live = liveInstanceStatus(inst.phase)
    const prior = byId.get(inst.instanceRunId)
    // A stale live `started` entry must not resurrect a spinner for a run the
    // disk already marked terminal (e.g. the terminal agent_instance_update
    // never reached this controller). Mirrors mergeAgentInstanceMaps' rule.
    const status =
      live === 'running' && prior && prior.status !== 'running' ? prior.status : live
    byId.set(inst.instanceRunId, {
      runId: inst.instanceRunId,
      status,
      updatedAt: prior?.updatedAt ?? new Date().toISOString(),
      goal: inst.goal ?? prior?.goal,
      parentRunId: prior?.parentRunId ?? parentRunId,
      inlineInstance: true,
      ...(inst.pathScope?.length
        ? { pathScope: inst.pathScope }
        : prior?.pathScope?.length
          ? { pathScope: prior.pathScope }
          : {}),
      ...(status === 'cancelled' && prior?.resumable ? { resumable: true as const } : {}),
      ...(status === 'error' && prior?.error ? { error: prior.error } : {})
    })
  }
  return [...byId.values()]
}
