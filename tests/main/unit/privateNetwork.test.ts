import { describe, expect, it } from 'vitest'
import {
  addressSpaceOfUrl,
  classifyHostname,
  evaluatePrivateNetworkAccess,
  isPrivateNetworkInitiator
} from '@main/net/privateNetwork'
import { evaluateEgress } from '@main/net/egress'

describe('classifyHostname', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.8.9.10', 'loopback'],
    ['0.0.0.0', 'loopback'],
    ['localhost', 'loopback'],
    ['LOCALHOST', 'loopback'],
    ['localhost.', 'loopback'],
    ['app.localhost', 'loopback'],
    ['::1', 'loopback'],
    ['[::1]', 'loopback'],
    ['0:0:0:0:0:0:0:1', 'loopback'],
    ['::', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['::127.0.0.1', 'loopback'],
    ['64:ff9b::7f00:1', 'loopback']
  ])('%s is loopback', (host, space) => {
    expect(classifyHostname(host)).toBe(space)
  })

  it.each([
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '224.0.0.251',
    '255.255.255.255',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:192.168.1.1',
    '64:ff9b::a00:1',
    'printer.local',
    'printer.local.',
    'db.internal',
    'nas.lan',
    'host.home.arpa',
    'router'
  ])('%s is private', (host) => {
    expect(classifyHostname(host)).toBe('private')
  })

  it.each([
    '8.8.8.8',
    '172.15.0.1',
    '172.32.0.1',
    '192.169.0.1',
    '100.128.0.1',
    'example.com',
    '2606:4700::1111',
    '::ffff:8.8.8.8',
    'ec2-54-1-2-3.compute.amazonaws.com',
    'localhost.example.com'
  ])('%s is public', (host) => {
    expect(classifyHostname(host)).toBe('public')
  })

  it('normalizes decimal, octal, hex and short IPv4 forms the way the URL parser does', () => {
    expect(classifyHostname('2130706433')).toBe('loopback')
    expect(classifyHostname('0177.0.0.1')).toBe('loopback')
    expect(classifyHostname('0x7f.1')).toBe('loopback')
    expect(classifyHostname('127.1')).toBe('loopback')
    expect(classifyHostname('0')).toBe('loopback')
    expect(classifyHostname('3232235777')).toBe('private') // 192.168.1.1
    expect(classifyHostname('0xa.0.0.1')).toBe('private')
  })

  it('recognises DNS names that spell out a local address', () => {
    expect(classifyHostname('127.0.0.1.nip.io')).toBe('loopback')
    expect(classifyHostname('app.10.0.0.5.nip.io')).toBe('private')
    expect(classifyHostname('192-168-1-1.sslip.io')).toBe('private')
    expect(classifyHostname('www-127-0-0-1.sslip.io')).toBe('loopback')
    expect(classifyHostname('8.8.8.8.nip.io')).toBe('public')
    expect(classifyHostname('localtest.me')).toBe('loopback')
    expect(classifyHostname('anything.lvh.me')).toBe('loopback')
  })
})

describe('addressSpaceOfUrl', () => {
  it('reads the host the URL parser canonicalised', () => {
    expect(addressSpaceOfUrl('http://2130706433:8080/x')).toBe('loopback')
    expect(addressSpaceOfUrl('http://[::ffff:192.168.0.1]/')).toBe('private')
    expect(addressSpaceOfUrl('wss://10.0.0.2/socket')).toBe('private')
    expect(addressSpaceOfUrl('blob:http://localhost:3000/abc')).toBe('loopback')
    expect(addressSpaceOfUrl('https://example.com/')).toBe('public')
  })

  it('has no address space for non-network or unparseable URLs', () => {
    expect(addressSpaceOfUrl('about:blank')).toBeNull()
    expect(addressSpaceOfUrl('data:text/plain,hi')).toBeNull()
    expect(addressSpaceOfUrl('not a url')).toBeNull()
  })
})

describe('isPrivateNetworkInitiator', () => {
  it('counts local pages and workspace files, not blank or public ones', () => {
    expect(isPrivateNetworkInitiator('http://localhost:5173/')).toBe(true)
    expect(isPrivateNetworkInitiator('http://192.168.1.10/')).toBe(true)
    expect(isPrivateNetworkInitiator('file:///C:/ws/index.html')).toBe(true)
    expect(isPrivateNetworkInitiator('https://example.com/')).toBe(false)
    expect(isPrivateNetworkInitiator('about:blank')).toBe(false)
    expect(isPrivateNetworkInitiator('')).toBe(false)
    expect(isPrivateNetworkInitiator(undefined)).toBe(false)
  })
})

