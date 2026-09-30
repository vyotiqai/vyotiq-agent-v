import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server } from 'http'
import type { CustomProvider } from '@shared/ipc'

const settingsState: { customProviders: CustomProvider[] } = { customProviders: [] }
vi.mock('@main/settings/settings', () => ({ getSettings: () => settingsState }))

import { getProvider } from '@main/agent/providers'
import type { StreamChunk } from '@main/agent/providers/types'
import {
  normalizeAzureOpenAiBaseUrl,
  resolveProviderChatBaseUrl,
  resolveProviderRequestExtras,
  validateAzureOpenAiBaseUrl
} from '@shared/domain/providers'
import { customHeaderError, sanitizeCustomHeaders } from '@shared/domain/network'
import { normalizeCustomProviders } from '@shared/ipc/schemas/settings'

type Seen = { method: string; url: string; headers: IncomingMessage['headers'] }
let server: Server
let origin = ''
const seen: Seen[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers })
      if (req.url!.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'my-gpt-deployment', object: 'model' }] }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'hi from azure' } }] })}\n\n` +
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n` +
          'data: [DONE]\n\n'
      )
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  origin = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})
afterAll(() => server.close())
beforeEach(() => {
  seen.length = 0
})

describe('Azure OpenAI endpoints', () => {
  it('normalizes any pasted Azure URL to the resource v1 base', () => {
    expect(
      normalizeAzureOpenAiBaseUrl(
        'https://my-res.openai.azure.com/openai/deployments/gpt/chat/completions?api-version=2024-10-21'
      )
    ).toBe('https://my-res.openai.azure.com/openai/v1')
    expect(normalizeAzureOpenAiBaseUrl('my-res.services.ai.azure.com')).toBe('https://my-res.services.ai.azure.com/openai/v1')
    expect(validateAzureOpenAiBaseUrl('http://my-res.openai.azure.com')).toEqual({ ok: false, error: expect.stringMatching(/https/) })
    expect(validateAzureOpenAiBaseUrl('https://my-res.openai.azure.com/')).toEqual({
      ok: true,
      url: 'https://my-res.openai.azure.com/openai/v1'
    })
  })

  it('resolves an Azure entry to its v1 base, the api-key header and its own headers', () => {
    const settings = {
      customProviders: [
        { id: 'custom:azure' as const, name: 'Azure', baseUrl: 'https://my-res.openai.azure.com', kind: 'azure' as const, headers: { 'X-Team': 'infra', Host: 'evil' } },
        { id: 'custom:plain' as const, name: 'Plain', baseUrl: 'https://api.example.com/v1' }
      ]
    }
    expect(resolveProviderChatBaseUrl('custom:azure', settings)).toBe('https://my-res.openai.azure.com/openai/v1')
    expect(resolveProviderRequestExtras('custom:azure', settings)).toEqual({ headers: { 'X-Team': 'infra' }, apiKeyHeader: 'api-key' })
    expect(resolveProviderRequestExtras('custom:plain', settings)).toEqual({})
    expect(resolveProviderRequestExtras('openai', settings)).toEqual({})
  })
})

describe('custom headers', () => {
  it('refuses names that are not tokens, app-owned headers and line breaks', () => {
    expect(customHeaderError('X-Org', 'acme')).toBeNull()
    expect(customHeaderError('Bad Name', 'x')).toMatch(/not a header name/)
    expect(customHeaderError('Content-Length', '1')).toMatch(/set by the app/)
    expect(customHeaderError('X-Evil', 'a\r\nHost: b')).toMatch(/line break/)
    expect(sanitizeCustomHeaders({ 'X-A': ' 1 ', 'x-a': '2', 'Bad Name': 'x', Host: 'h' })).toEqual({ 'X-A': '1' })
  })

  it('keeps an endpoint whose headers are partly bad, dropping only the bad ones', () => {
    const out = normalizeCustomProviders([
      { id: 'custom:a', name: 'A', baseUrl: 'https://a.openai.azure.com', kind: 'azure', headers: { 'X-Ok': 'y', 'Bad Name': 'z' } },
      // Same Azure resource pasted another way: a duplicate, dropped.
      { id: 'custom:b', name: 'B', baseUrl: 'https://a.openai.azure.com/openai/v1', kind: 'azure' }
    ])
    expect(out).toEqual([{ id: 'custom:a', name: 'A', baseUrl: 'https://a.openai.azure.com', kind: 'azure', headers: { 'X-Ok': 'y' } }])
  })

  it('sends the key as api-key and the endpoint headers on chat and model listing, through getProvider', async () => {
    settingsState.customProviders = [
      { id: 'custom:azure', name: 'Azure', baseUrl: `${origin}/openai/v1`, kind: 'azure', headers: { 'X-Team': 'infra' } }
    ]
    const provider = getProvider('custom:azure')
    const chunks: StreamChunk[] = []
    for await (const c of provider.streamChat({
      model: 'my-gpt-deployment',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      apiKey: 'azure-key-123',
      baseUrl: `${origin}/openai/v1`,
      signal: new AbortController().signal
    })) {
      chunks.push(c)
    }
    expect(chunks.filter((c) => c.type === 'text').map((c) => c.text).join('')).toBe('hi from azure')
    const chat = seen.find((s) => s.method === 'POST')!
    expect(chat.url).toBe('/openai/v1/chat/completions')
    expect(chat.headers['api-key']).toBe('azure-key-123')
    expect(chat.headers.authorization).toBeUndefined()
    expect(chat.headers['x-team']).toBe('infra')

    seen.length = 0
    const models = await provider.listModels({ apiKey: 'azure-key-123', baseUrl: `${origin}/openai/v1` })
    expect(models.map((m) => m.id)).toEqual(['my-gpt-deployment'])
    expect(seen[0]).toMatchObject({ url: '/openai/v1/models', headers: { 'api-key': 'azure-key-123', 'x-team': 'infra' } })
    expect(seen[0]!.headers.authorization).toBeUndefined()
  })

  it('leaves a plain custom endpoint on Bearer with no extra headers', async () => {
    settingsState.customProviders = [{ id: 'custom:plain', name: 'Plain', baseUrl: `${origin}/v1` }]
    for await (const _ of getProvider('custom:plain').streamChat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      apiKey: 'k',
      baseUrl: `${origin}/v1`,
      signal: new AbortController().signal
    })) {
      void _
    }
    const chat = seen.find((s) => s.method === 'POST')!
    expect(chat.headers.authorization).toBe('Bearer k')
    expect(chat.headers['api-key']).toBeUndefined()
  })
})
