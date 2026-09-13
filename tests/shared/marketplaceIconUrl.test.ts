import { describe, expect, it } from 'vitest'
import { MarketplaceCatalogEntrySchema } from '@shared/ipc'
import {
  isAllowedMarketplaceIconUrl,
  MARKETPLACE_ICON_URL_MAX_LENGTH
} from '@shared/utils/marketplaceIconUrl'

describe('marketplace iconUrl allowlist', () => {
  const goodPng =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

  it('accepts image data URLs and rejects other schemes', () => {
    expect(isAllowedMarketplaceIconUrl(goodPng)).toBe(true)
    expect(isAllowedMarketplaceIconUrl('http://evil.example/icon.png')).toBe(false)
    expect(isAllowedMarketplaceIconUrl('https://evil.example/icon.png')).toBe(false)
    expect(isAllowedMarketplaceIconUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedMarketplaceIconUrl(`data:text/html;base64,${'YQ=='}`)).toBe(false)
    expect(
      isAllowedMarketplaceIconUrl(`data:image/png;base64,${'A'.repeat(MARKETPLACE_ICON_URL_MAX_LENGTH)}`)
    ).toBe(false)
  })

  it('drops invalid iconUrl on catalog entry parse without failing the entry', () => {
    const base = {
      id: 'pkg',
      kind: 'mcp' as const,
      name: 'Pkg',
      version: '1.0.0',
      description: ''
    }
    expect(MarketplaceCatalogEntrySchema.parse({ ...base, iconUrl: goodPng }).iconUrl).toBe(goodPng)
    expect(
      MarketplaceCatalogEntrySchema.parse({ ...base, iconUrl: 'http://evil.example/x.png' }).iconUrl
    ).toBeUndefined()
    expect(
      MarketplaceCatalogEntrySchema.parse({ ...base, iconUrl: 'javascript:alert(1)' }).iconUrl
    ).toBeUndefined()
  })
})