describe('evaluatePrivateNetworkAccess', () => {
  it('refuses a public page reaching loopback or the LAN', () => {
    const loop = evaluatePrivateNetworkAccess('http://127.0.0.1:9000/admin', 'https://evil.example/')
    expect(loop.allowed).toBe(false)
    if (!loop.allowed) {
      expect(loop.detail).toContain('http://127.0.0.1:9000')
      expect(loop.detail).toContain('https://evil.example')
    }
    expect(evaluatePrivateNetworkAccess('http://192.168.1.1/', 'https://evil.example/').allowed).toBe(
      false
    )
    expect(
      evaluatePrivateNetworkAccess('http://169.254.169.254/latest/meta-data', 'https://x.example/')
        .allowed
    ).toBe(false)
  })

  it('treats an unattributable request as public', () => {
    expect(evaluatePrivateNetworkAccess('http://localhost:3000/', '').allowed).toBe(false)
    expect(evaluatePrivateNetworkAccess('http://localhost:3000/', 'about:blank').allowed).toBe(false)
  })

  it('lets a local page reach local hosts', () => {
    expect(
      evaluatePrivateNetworkAccess('http://127.0.0.1:8787/api', 'http://localhost:5173/').allowed
    ).toBe(true)
    expect(evaluatePrivateNetworkAccess('http://10.0.0.4/', 'http://192.168.1.2/').allowed).toBe(true)
    expect(evaluatePrivateNetworkAccess('http://localhost:3000/', 'file:///C:/ws/a.html').allowed).toBe(
      true
    )
  })

  it('never constrains public targets', () => {
    expect(evaluatePrivateNetworkAccess('https://cdn.example/x.js', 'https://evil.example/').allowed).toBe(
      true
    )
    expect(evaluatePrivateNetworkAccess('https://cdn.example/x.js', '').allowed).toBe(true)
  })
})

describe('evaluateEgress with an initiator', () => {
  it('refuses with private_network when a public page targets a local host', () => {
    const decision = evaluateEgress({
      url: 'http://localhost:3000/api',
      purpose: 'browser_subresource',
      allowLocal: true,
      initiatorUrl: 'https://evil.example/'
    })
    expect(decision).toMatchObject({ allowed: false, reason: 'private_network' })
  })

  it('allows the same request from a local page', () => {
    expect(
      evaluateEgress({
        url: 'http://localhost:3000/api',
        purpose: 'browser_subresource',
        allowLocal: true,
        initiatorUrl: 'http://localhost:3000/'
      })
    ).toEqual({ allowed: true, reason: 'allowed' })
  })

  it('leaves an explicit request (no initiator) to the allowLocal posture', () => {
    expect(
      evaluateEgress({
        url: 'http://localhost:3000/',
        purpose: 'browser_navigation',
        allowLocal: true
      }).allowed
    ).toBe(true)
    expect(
      evaluateEgress({
        url: 'http://localhost:3000/',
        purpose: 'browser_navigation',
        allowLocal: false
      })
    ).toMatchObject({ allowed: false, reason: 'blocked_host' })
  })

  it('still refuses 0.0.0.0 even under allowLocal', () => {
    expect(
      evaluateEgress({
        url: 'http://0.0.0.0:8080/',
        purpose: 'browser_navigation',
        allowLocal: true
      })
    ).toMatchObject({ allowed: false, reason: 'blocked_host' })
  })

  it('judges a WebSocket by its host', () => {
    expect(
      evaluateEgress({
        url: 'ws://127.0.0.1:9229/devtools',
        purpose: 'browser_subresource',
        allowLocal: true,
        initiatorUrl: 'https://evil.example/'
      })
    ).toMatchObject({ allowed: false, reason: 'private_network' })
  })

  it('catches a trailing-dot localhost under the strict posture', () => {
    expect(
      evaluateEgress({ url: 'http://localhost./', purpose: 'browser_navigation', allowLocal: false })
    ).toMatchObject({ allowed: false, reason: 'blocked_host' })
  })
})
