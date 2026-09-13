import type { AgentEvent } from '@shared/ipc'
import type { AgentInstanceUiState } from './agentInstance'

export function mergeAgentInstanceUpdate(
  prev: Record<string, AgentInstanceUiState>,
  event: Extract<AgentEvent, { type: 'agent_instance_update' }>
): Record<string, AgentInstanceUiState> {
  const prior = prev[event.instanceRunId]
  return {
    ...prev,
    [event.instanceRunId]: {
      instanceRunId: event.instanceRunId,
      phase: event.phase,
      goal: event.goal ?? prior?.goal,
      summary: event.summary ?? prior?.summary,
      pathScope: event.pathScope ?? prior?.pathScope
    }
  }
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
    out[id] = {
      instanceRunId: id,
      phase: diskTerminal || !liveTerminal ? disk.phase : live.phase,
      goal: disk.goal ?? live.goal,
      summary: disk.summary ?? live.summary,
      pathScope: disk.pathScope ?? live.pathScope
    }
  }
  return out
}
