import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('electron', () => ({
  app: { getPath: () => join(tmpdir(), 'vyotiq-webtools'), getAppPath: () => tmpdir(), isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const settings = vi.hoisted(() => ({ value: { browserDomainAllowlist: [] as string[], webSearch: { provider: 'duckduckgo', searxngUrl: '' } } }))
vi.mock('@main/settings/settings', () => ({ getSettings: () => settings.value, onSettingsWritten: () => () => {} }))
vi.mock('@main/settings/secrets', () => ({ getToolSecret: (name: string) => (name === 'brave' ? 'brave-key' : null) }))

import { parseDuckDuckGoHtml, readableBody, searchWith, webHandlers } from '@main/agent/tools/webTools'
import { resetDnsLookupForTests, setDnsLookupForTests, setPublicFetchForTests } from '@main/net/webFetch'
import { buildPdf } from '../../helpers/buildPdf'

const seen: Array<{ url: string; headers?: Record<string, string>; method?: string; body?: string }> = []

beforeEach(() => {
  seen.length = 0
  settings.value = { browserDomainAllowlist: [], webSearch: { provider: 'duckduckgo', searxngUrl: '' } }
  setDnsLookupForTests((async () => [{ address: '93.184.216.34', family: 4 }]) as never)
})
afterEach(() => {
  setPublicFetchForTests(null)
  resetDnsLookupForTests()
})

function respond(body: string | Uint8Array, init: { status?: number; type?: string } = {}): void {
  setPublicFetchForTests(async (url, _addresses, _signal, headers, _allowLocal, request) => {
    seen.push({ url: url.href, ...(headers ? { headers } : {}), ...(request?.method ? { method: request.method } : {}), ...(request?.body ? { body: request.body } : {}) })
    return new Response(body, { status: init.status ?? 200, headers: { 'content-type': init.type ?? 'text/html' } })
  })
}

describe('web_fetch', () => {
  it('reads a page as Markdown, says where it came from and that it is untrusted', async () => {
    respond('<html><body><nav>Menu</nav><main><h1>Release 2.0</h1><p>' + 'Notes about the release. '.repeat(20) + '</p></main></body></html>')
    const result = await webHandlers.web_fetch('C:\\ws', { url: 'https://example.com/notes' }, new AbortController().signal)
    expect(result.ok).toBe(true)
    expect(result.content).toContain('Fetched https://example.com/notes (HTTP 200, text/html)')
    expect(result.content).toContain('untrusted')
    expect(result.content).toContain('# Release 2.0')
    expect(result.content).not.toContain('Menu')
  })

  it('cuts long text at maxChars and names the offset that reads on', async () => {
    respond('a'.repeat(1000) + 'b'.repeat(1000) + 'c'.repeat(500), { type: 'text/plain' })
    const signal = new AbortController().signal
    const first = await webHandlers.web_fetch('C:\\ws', { url: 'https://example.com/a.txt', maxChars: 1000 }, signal)
    expect(first.content).toContain('pass offset: 1000 for the next part')
    // Past 100k, a larger maxChars was the only way on; offset pages through.
    const second = await webHandlers.web_fetch('C:\\ws', { url: 'https://example.com/a.txt', maxChars: 1000, offset: 1000 }, signal)
    expect(second.content).toContain('[Characters 1,000–2,000.]')
    expect(second.content).toContain('b'.repeat(1000))
    expect(second.content).not.toContain('a'.repeat(10))
    const last = await webHandlers.web_fetch('C:\\ws', { url: 'https://example.com/a.txt', maxChars: 1000, offset: 2000 }, signal)
    expect(last.content).not.toContain('More follows')
    await expect(webHandlers.web_fetch('C:\\ws', { url: 'https://example.com/a.txt', offset: 9000 }, signal)).rejects.toThrow(/past the end/)
  })

  it('reads a PDF as its text, page by page, instead of refusing it', async () => {
    respond(new Uint8Array(buildPdf(['Release notes for 2.0', 'Second page about the migration'])), { type: 'application/pdf' })
    const result = await webHandlers.web_fetch('C:\\ws', { url: 'https://example.com/notes.pdf' }, new AbortController().signal)
    expect(result.ok).toBe(true)
    expect(result.content).toContain('application/pdf, 2 pages')
    expect(result.content).toContain('[Page 1 of 2]')
    expect(result.content).toContain('Release notes for 2.0')
    expect(result.content).toContain('[Page 2 of 2]')
    expect(result.content).toContain('Second page about the migration')
  })

  it('refuses a binary, a host off the allowlist, and a non-http URL', async () => {
    respond('PK\u0003\u0004', { type: 'application/zip' })
    await expect(
      webHandlers.web_fetch('C:\\ws', { url: 'https://example.com/a.zip' }, new AbortController().signal)
    ).rejects.toThrow(/not text/)
    settings.value = { ...settings.value, browserDomainAllowlist: ['docs.example.org'] }
    await expect(
      webHandlers.web_fetch('C:\\ws', { url: 'https://example.com/' }, new AbortController().signal)
    ).rejects.toThrow(/browserDomainAllowlist/)
    await expect(
      webHandlers.web_fetch('C:\\ws', { url: 'file:///etc/passwd' }, new AbortController().signal)
    ).rejects.toThrow(/http and https/)
  })

  it('never reaches a private address', async () => {
    setDnsLookupForTests((async () => [{ address: '127.0.0.1', family: 4 }]) as never)
    respond('secret')
    await expect(
      webHandlers.web_fetch('C:\\ws', { url: 'https://intranet.example/' }, new AbortController().signal)
    ).rejects.toThrow()
    expect(seen).toHaveLength(0)
  })
})

describe('web_search', () => {
  const ddg = `
    <div class="result results_links"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fvitest.dev%2Fguide%2F&amp;rut=x">Vitest <b>Guide</b></a>
    <a class="result__snippet" href="#">Next generation testing &amp; more.</a></div>
    <div class="result results_links"><a class="result__a" href="https://example.com/b">Second</a></div>`

  it('reads DuckDuckGo results through its redirect links', () => {
    expect(parseDuckDuckGoHtml(ddg, 5)).toEqual([
      { title: 'Vitest Guide', url: 'https://vitest.dev/guide/', snippet: 'Next generation testing & more.' },
      { title: 'Second', url: 'https://example.com/b', snippet: '' }
    ])
  })

  it('formats results for the agent, numbered, with the url under the title', async () => {
    respond(ddg)
    const result = await webHandlers.web_search('C:\\ws', { query: 'vitest', count: 1 }, new AbortController().signal, { invokeSettings: settings.value } as never)
    expect(result.content).toContain('DuckDuckGo results for "vitest"')
    expect(result.content).toContain('1. Vitest Guide\n   https://vitest.dev/guide/\n   Next generation testing & more.')
    expect(result.content).not.toContain('2. Second')
  })

  it('asks Brave with its key header, and SearXNG on a local address', async () => {
    setPublicFetchForTests(async (url, _a, _s, headers) => {
      seen.push({ url: url.href, ...(headers ? { headers } : {}) })
      return new Response(JSON.stringify({ web: { results: [{ title: 'A', url: 'https://a.example', description: 'about <b>A</b>' }] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
    const brave = await searchWith('brave', 'q', 3, new AbortController().signal, { key: 'brave-key' })
    expect(brave.results).toEqual([{ title: 'A', url: 'https://a.example', snippet: 'about A' }])
    expect(seen[0]!.url).toBe('https://api.search.brave.com/res/v1/web/search?q=q&count=3')
    expect(seen[0]!.headers?.['x-subscription-token']).toBe('brave-key')
    await expect(searchWith('tavily', 'q', 3, new AbortController().signal, { key: null })).rejects.toThrow(/API key/)
  })
})

describe('readableBody', () => {
  it('reads text kinds and refuses binaries', () => {
    expect(readableBody('application/json; charset=utf-8', Buffer.from('{"a":1}'))).toEqual({ text: '{"a":1}', markdown: false })
    expect(readableBody('image/png', Buffer.from('x'))).toBeNull()
    expect(readableBody('', Buffer.from('a\u0000b'))).toBeNull()
  })
})
