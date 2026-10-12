import type { RunSummary } from '@shared/ipc'
import { briefOutcome, type AgentInstanceUiState } from '@shared/utils/agentInstance'

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
      // A child started before its start carried the brief has only its
      // background live; the listed brief names the outcome that titles it.
      goal: briefOutcome(prior?.goal) && !briefOutcome(inst.goal) ? prior!.goal : (inst.goal ?? prior?.goal),
      parentRunId: prior?.parentRunId ?? parentRunId,
      inlineInstance: true,
      // The row's name: as listed (the plan's title for its step now), else as
      // its start carried it. Its helper label rides along either way.
      ...((prior?.stepTitle ?? inst.stepTitle) ? { stepTitle: prior?.stepTitle ?? inst.stepTitle } : {}),
      ...((inst.agentType ?? prior?.agentType) ? { agentType: inst.agentType ?? prior?.agentType } : {}),
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
