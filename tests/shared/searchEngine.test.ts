import { describe, expect, it } from 'vitest'
import { buildSearchUrl, resolveAddressBarTarget } from '@shared/utils/searchEngine'

describe('resolveAddressBarTarget', () => {
  it('keeps http(s) URLs', () => {
    expect(resolveAddressBarTarget('https://example.com/x', 'google')).toBe(
      'https://example.com/x'
    )
  })

  it('prefixes host-like tokens with https', () => {
    expect(resolveAddressBarTarget('example.com', 'bing')).toBe('https://example.com')
  })

  it('routes search queries through the selected engine', () => {
    expect(resolveAddressBarTarget('hello world', 'duckduckgo')).toBe(
      'https://duckduckgo.com/?q=hello%20world'
    )
    expect(resolveAddressBarTarget('hello world', 'google')).toBe(
      'https://www.google.com/search?q=hello%20world'
    )
    expect(resolveAddressBarTarget('hello world', 'bing')).toBe(
      'https://www.bing.com/search?q=hello%20world'
    )
  })

  it('returns empty for blank input', () => {
    expect(resolveAddressBarTarget('  ', 'google')).toBe('')
  })

  it('keeps file: URLs as-is for workspace-scoped preview', () => {
    expect(resolveAddressBarTarget('file:///C:/work/demo/index.html', 'google')).toBe(
      'file:///C:/work/demo/index.html'
    )
  })
})

describe('buildSearchUrl', () => {
  it('defaults unknown engines to DuckDuckGo', () => {
    expect(buildSearchUrl('duckduckgo', 'a b')).toBe('https://duckduckgo.com/?q=a%20b')
  })
})
