import type { AgentEvent } from '@shared/ipc'
import type { AgentInstanceUiState } from './agentInstance'

type InstanceUpdate = Extract<AgentEvent, { type: 'agent_instance_update' }>

/**
 * `at` is the update's own stamp; a persisted row passes its events.jsonl stamp
 * for updates written before the event carried one.
 */
export function mergeAgentInstanceUpdate(
  prev: Record<string, AgentInstanceUiState>,
  event: InstanceUpdate,
  rowAt?: string
): Record<string, AgentInstanceUiState> {
  const prior = prev[event.instanceRunId]
  const at = event.at ?? rowAt
  // A terminal phase is final: a progress update that lands after it (the
  // live stream and a disk reload can interleave) must not reopen it.
  if (prior && prior.phase !== 'started' && event.phase === 'started') return prev
  const terminal = event.phase !== 'started'
  const next: AgentInstanceUiState = {
    instanceRunId: event.instanceRunId,
    phase: event.phase,
    // The first goal stands: the terminal update carries the child's composed
    // brief (status.json's, cut at 200 chars), not the goal the parent wrote.
    goal: prior?.goal ?? event.goal,
    summary: event.summary ?? prior?.summary,
    pathScope: event.pathScope ?? prior?.pathScope,
    stepId: event.stepId ?? prior?.stepId,
    agentType: event.agentType ?? prior?.agentType,
    startedAt: prior?.startedAt ?? (event.phase === 'started' ? at : undefined),
    endedAt: terminal ? (at ?? prior?.endedAt) : prior?.endedAt,
    step: event.step ?? prior?.step,
    // What it is doing means nothing once it has stopped.
    activity: terminal ? undefined : (event.activity ?? prior?.activity),
    usage: event.usage ?? prior?.usage
  }
  return { ...prev, [event.instanceRunId]: stripUndefined(next) }
}

function stripUndefined(state: AgentInstanceUiState): AgentInstanceUiState {
  const out = { ...state } as Record<string, unknown>
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key]
  return out as AgentInstanceUiState
}

/** Merge disk-hydrated instance map into live UI state without wiping live-only entries. */
export function mergeAgentInstanceMaps(
  prior: Record<string, AgentInstanceUiState>,
  fromDisk: Record<string, AgentInstanceUiState>
): Record<string, AgentInstanceUiState> {
  const out: Record<string, AgentInstanceUiState> = { ...prior }
  for (const [id, disk] of Object.entries(fromDisk)) {
    const live = out[id]
    if (!live) {
      out[id] = disk
      continue
    }
    const diskTerminal = disk.phase !== 'started'
    const liveTerminal = live.phase !== 'started'
    const phase = diskTerminal || !liveTerminal ? disk.phase : live.phase
    // Progress is live-only: disk never holds a step or an activity, so the
    // live values stand while the child runs.
    out[id] = stripUndefined({
      instanceRunId: id,
      phase,
      goal: disk.goal ?? live.goal,
      summary: disk.summary ?? live.summary,
      pathScope: disk.pathScope ?? live.pathScope,
      stepId: disk.stepId ?? live.stepId,
      agentType: disk.agentType ?? live.agentType,
      startedAt: disk.startedAt ?? live.startedAt,
      endedAt: disk.endedAt ?? live.endedAt,
      step: live.step ?? disk.step,
      activity: phase === 'started' ? live.activity : undefined,
      usage: diskTerminal ? (disk.usage ?? live.usage) : (live.usage ?? disk.usage)
    })
  }
  return out
}
