import { describe, expect, it } from 'vitest'
import type { McpServer, McpServerStatus } from '@shared/ipc'
import {
  indexMcpStatusById,
  mcpStatusClass,
  mcpStatusLabel
} from '@renderer/features/marketplace/mcpStatus'

const connected: McpServerStatus = {
  id: 'memory',
  name: 'Memory',
  enabled: true,
  connected: true,
  toolCount: 2
}

describe('mcpStatusLabel', () => {
  it('does not call a missing row Disabled — that is not the same as enabled: false', () => {
    expect(mcpStatusLabel(undefined)).toBe('Not connected')
    expect(mcpStatusClass(undefined)).toBe('text-secondary')
  })

  it('labels a disabled server Disabled even when a leftover session is connected', () => {
    expect(
      mcpStatusLabel({
        id: 'memory',
        name: 'Memory',
        enabled: false,
        connected: true,
        toolCount: 3
      })
    ).toBe('Disabled')
  })

  it('keeps workspace Force off distinct from Disabled when still connected globally', () => {
    expect(mcpStatusLabel(connected, { workspaceEnabled: false })).toBe(
      'Force off here · connected globally · 2 tools'
    )
  })
})

describe('indexMcpStatusById', () => {
  it('aliases settings server id and packageId onto the same status row', () => {
    const servers: Array<Pick<McpServer, 'id' | 'packageId'>> = [
      { id: 'memory-settings', packageId: 'memory' }
    ]
    const map = indexMcpStatusById([connected], servers)
    expect(map.get('memory')).toEqual(connected)
    expect(map.get('memory-settings')).toEqual(connected)
  })
})
