import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import http from 'http'
import net from 'net'
import type { NetworkSettings } from '@shared/ipc'

// Node's own proxy support is `http.setGlobalProxyFromEnv`, which the Node in Electron 44 has.
// CI also runs the suite on Node 22, which does not; the module then reports that instead, so
// only the tests that send real traffic through a proxy need it.
const hasBuiltInProxy =
  typeof (http as unknown as { setGlobalProxyFromEnv?: unknown }).setGlobalProxyFromEnv === 'function'

// Chromium sessions, as far as the proxy module touches them.
const sessionCalls: Array<{ partition: string; config: unknown }> = []
let resolveAnswer = 'DIRECT'
function fakeSession(partition: string) {
  return {
    setProxy: async (config: unknown) => {
      sessionCalls.push({ partition, config })
    },
    resolveProxy: async () => resolveAnswer
  }
}
const sessions = new Map<string, ReturnType<typeof fakeSession>>()
vi.mock('electron', () => ({
  app: { getPath: () => process.cwd(), isPackaged: false },
  session: {
    get defaultSession() {
      if (!sessions.has('default')) sessions.set('default', fakeSession('default'))
      return sessions.get('default')
    },
    fromPartition: (p: string) => {
      if (!sessions.has(p)) sessions.set(p, fakeSession(p))
      return sessions.get(p)
    }
  }
}))

import {
  applyEarlyNodeProxy,
  applyNetworkSettings,
  childProxyEnv,
  proxyStatus,
  proxyUrlFromChromium,
  resetProxyForTests,
  resolveNodeProxy
} from '@main/net/proxy'
import { resolveAllowedUrl } from '@main/net/webFetch'
import { sanitizedTerminalEnv } from '@main/agent/tools/terminal'

const settings = (over: Partial<NetworkSettings>): NetworkSettings => ({
  proxyMode: 'system',
  proxyUrl: '',
  proxyBypass: '',
  ...over
})

/** A forward proxy on raw sockets: records what it was asked, maps *.test to a local target. */
let proxy: net.Server
let target: http.Server
let proxyPort = 0
let targetPort = 0
const proxied: string[] = []

beforeAll(async () => {
  target = http.createServer((req, res) => res.end(`target saw ${req.url}`))
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r))
  targetPort = (target.address() as net.AddressInfo).port

  proxy = net.createServer((client) => {
    client.once('data', (first) => {
      const head = first.toString('latin1')
      const line = head.split('\r\n')[0]!
      proxied.push(line)
      const connect = /^CONNECT ([^:]+):(\d+) /.exec(line)
      const upstream = net.connect(targetPort, '127.0.0.1', () => {
        if (connect) {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        } else {
          // Absolute-form request: rewrite to origin-form for the target.
          upstream.write(first.toString('latin1').replace(/^(\w+) http:\/\/[^/]+/, '$1 '), 'latin1')
        }
        client.pipe(upstream).pipe(client)
      })
      upstream.on('error', () => client.destroy())
      client.on('error', () => upstream.destroy())
    })
  })
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r))
  proxyPort = (proxy.address() as net.AddressInfo).port
})

afterEach(() => {
  resetProxyForTests()
  proxied.length = 0
  sessionCalls.length = 0
  resolveAnswer = 'DIRECT'
})

afterAll(() => {
  proxy.close()
  target.close()
})

describe('proxy decisions', () => {
  it('reads Chromium answers: first HTTP(S) proxy, DIRECT, and SOCKS skipped', () => {
    expect(proxyUrlFromChromium('PROXY corp:8080; DIRECT')).toEqual({ url: 'http://corp:8080', skippedSocks: false })
    expect(proxyUrlFromChromium('HTTPS secure:443')).toEqual({ url: 'https://secure:443', skippedSocks: false })
    expect(proxyUrlFromChromium('DIRECT')).toEqual({ url: null, skippedSocks: false })
    expect(proxyUrlFromChromium('SOCKS5 s:1080; PROXY p:3128')).toEqual({ url: 'http://p:3128', skippedSocks: true })
    expect(proxyUrlFromChromium('SOCKS5 s:1080')).toEqual({ url: null, skippedSocks: true })
  })

  it('manual beats the environment, the environment beats the OS, and direct is none', () => {
    const env = { HTTPS_PROXY: 'http://user:pw@env-proxy:3128', NO_PROXY: 'intranet' }
    expect(resolveNodeProxy(settings({ proxyMode: 'manual', proxyUrl: 'proxy.corp:8080', proxyBypass: '*.corp; 10.0.0.1' }), env, 'http://os:1')).toEqual({
      env: { HTTP_PROXY: 'http://proxy.corp:8080', HTTPS_PROXY: 'http://proxy.corp:8080', NO_PROXY: '*.corp,10.0.0.1,localhost,127.0.0.1,::1' },
      status: { source: 'manual', url: 'http://proxy.corp:8080', bypass: '*.corp,10.0.0.1' }
    })
    // The status never shows the credentials the environment carries.
    expect(resolveNodeProxy(settings({}), env, 'http://os:1').status).toEqual({
      source: 'environment',
      url: 'http://env-proxy:3128',
      bypass: 'intranet'
    })
    expect(resolveNodeProxy(settings({}), {}, 'http://os:1')).toEqual({
      env: { HTTP_PROXY: 'http://os:1', HTTPS_PROXY: 'http://os:1', NO_PROXY: 'localhost,127.0.0.1,::1' },
      status: { source: 'system', url: 'http://os:1' }
    })
    expect(resolveNodeProxy(settings({ proxyMode: 'direct' }), env, 'http://os:1')).toEqual({ env: {}, status: { source: 'none' } })
    expect(resolveNodeProxy(settings({ proxyMode: 'manual', proxyUrl: 'http://u:p@x:1' }), {}, null).status).toMatchObject({
      source: 'none',
      note: expect.stringMatching(/password/)
    })
  })
})

