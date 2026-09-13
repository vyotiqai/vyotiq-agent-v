import { describe, expect, it } from 'vitest'
import {
  effectiveMarketplaceEnabled,
  marketplaceOverrideKind,
  workspaceOverrideForId
} from '@shared/domain/marketplaceEnablement'

describe('workspaceOverrideForId', () => {
  it('returns undefined when the id is not overridden', () => {
    expect(workspaceOverrideForId({ mcp: { git: false } }, 'mcp', 'memory')).toBeUndefined()
  })

  it('returns the boolean when the id is present, including false', () => {
    expect(workspaceOverrideForId({ mcp: { memory: false } }, 'mcp', 'memory')).toBe(false)
    expect(workspaceOverrideForId({ mcp: { memory: true } }, 'mcp', 'memory')).toBe(true)
  })
})

describe('effectiveMarketplaceEnabled', () => {
  it('lets a workspace Force off win over a globally enabled package', () => {
    expect(effectiveMarketplaceEnabled('memory', true, { mcp: { memory: false } }, 'mcp')).toBe(
      false
    )
  })
})

describe('marketplaceOverrideKind', () => {
  it('maps catalog kinds onto override maps', () => {
    expect(marketplaceOverrideKind('mcp')).toBe('mcp')
    expect(marketplaceOverrideKind('skill')).toBe('skills')
    expect(marketplaceOverrideKind('plugin')).toBe('plugins')
  })
})
