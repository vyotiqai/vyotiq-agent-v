import { describe, expect, it } from 'vitest'
import { mcpConnectErrorCode } from '../../src/shared/errors'

describe('mcpConnectErrorCode', () => {
  it('maps spawn ENOENT to MCP_SPAWN', () => {
    const err = Object.assign(new Error('spawn uvx ENOENT'), { code: 'ENOENT' })
    expect(mcpConnectErrorCode(err)).toBe('MCP_SPAWN')
  })

  it('maps generic failures to MCP_CONNECT', () => {
    expect(mcpConnectErrorCode(new Error('MCP connect timed out after 120s'))).toBe('MCP_CONNECT')
  })
})
