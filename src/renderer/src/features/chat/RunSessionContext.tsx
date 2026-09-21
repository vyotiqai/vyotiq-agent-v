import { createContext, useContext } from 'react'
import type { AgentInteractionMode } from '@shared/ipc'
import type { AgentInstanceUiState } from '@shared/utils/agentInstance'
import type { ChatRightPanelId } from '@renderer/lib/utils/layout'
import type { WorkspaceFileOpenOptions } from './components/FilesPanel'

/** Active chat run identity for tool cards that load run-dir artifacts. */
export type RunSessionValue = {
  workspacePath: string | null
  runId: string | null
  agentMode?: AgentInteractionMode
  agentInstances?: Record<string, AgentInstanceUiState>
  onOpenAgentInstance?: (instanceRunId: string) => void
  onOpenWorkspaceFile?: (path: string, options?: WorkspaceFileOpenOptions) => void
  /** Reveal a dock panel from a transcript card (e.g. a PR card opens `pr`). */
  onOpenPanel?: (panel: ChatRightPanelId) => void
}

const RunSessionContext = createContext<RunSessionValue>({
  workspacePath: null,
  runId: null,
  agentMode: undefined,
  agentInstances: undefined,
  onOpenAgentInstance: undefined,
  onOpenWorkspaceFile: undefined,
  onOpenPanel: undefined
})

export const RunSessionProvider = RunSessionContext.Provider

export function useRunSession(): RunSessionValue {
  return useContext(RunSessionContext)
}
