import { afterEach, describe, expect, it, vi } from 'vitest'
import { persistAllowRules, persistAlwaysAllow } from '@main/agent/toolApprovalStore'
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

/** Run the settings mutation the store queued, and return what it wrote. */
function writtenSettings(): Parameters<typeof setSettings>[0] {
  const mutation = vi.mocked(enqueueSettingsMutation).mock.calls[0]![0] as () => void
  mutation()
  return vi.mocked(setSettings).mock.calls[0]![0]
}

describe('persistAlwaysAllow', () => {
  it('enqueues a global settings mutation adding the tool to the allowlist', () => {
    persistAlwaysAllow('/ws/a', 'edit')
    expect(enqueueSettingsMutation).toHaveBeenCalledTimes(1)
    const arg = writtenSettings()
    expect(setSettings).toHaveBeenCalledTimes(1)
    expect(arg.toolApproval?.allowlist).toContain('edit')
  })

  it('does not enqueue when the tool is already allowed globally', () => {
    vi.mocked(getSettings).mockReturnValue({
      toolApproval: { allowlist: ['edit'], mode: 'ask' as const }
    } as never)
    persistAlwaysAllow('/ws/a', 'edit')
    expect(enqueueSettingsMutation).not.toHaveBeenCalled()
  })

  it('enqueues a workspace mutation when a workspace override is active', () => {
    vi.mocked(findWorkspaceSettingsOverride).mockReturnValue({
      useOverride: true,
      toolApproval: { allowlist: [], mode: 'ask' as const }
    } as never)
    persistAlwaysAllow('/ws/a', 'terminal')
    expect(enqueueWorkspaceMutation).toHaveBeenCalledTimes(1)
    expect(enqueueSettingsMutation).not.toHaveBeenCalled()
  })
})

describe('persistAllowRules', () => {
  const RULES = [
    { effect: 'allow' as const, tool: 'edit', path: 'src/**' },
    { effect: 'allow' as const, tool: 'str_replace', path: 'src/**' }
  ]

  it('adds only the rules not already saved', () => {
    vi.mocked(findWorkspaceSettingsOverride).mockReturnValue(undefined)
    vi.mocked(getSettings).mockReturnValue({
      toolApproval: { allowlist: [], mode: 'mutating' as const, rules: [RULES[0]] }
    } as never)
    persistAllowRules('/ws/a', RULES)
    expect(writtenSettings().toolApproval?.rules).toEqual(RULES)
  })

  it('writes nothing when every rule is there', () => {
    vi.mocked(findWorkspaceSettingsOverride).mockReturnValue(undefined)
    vi.mocked(getSettings).mockReturnValue({
      toolApproval: { allowlist: [], mode: 'mutating' as const, rules: RULES }
    } as never)
    persistAllowRules('/ws/a', RULES)
    expect(enqueueSettingsMutation).not.toHaveBeenCalled()
  })

  it('writes to the workspace override when one is active', () => {
    vi.mocked(findWorkspaceSettingsOverride).mockReturnValue({
      useOverride: true,
      toolApproval: { allowlist: [], mode: 'mutating' as const, rules: [] }
    } as never)
    persistAllowRules('/ws/a', RULES)
    expect(enqueueWorkspaceMutation).toHaveBeenCalledTimes(1)
    expect(enqueueSettingsMutation).not.toHaveBeenCalled()
  })
})
