import { describe, expect, it } from 'vitest'
import { mcpToolName, parseMcpToolName, validateMcpServers } from '@main/agent/mcp'
import { McpServerSchema } from '@shared/ipc'

describe('MCP tool naming', () => {
  it('namespaces tools by server id', () => {
    expect(mcpToolName('fs', 'read_file')).toBe('mcp__fs__read_file')
  })

  it('parses namespaced tool names', () => {
    expect(parseMcpToolName('mcp__fs__read_file')).toEqual({
      serverId: 'fs',
      toolName: 'read_file'
    })
  })

  it('returns null for built-in tools', () => {
    expect(parseMcpToolName('read')).toBeNull()
  })
})

describe('validateMcpServers', () => {
  it('rejects server ids that contain __', () => {
    expect(
      validateMcpServers([
        { id: 'my__server', name: 'Bad', transport: 'stdio', command: 'echo', enabled: true }
      ])
    ).toMatch(/must not contain "__"/)
  })

  it('rejects duplicate ids', () => {
    expect(
      validateMcpServers([
        { id: 'fs', name: 'A', transport: 'stdio', command: 'a', enabled: true },
        { id: 'fs', name: 'B', transport: 'stdio', command: 'b', enabled: true }
      ])
    ).toMatch(/Duplicate/)
  })
})

describe('McpServerSchema', () => {
  it('rejects ids with __', () => {
    const result = McpServerSchema.safeParse({
      id: 'bad__id',
      name: 'Bad',
      transport: 'stdio',
      command: 'echo'
    })
    expect(result.success).toBe(false)
  })
})
