import { describe, expect, it } from 'vitest'
import { normalizeProxyBypass, validateProxyUrl } from '@shared/domain/network'
import { NetworkSettingsSchema, SettingsSchema, DEFAULT_SETTINGS } from '@shared/ipc'

describe('validateProxyUrl', () => {
  it('accepts host:port with or without a scheme, and keeps just the origin', () => {
    expect(validateProxyUrl('proxy.corp:8080')).toEqual({ ok: true, url: 'http://proxy.corp:8080' })
    expect(validateProxyUrl(' https://secure.proxy:443/ ')).toEqual({ ok: true, url: 'https://secure.proxy' })
    expect(validateProxyUrl('http://[::1]:3128')).toEqual({ ok: true, url: 'http://[::1]:3128' })
  })

  it('refuses what either URL parser could read differently, and credentials', () => {
    // Chromium percent-encodes this host where Node refuses it; both must refuse.
    expect(validateProxyUrl('bad address with spaces')).toMatchObject({ ok: false })
    expect(validateProxyUrl('proxy%20x:80')).toMatchObject({ ok: false })
    expect(validateProxyUrl('socks5://s:1080')).toMatchObject({ ok: false, error: expect.stringMatching(/http/) })
    expect(validateProxyUrl('http://u:p@proxy:80')).toMatchObject({ ok: false, error: expect.stringMatching(/password/) })
    expect(validateProxyUrl('http://proxy:80/path')).toMatchObject({ ok: false, error: expect.stringMatching(/no path/) })
    expect(validateProxyUrl('')).toMatchObject({ ok: false })
  })

  it('normalizes a bypass list to NO_PROXY form', () => {
    expect(normalizeProxyBypass(' a.com, *.corp ;10.0.0.1  b ')).toBe('a.com,*.corp,10.0.0.1,b')
    expect(normalizeProxyBypass('')).toBe('')
  })
})

describe('network and cloud settings', () => {
  it('load with defaults when absent, and fall back rather than fail on a bad value', () => {
    const parsed = SettingsSchema.parse({ ...DEFAULT_SETTINGS, network: undefined, bedrockRegion: 'not a region', vertexLocation: 'mars' })
    expect(parsed.network).toEqual({ proxyMode: 'system', proxyUrl: '', proxyBypass: '' })
    expect(parsed.bedrockRegion).toBe('us-east-1')
    expect(parsed.vertexLocation).toBe('global')
    expect(NetworkSettingsSchema.parse({ proxyMode: 'bogus' }).proxyMode).toBe('system')
  })
})
