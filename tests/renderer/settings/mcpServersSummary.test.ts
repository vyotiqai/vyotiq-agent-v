import { describe, expect, it } from 'vitest'
import type { McpServerStatus } from '@shared/ipc'
import { mcpServersSummary } from '@renderer/features/settings/sections/ToolsSection'

const server = (name: string, over: Partial<McpServerStatus> = {}): McpServerStatus => ({
  id: name.toLowerCase(),
  name,
  enabled: true,
  connected: false,
  toolCount: 0,
  ...over
})

describe('mcpServersSummary', () => {
  it('keeps the plain words when nothing is installed', () => {
    expect(mcpServersSummary([])).toBeNull()
  })

  it('says every server is off', () => {
    expect(mcpServersSummary([server('A', { enabled: false })])).toBe('Its one server is off.')
    expect(mcpServersSummary([server('A', { enabled: false }), server('B', { enabled: false })])).toBe('All 2 are off.')
  })

  it('names up to two, counts past that, and says what each group needs', () => {
    expect(
      mcpServersSummary([
        server('A', { connected: true }),
        server('B', { connected: true }),
        server('C', { connected: true }),
        server('D', { connecting: true }),
        server('E', { error: 'ENOENT uvx', errorKind: 'binary' }),
        server('F', { error: 'Sign in', errorKind: 'sign-in' }),
        server('G', { error: 'Sign in', errorKind: 'sign-in' })
      ])
    ).toBe('3 connected · D connecting · F and G need sign-in · E can’t connect')
  })

  it('never calls a server that has not tried yet a failure', () => {
    expect(mcpServersSummary([server('A')])).toBe('A on, not connected yet')
  })
})
