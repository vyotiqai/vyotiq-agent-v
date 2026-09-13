import * as http from 'http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertPublicUrl,
  createPinnedLookup,
  fetchPublicResponse,
  fetchWithValidatedRedirects,
  isSyncBlockedUrl,
  resetDnsLookupForTests,
  setDnsLookupForTests,
  setPublicFetchForTests,
  spaShellWarning
} from '@main/agent/tools/webFetch'

const PUBLIC_IP = '93.184.216.34'
const PUBLIC_IPV6 = '2606:2800:220:1:248:1893:25c8:1946'

afterEach(() => {
  resetDnsLookupForTests()
  setPublicFetchForTests(null)
  vi.restoreAllMocks()
})

describe('createPinnedLookup', () => {
  it('returns a single address when options.all is false', () => {
    const lookup = createPinnedLookup([PUBLIC_IP, PUBLIC_IPV6])
    let result: unknown
    lookup('example.com', { family: 0 }, ((err, address, family) => {
      expect(err).toBeNull()
      result = { address, family }
    }) as never)
    expect(result).toEqual({ address: PUBLIC_IP, family: 4 })
  })

  it('returns [{address,family}] when options.all is true (Node 20 Happy Eyeballs)', () => {
    const lookup = createPinnedLookup([PUBLIC_IP, PUBLIC_IPV6])
    let result: unknown
    lookup('example.com', { all: true }, ((err, addresses) => {
      expect(err).toBeNull()
      result = addresses
    }) as never)
    expect(result).toEqual([
      { address: PUBLIC_IP, family: 4 },
      { address: PUBLIC_IPV6, family: 6 }
    ])
  })

  it('rejects when no public addresses remain', () => {
    expect(() => createPinnedLookup(['127.0.0.1'])).toThrow(/private or loopback/)
  })
})

describe('assertPublicUrl', () => {
  it('rejects loopback hostnames and private IPv4 literals', async () => {
    await expect(assertPublicUrl('http://localhost/')).rejects.toThrow(/private or loopback/)
    await expect(assertPublicUrl('http://127.0.0.1/')).rejects.toThrow(/private or loopback/)
    await expect(assertPublicUrl('http://127.1/')).rejects.toThrow(/private or loopback/)
    await expect(assertPublicUrl('http://2130706433/')).rejects.toThrow(/private or loopback/)
    await expect(assertPublicUrl('http://192.168.1.1/')).rejects.toThrow(/private or loopback/)
    await expect(assertPublicUrl('http://169.254.169.254/')).rejects.toThrow(/private or loopback/)
  })

  it('rejects private IPv6 literals', async () => {
    await expect(assertPublicUrl('http://[::1]/')).rejects.toThrow(/private or loopback/)
    await expect(assertPublicUrl('http://[fe80::1]/')).rejects.toThrow(/private or loopback/)
    await expect(assertPublicUrl('http://[::ffff:127.0.0.1]/')).rejects.toThrow(/private or loopback/)
    await expect(assertPublicUrl('http://[::ffff:7f00:1]/')).rejects.toThrow(/private or loopback/)
    await expect(assertPublicUrl('http://[0:0:0:0:0:ffff:127.0.0.1]/')).rejects.toThrow(
      /private or loopback/
    )
    await expect(
      assertPublicUrl('http://[0000:0000:0000:0000:0000:0000:0000:0001]/')
    ).rejects.toThrow(/private or loopback/)
  })

  it('rejects hostnames that resolve to private addresses', async () => {
    setDnsLookupForTests(async () => [{ address: '127.0.0.1', family: 4 }])

    await expect(assertPublicUrl('http://example.test/')).rejects.toThrow(/private or loopback/)
  })

  it('allows public hostnames that resolve to public addresses', async () => {
    setDnsLookupForTests(async () => [{ address: PUBLIC_IP, family: 4 }])

    const url = await assertPublicUrl('http://example.test/')
    expect(url.hostname).toBe('example.test')
  })
})

describe('isSyncBlockedUrl', () => {
  it('blocks private literals and non-http protocols without DNS', () => {
    expect(isSyncBlockedUrl('http://127.0.0.1/')).toBe(true)
    expect(isSyncBlockedUrl('http://localhost/')).toBe(true)
    expect(isSyncBlockedUrl('http://192.168.0.1/')).toBe(true)
    expect(isSyncBlockedUrl('http://2130706433/')).toBe(true)
    expect(isSyncBlockedUrl('http://127.1/')).toBe(true)
    expect(isSyncBlockedUrl('http://[::ffff:7f00:1]/')).toBe(true)
    expect(isSyncBlockedUrl('http://[::1]/')).toBe(true)
    expect(isSyncBlockedUrl('file:///etc/passwd')).toBe(true)
    expect(isSyncBlockedUrl('not a url')).toBe(true)
  })

  it('allows public hostnames pending DNS (assertPublicUrl after load)', () => {
    expect(isSyncBlockedUrl('https://example.com/')).toBe(false)
    expect(isSyncBlockedUrl(`http://${PUBLIC_IP}/`)).toBe(false)
  })
})