describe('proxy traffic', () => {
  it.runIf(!hasBuiltInProxy)('says so, and leaves Node direct, when the runtime has no built-in proxy support', () => {
    applyEarlyNodeProxy(settings({ proxyMode: 'manual', proxyUrl: 'http://proxy.corp:8080' }))
    expect(proxyStatus()).toMatchObject({ source: 'none', note: expect.stringMatching(/no built-in proxy support/) })
    expect(childProxyEnv()).toEqual({})
  })

  it.runIf(hasBuiltInProxy)('sends fetch and http.request through a manual proxy, and lets bypassed hosts go direct', async () => {
    applyEarlyNodeProxy(settings({ proxyMode: 'manual', proxyUrl: `http://127.0.0.1:${proxyPort}`, proxyBypass: 'direct.test' }))
    expect(proxyStatus()).toMatchObject({ source: 'manual' })

    // A name only the proxy can reach: fetch tunnels to it.
    const viaFetch = await fetch(`http://api.upstream.test:${targetPort}/v1/models`).then((r) => r.text())
    expect(viaFetch).toBe('target saw /v1/models')
    expect(proxied).toContain(`CONNECT api.upstream.test:${targetPort} HTTP/1.1`)

    const viaHttp = await new Promise<string>((resolve, reject) => {
      http
        .get(`http://api.upstream.test:${targetPort}/plain`, (res) => {
          let body = ''
          res.on('data', (d) => (body += d))
          res.on('end', () => resolve(body))
        })
        .on('error', reject)
    })
    expect(viaHttp).toBe('target saw /plain')
    expect(proxied.some((l) => l.startsWith(`GET http://api.upstream.test:${targetPort}/plain`))).toBe(true)

    // localhost is always direct.
    proxied.length = 0
    expect(await fetch(`http://localhost:${targetPort}/local`).then((r) => r.text())).toBe('target saw /local')
    expect(proxied).toEqual([])
  })

  it.runIf(hasBuiltInProxy)('lets a name the local resolver cannot find through when a proxy will resolve it', async () => {
    await expect(resolveAllowedUrl('https://only-behind-the-proxy.invalid/x')).rejects.toThrow()
    applyEarlyNodeProxy(settings({ proxyMode: 'manual', proxyUrl: `http://127.0.0.1:${proxyPort}` }))
    await expect(resolveAllowedUrl('https://only-behind-the-proxy.invalid/x')).resolves.toMatchObject({ addresses: [] })
    // Private addresses stay refused whatever the proxy.
    await expect(resolveAllowedUrl('http://127.0.0.1/x')).rejects.toThrow(/private or loopback/)
  })

  it.runIf(hasBuiltInProxy)('gives child processes the proxy in both spellings, and nothing when direct', () => {
    applyEarlyNodeProxy(settings({ proxyMode: 'manual', proxyUrl: 'http://proxy.corp:8080' }))
    expect(childProxyEnv()).toMatchObject({ HTTPS_PROXY: 'http://proxy.corp:8080', https_proxy: 'http://proxy.corp:8080' })
    expect(sanitizedTerminalEnv({ PATH: '/bin' })).toMatchObject({ HTTP_PROXY: 'http://proxy.corp:8080', no_proxy: 'localhost,127.0.0.1,::1' })
    applyEarlyNodeProxy(settings({ proxyMode: 'direct' }))
    expect(childProxyEnv()).toEqual({})
    expect(Object.keys(sanitizedTerminalEnv({ PATH: '/bin', HTTPS_PROXY: 'http://parent:1' })).some((k) => /proxy/i.test(k))).toBe(false)
  })
})

describe('applyNetworkSettings', () => {
  it.runIf(hasBuiltInProxy)('reads the OS proxy through Chromium when nothing else is set, and configures every session', async () => {
    const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, https_proxy: process.env.https_proxy, HTTP_PROXY: process.env.HTTP_PROXY, http_proxy: process.env.http_proxy }
    for (const k of Object.keys(saved)) delete process.env[k]
    try {
      resolveAnswer = `PROXY 127.0.0.1:${proxyPort}; DIRECT`
      const status = await applyNetworkSettings(settings({}))
      expect(status).toEqual({ source: 'system', url: `http://127.0.0.1:${proxyPort}` })
      expect(sessionCalls).toEqual(
        expect.arrayContaining([
          { partition: 'default', config: { mode: 'system' } },
          { partition: 'electron-updater', config: { mode: 'system' } }
        ])
      )
      expect(await fetch(`http://os-proxied.test:${targetPort}/sys`).then((r) => r.text())).toBe('target saw /sys')
      expect(proxied).toContain(`CONNECT os-proxied.test:${targetPort} HTTP/1.1`)

      sessionCalls.length = 0
      await applyNetworkSettings(settings({ proxyMode: 'manual', proxyUrl: 'proxy.corp:8080', proxyBypass: '*.corp' }))
      expect(sessionCalls).toContainEqual({
        partition: 'default',
        config: { mode: 'fixed_servers', proxyRules: 'http://proxy.corp:8080', proxyBypassRules: '*.corp,<local>' }
      })

      resolveAnswer = 'SOCKS5 socks.corp:1080'
      expect(await applyNetworkSettings(settings({}))).toEqual({ source: 'none', note: expect.stringMatching(/SOCKS/) })
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v
    }
  })
})
