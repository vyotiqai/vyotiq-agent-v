import { DEFAULT_TOOL_APPROVAL, type PermissionRule } from '../../shared/ipc'
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

function sameRule(a: PermissionRule, b: PermissionRule): boolean {
  return a.effect === b.effect && a.tool === b.tool && a.command === b.command && a.path === b.path
}

/**
 * Persist allow rules ("Always allow edits under src/") where the run reads
 * rules back: the workspace override when it has one, otherwise global
 * settings. A rule already there is not added twice.
 */
export function persistAllowRules(workspacePath: string, rules: readonly PermissionRule[]): void {
  try {
    const override = findWorkspaceSettingsOverride(readWorkspacesState(), workspacePath)
    if (override?.useOverride) {
      const current = override.toolApproval ?? DEFAULT_TOOL_APPROVAL
      const add = rules.filter((rule) => !(current.rules ?? []).some((have) => sameRule(have, rule)))
      if (add.length === 0) return
      void enqueueWorkspaceMutation(() =>
        setWorkspaceSettingsOverride(workspacePath, {
          ...override,
          toolApproval: { ...current, rules: [...(current.rules ?? []), ...add] }
        })
      )
      return
    }
    const settings = getSettings()
    const current = settings.toolApproval ?? DEFAULT_TOOL_APPROVAL
    const add = rules.filter((rule) => !(current.rules ?? []).some((have) => sameRule(have, rule)))
    if (add.length === 0) return
    void enqueueSettingsMutation(() => setSettings({ toolApproval: { ...current, rules: [...(current.rules ?? []), ...add] } }))
  } catch (err) {
    // A failed write costs the user one extra prompt next run, nothing more.
    logger.warn('Failed to persist allow rules', { scope: 'agent', err })
  }
}
