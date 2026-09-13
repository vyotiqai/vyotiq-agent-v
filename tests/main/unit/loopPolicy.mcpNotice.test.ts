import { describe, expect, it } from 'vitest'
import {
  loopHintForMcpNotInCatalogFailFast,
  MCP_NOT_IN_CATALOG_FAIL_FAST_THRESHOLD,
  mcpNotInCatalogFailFastMessage,
  recordMcpNotInCatalogFailure
} from '../../../src/main/agent/loopPolicy'

describe('MCP not-in-catalog fail-fast', () => {
  it('records per-tool counts and builds fail-fast copy', () => {
    const counts = new Map<string, number>()
    expect(recordMcpNotInCatalogFailure(counts, 'mcp__a__t')).toBe(1)
    expect(recordMcpNotInCatalogFailure(counts, 'mcp__a__t')).toBe(2)
    expect(MCP_NOT_IN_CATALOG_FAIL_FAST_THRESHOLD).toBe(2)
    expect(mcpNotInCatalogFailFastMessage('mcp__a__t', 2)).toMatch(/FAIL-FAST/)
    expect(loopHintForMcpNotInCatalogFailFast(['mcp__a__t'])).toMatch(/request_mcp_tools/)
    expect(loopHintForMcpNotInCatalogFailFast([])).toBeUndefined()
  })
})
