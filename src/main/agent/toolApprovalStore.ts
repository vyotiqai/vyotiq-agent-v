import { DEFAULT_TOOL_APPROVAL } from '../../shared/ipc'
import { logger } from '../../shared/logger'
import { getSettings, setSettings, enqueueSettingsMutation } from '@main/settings/settings'
import {
  findWorkspaceSettingsOverride,
  readWorkspacesState,
  setWorkspaceSettingsOverride,
  enqueueWorkspaceMutation
} from '@main/workspace/workspaces'

/**
 * Persist an "always allow" choice where the run will actually read it back:
 * the workspace override when the workspace has one, otherwise global settings.
 */
export function persistAlwaysAllow(workspacePath: string, toolName: string): void {
  try {
    const override = findWorkspaceSettingsOverride(readWorkspacesState(), workspacePath)
    if (override?.useOverride) {
      const current = override.toolApproval ?? DEFAULT_TOOL_APPROVAL
      if (current.allowlist.includes(toolName)) return
      void enqueueWorkspaceMutation(() =>
        setWorkspaceSettingsOverride(workspacePath, {
          ...override,
          toolApproval: { ...current, allowlist: [...current.allowlist, toolName] }
        })
      )
      return
    }

    const settings = getSettings()
    const current = settings.toolApproval ?? DEFAULT_TOOL_APPROVAL
    if (current.allowlist.includes(toolName)) return
    void enqueueSettingsMutation(() =>
      setSettings({ toolApproval: { ...current, allowlist: [...current.allowlist, toolName] } })
    )
  } catch (err) {
    // A failed write costs the user one extra prompt next run, nothing more.
    logger.warn('Failed to persist tool allowlist entry', {
      scope: 'agent',
      tool: toolName,
      err
    })
  }
}
