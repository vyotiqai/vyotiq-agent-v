import { describe, expect, it } from 'vitest'

import {
  buildRunDeepLink,
  extractDeepLinkUrlFromArgv,
  parseDeepLinkUrl
} from '@shared/deepLink'

describe('parseDeepLinkUrl', () => {
  it('parses a full vyotiq://run link with a workspace hint', () => {
    const url = buildRunDeepLink('C:\\Users\\dev\\proj', 'abc-123')
    expect(parseDeepLinkUrl(url)).toEqual({
      type: 'open_run',
      workspacePath: 'C:\\Users\\dev\\proj',
      runId: 'abc-123'
    })
  })

  it('round-trips a POSIX workspace path', () => {
    const url = buildRunDeepLink('/home/dev/proj', 'run.1_2')
    expect(parseDeepLinkUrl(url)).toEqual({
      type: 'open_run',
      workspacePath: '/home/dev/proj',
      runId: 'run.1_2'
    })
  })

  it('decodes encoded workspace paths with spaces and unicode', () => {
    const url = 'vyotiq://run/abc?ws=' + encodeURIComponent('C:\\My Projects\\répo V')
    expect(parseDeepLinkUrl(url)).toEqual({
      type: 'open_run',
      workspacePath: 'C:\\My Projects\\répo V',
      runId: 'abc'
    })
  })

  it('accepts a link with no ws hint', () => {
    expect(parseDeepLinkUrl('vyotiq://run/abc-123')).toEqual({
      type: 'open_run',
      workspacePath: null,
      runId: 'abc-123'
    })
  })

  it('rejects wrong schemes and hosts', () => {
    expect(parseDeepLinkUrl('https://run/abc')).toBeNull()
    expect(parseDeepLinkUrl('errand://run/abc')).toBeNull()
    expect(parseDeepLinkUrl('vyotiq://agent/abc')).toBeNull()
    expect(parseDeepLinkUrl('vyotiq://settings')).toBeNull()
  })

  it('rejects invalid run ids', () => {
    expect(parseDeepLinkUrl('vyotiq://run/..%2F..%2Fetc')).toBeNull()
    expect(parseDeepLinkUrl('vyotiq://run/has%20space')).toBeNull()
    expect(parseDeepLinkUrl('vyotiq://run/')).toBeNull()
  })

  it('returns null instead of throwing on malformed percent-sequences', () => {
    expect(parseDeepLinkUrl('vyotiq://run/%ZZ')).toBeNull()
    expect(parseDeepLinkUrl('vyotiq://run/%E0%80')).toBeNull()
    expect(parseDeepLinkUrl('vyotiq://run/abc%')).toBeNull()
  })

  it('rejects malformed input', () => {
    expect(parseDeepLinkUrl('')).toBeNull()
    expect(parseDeepLinkUrl('not a url')).toBeNull()
    expect(parseDeepLinkUrl(123 as unknown as string)).toBeNull()
  })

  it('ignores query params other than ws', () => {
    const target = parseDeepLinkUrl('vyotiq://run/abc?ws=%2Ftmp%2Fproj&x=%2Fevil')
    expect(target).toEqual({ type: 'open_run', workspacePath: '/tmp/proj', runId: 'abc' })
  })
})

describe('buildRunDeepLink', () => {
  it('throws on invalid run ids', () => {
    expect(() => buildRunDeepLink('/tmp/proj', 'bad id')).toThrow()
    expect(() => buildRunDeepLink('/tmp/proj', '..')).toThrow()
  })

  it('encodes the workspace path', () => {
    const url = buildRunDeepLink('C:\\Program Files\\App', 'abc')
    expect(url).toContain(encodeURIComponent('C:\\Program Files\\App'))
    expect(url.startsWith('vyotiq://run/abc?ws=')).toBe(true)
  })
})

describe('extractDeepLinkUrlFromArgv', () => {
  it('finds the URL in last position (Windows protocol handler)', () => {
    expect(
      extractDeepLinkUrlFromArgv(['C:\\app\\Vyotiq.exe', 'vyotiq://run/abc?ws=%2Ftmp'])
    ).toBe('vyotiq://run/abc?ws=%2Ftmp')
  })

  it('scans past unrelated arguments and prefers the last URL', () => {
    expect(
      extractDeepLinkUrlFromArgv(['exe', 'vyotiq://run/first', '--flag', 'vyotiq://run/second'])
    ).toBe('vyotiq://run/second')
  })

  it('is case-insensitive on the scheme', () => {
    expect(extractDeepLinkUrlFromArgv(['exe', 'VYOTIQ://run/abc'])).toBe('VYOTIQ://run/abc')
  })

  it('returns null when no URL is present', () => {
    expect(extractDeepLinkUrlFromArgv([])).toBeNull()
    expect(extractDeepLinkUrlFromArgv(['exe', '--flag'])).toBeNull()
    expect(extractDeepLinkUrlFromArgv(['exe', 'https://run/abc'])).toBeNull()
  })
})
