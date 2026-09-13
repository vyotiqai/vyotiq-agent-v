import { afterEach, describe, expect, it, vi } from 'vitest'
import { persistAlwaysAllow } from '@main/agent/toolApprovalStore'
import {
  getSettings,
  setSettings,
  enqueueSettingsMutation
} from '@main/settings/settings'
import {
  findWorkspaceSettingsOverride,
  enqueueWorkspaceMutation
} from '@main/workspace/workspaces'

vi.mock('@main/settings/settings', () => ({
  getSettings: vi.fn(() => ({ toolApproval: { allowlist: [], mode: 'ask' as const } })),
  setSettings: vi.fn(),
  enqueueSettingsMutation: vi.fn()
}))
vi.mock('@main/workspace/workspaces', () => ({
  findWorkspaceSettingsOverride: vi.fn(() => undefined),
  readWorkspacesState: vi.fn(() => ({})),
  setWorkspaceSettingsOverride: vi.fn(),
  enqueueWorkspaceMutation: vi.fn()
}))

afterEach(() => {
  vi.clearAllMocks()
})

describe('persistAlwaysAllow', () => {
  it('enqueues a global settings mutation adding the tool to the allowlist', () => {
    persistAlwaysAllow('/ws/a', 'edit')
    expect(enqueueSettingsMutation).toHaveBeenCalledTimes(1)
    const mutation = (enqueueSettingsMutation as unknown as vi.Mock).mock.calls[0][0] as () => void
    mutation()
    expect(setSettings).toHaveBeenCalledTimes(1)
    const arg = (setSettings as unknown as vi.Mock).mock.calls[0][0] as {
      toolApproval: { allowlist: string[] }
    }
    expect(arg.toolApproval.allowlist).toContain('edit')
  })

  it('does not enqueue when the tool is already allowed globally', () => {
    ;(getSettings as unknown as vi.Mock).mockReturnValue({
      toolApproval: { allowlist: ['edit'], mode: 'ask' as const }
    })
    persistAlwaysAllow('/ws/a', 'edit')
    expect(enqueueSettingsMutation).not.toHaveBeenCalled()
  })

  it('enqueues a workspace mutation when a workspace override is active', () => {
    ;(findWorkspaceSettingsOverride as unknown as vi.Mock).mockReturnValue({
      useOverride: true,
      toolApproval: { allowlist: [], mode: 'ask' as const }
    })
    persistAlwaysAllow('/ws/a', 'terminal')
    expect(enqueueWorkspaceMutation).toHaveBeenCalledTimes(1)
    expect(enqueueSettingsMutation).not.toHaveBeenCalled()
  })
})
