import { describe, expect, it } from 'vitest'
import type { McpServer, McpServerStatus } from '@shared/ipc'
import { indexMcpStatusById } from '@renderer/features/marketplace/mcpStatus'

const connected: McpServerStatus = {
  id: 'memory',
  name: 'Memory',
  enabled: true,
  connected: true,
  toolCount: 2
}

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
