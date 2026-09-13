import { createContext, useContext } from 'react'
import type { AgentInteractionMode } from '@shared/ipc'
import type { AgentInstanceUiState } from '@shared/utils/agentInstance'
import type { WorkspaceFileOpenOptions } from './components/FilesPanel'

/** Active chat run identity for tool cards that load run-dir artifacts. */
export type RunSessionValue = {
  workspacePath: string | null
  runId: string | null
  agentMode?: AgentInteractionMode
  agentInstances?: Record<string, AgentInstanceUiState>
  onOpenAgentInstance?: (instanceRunId: string) => void
  onOpenWorkspaceFile?: (path: string, options?: WorkspaceFileOpenOptions) => void
}

const RunSessionContext = createContext<RunSessionValue>({
  workspacePath: null,
  runId: null,
  agentMode: undefined,
  agentInstances: undefined,
  onOpenAgentInstance: undefined,
  onOpenWorkspaceFile: undefined
})

export const RunSessionProvider = RunSessionContext.Provider

export function useRunSession(): RunSessionValue {
  return useContext(RunSessionContext)
}