describe('fetchWithValidatedRedirects', () => {
  it('rejects redirects to private hosts', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1:11434/' }
      })
    })
    setPublicFetchForTests(fetchMock)

    await expect(
      fetchWithValidatedRedirects(new URL(`https://${PUBLIC_IP}/`), new AbortController().signal)
    ).rejects.toThrow(/private or loopback/)
  })

  it('follows safe redirects and validates each hop', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: `https://${PUBLIC_IP}/final` }
        })
      )
      .mockResolvedValueOnce(
        new Response('<html><body><p>hello</p></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' }
        })
      )
    setPublicFetchForTests(fetchMock)

    const { finalUrl, response } = await fetchWithValidatedRedirects(
      new URL(`https://${PUBLIC_IP}/start`),
      new AbortController().signal
    )
    expect(finalUrl.href).toBe(`https://${PUBLIC_IP}/final`)
    expect(await response.text()).toContain('hello')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('appends SPA shell warning for nav-heavy markdown', () => {
    const markdown = [
      '- [Models](/models)',
      '- [Datasets](/datasets)',
      '- [Spaces](/spaces)',
      '- [Docs](/docs)',
      '- [Enterprise](/enterprise)'
    ].join('\n')
    expect(spaShellWarning(markdown)).toMatch(/JavaScript-rendered/i)
  })
})

describe('fetchPublicResponse retries', () => {
  it('retries HTTP 503 then returns the successful body', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
        .mockResolvedValueOnce(
          new Response('{"ok":true}', {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        )
      setPublicFetchForTests(fetchMock)
      const pending = fetchPublicResponse(
        new URL(`https://${PUBLIC_IP}/v1/catalog`),
        new AbortController().signal,
        { accept: 'application/json' }
      )
      await vi.runAllTimersAsync()
      const result = await pending
      expect(result.response.status).toBe(200)
      expect(result.body.toString('utf8')).toBe('{"ok":true}')
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry HTTP 401', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('denied', { status: 401 }))
    setPublicFetchForTests(fetchMock)
    const result = await fetchPublicResponse(
      new URL(`https://${PUBLIC_IP}/v1/catalog`),
      new AbortController().signal
    )
    expect(result.response.status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('caps the buffered body at WEB_FETCH_MAX_BYTES', async () => {
    // 3 MB body — larger than the 2 MB cap. readBody must keep the buffered
    // bytes bounded regardless of how much the server streams.
    const big = 'x'.repeat(3 * 1024 * 1024)
    const fetchMock = vi.fn().mockResolvedValue(new Response(big, { status: 200 }))
    setPublicFetchForTests(fetchMock)
    const result = await fetchPublicResponse(
      new URL(`https://${PUBLIC_IP}/big`),
      new AbortController().signal
    )
    expect(result.response.status).toBe(200)
    expect(result.body.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024)
  })

  it('refuses to follow redirects on POST', async () => {
    setDnsLookupForTests(async () => [{ address: PUBLIC_IP, family: 4 }])
    setPublicFetchForTests(
      vi.fn(async () =>
        new Response(null, {
          status: 302,
          headers: { location: `https://${PUBLIC_IP}/elsewhere` }
        })
      )
    )
    await expect(
      fetchWithValidatedRedirects(
        new URL(`https://${PUBLIC_IP}/api/show`),
        AbortSignal.timeout(2000),
        { 'Content-Type': 'application/json' },
        false,
        { method: 'POST', body: '{"model":"x"}' }
      )
    ).rejects.toThrow(/Refusing to follow 302 redirect on POST/)
  })

  it('already-aborted pinned fetch rejects AbortError without uncaughtException', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = server.address()
    if (!addr || typeof addr === 'string') {
      server.close()
      throw new Error('expected TCP listen address')
    }
    const uncaught: Error[] = []
    const onUncaught = (err: Error): void => {
      uncaught.push(err)
    }
    process.on('uncaughtException', onUncaught)
    try {
      // fetchPublicResponse uses this same DNS-pinned ClientRequest path.
      // allowLocal is required so the in-process server is not blocked by SSRF.
      await expect(
        fetchWithValidatedRedirects(
          new URL(`http://127.0.0.1:${addr.port}/`),
          AbortSignal.abort(),
          undefined,
          true
        )
      ).rejects.toMatchObject({ name: 'AbortError', message: 'Aborted' })
      await new Promise<void>((resolve) => setImmediate(resolve))
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
      expect(uncaught).toEqual([])
    } finally {
      process.off('uncaughtException', onUncaught)
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    }
  })
})
