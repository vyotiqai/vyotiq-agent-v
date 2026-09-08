import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearOllamaSelectedShowCache,
  enrichOllamaModelsWithSelectedShow,
  ollamaProvider
} from '@main/agent/providers/openai'
import {
  resetDnsLookupForTests,
  setDnsLookupForTests,
  setPublicFetchForTests
} from '@main/agent/tools/webFetch'

vi.mock('@shared/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn()
  }
}))

const PUBLIC_IP = '93.184.216.34'

afterEach(() => {
  resetDnsLookupForTests()
  setPublicFetchForTests(null)
  clearOllamaSelectedShowCache()
})

describe('ollama cloud catalog auth', () => {
  it('sends Bearer on /v1/models and /api/tags for cloud hosts', async () => {
    setDnsLookupForTests(async () => [{ address: PUBLIC_IP, family: 4 }])
    const seen: Array<{ url: string; auth?: string }> = []
    setPublicFetchForTests(async (url, _addresses, _signal, headers) => {
      seen.push({ url: url.href, auth: headers?.Authorization })
      if (url.pathname.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'gpt-oss:120b' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      if (url.pathname.endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'gpt-oss:120b' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      return new Response('not found', { status: 404 })
    })

    const models = await ollamaProvider.listModels({
      baseUrl: 'https://ollama.com',
      apiKey: 'test-ollama-key',
      signal: AbortSignal.timeout(2000)
    })

    expect(models.some((m) => m.id === 'gpt-oss:120b')).toBe(true)
    const modelsCall = seen.find((s) => s.url.includes('/v1/models'))
    const tagsCall = seen.find((s) => s.url.includes('/api/tags'))
    expect(modelsCall?.auth).toBe('Bearer test-ollama-key')
    expect(tagsCall?.auth).toBe('Bearer test-ollama-key')
    expect(seen.every((s) => !s.url.includes('/v1/v1'))).toBe(true)
  })

  it('rejects cloud catalog without an API key', async () => {
    await expect(
      ollamaProvider.listModels({
        baseUrl: 'https://ollama.com',
        signal: AbortSignal.timeout(2000)
      })
    ).rejects.toThrow(/Ollama Cloud API key not set/i)
  })

  it('does not send Authorization for local Ollama without a key', async () => {
    const seen: Array<{ url: string; auth?: string }> = []
    setPublicFetchForTests(async (url, _addresses, _signal, headers) => {
      seen.push({ url: url.href, auth: headers?.Authorization })
      if (url.pathname.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'qwen2.5' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      if (url.pathname.endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'qwen2.5' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      return new Response('not found', { status: 404 })
    })

    await ollamaProvider.listModels({
      baseUrl: 'http://127.0.0.1:11434',
      signal: AbortSignal.timeout(2000)
    })

    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((s) => s.auth == null)).toBe(true)
  })

  it('normalizes baseUrl that already includes /v1', async () => {
    const seen: string[] = []
    setPublicFetchForTests(async (url) => {
      seen.push(url.href)
      if (url.pathname.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'qwen2.5' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      if (url.pathname.endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      return new Response('not found', { status: 404 })
    })

    await ollamaProvider.listModels({
      baseUrl: 'http://127.0.0.1:11434/v1',
      signal: AbortSignal.timeout(2000)
    })

    expect(seen.some((u) => u.includes('/v1/v1'))).toBe(false)
    expect(seen.some((u) => u === 'http://127.0.0.1:11434/v1/models')).toBe(true)
    expect(seen.some((u) => u === 'http://127.0.0.1:11434/api/tags')).toBe(true)
  })

  it('overlays thinking from /api/tags capabilities array', async () => {
    setDnsLookupForTests(async () => [{ address: PUBLIC_IP, family: 4 }])
    setPublicFetchForTests(async (url) => {
      if (url.pathname.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'plain-cloud-thinker' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      if (url.pathname.endsWith('/api/tags')) {
        return new Response(
          JSON.stringify({
            models: [
              {
                name: 'plain-cloud-thinker',
                capabilities: ['completion', 'tools', 'thinking']
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      return new Response('not found', { status: 404 })
    })

    const models = await ollamaProvider.listModels({
      baseUrl: 'https://ollama.com',
      apiKey: 'test-ollama-key',
      signal: AbortSignal.timeout(2000)
    })
    const m = models.find((x) => x.id === 'plain-cloud-thinker')
    expect(m?.supportsThinking).toBe(true)
    expect(m?.thinkingApi).toBe('chat_completions')
    expect(m?.thinkingMode).toBe('effort')
    expect(m?.supportedThinkingEfforts).toEqual(['low', 'medium', 'high', 'max'])
  })

  it('infers vision from tag names via the shared id heuristic', async () => {
    setDnsLookupForTests(async () => [{ address: PUBLIC_IP, family: 4 }])
    setPublicFetchForTests(async (url) => {
      if (url.pathname.endsWith('/v1/models')) {
        return new Response(
          JSON.stringify({
            data: [{ id: 'qwen2.5-vl:7b' }, { id: 'gemma3:4b' }, { id: 'gemma3:1b' }]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      if (url.pathname.endsWith('/api/tags')) {
        return new Response(
          JSON.stringify({
            models: [
              { name: 'qwen2.5-vl:7b', capabilities: ['completion'] },
              { name: 'gemma3:4b', capabilities: ['completion'] },
              { name: 'gemma3:1b', capabilities: ['completion'] }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      return new Response('not found', { status: 404 })
    })

    const models = await ollamaProvider.listModels({
      baseUrl: 'https://ollama.com',
      apiKey: 'test-ollama-key',
      signal: AbortSignal.timeout(2000)
    })
    const byId = new Map(models.map((m) => [m.id, m]))
    expect(byId.get('qwen2.5-vl:7b')?.supportsVision).toBe(true)
    expect(byId.get('gemma3:4b')?.supportsVision).toBe(true)
    expect(byId.get('gemma3:1b')?.supportsVision).toBe(false)
  })

  it('enriches selected model thinking from /api/show', async () => {
    setDnsLookupForTests(async () => [{ address: PUBLIC_IP, family: 4 }])
    const seen: Array<{ url: string; auth?: string; method?: string }> = []
    setPublicFetchForTests(async (url, _addresses, _signal, headers, _allowLocal, request) => {
      seen.push({
        url: url.href,
        auth: headers?.Authorization,
        method: request?.method
      })
      if (url.pathname.endsWith('/api/show')) {
        return new Response(
          JSON.stringify({ capabilities: ['completion', 'tools', 'thinking'] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      return new Response('not found', { status: 404 })
    })

    const next = await enrichOllamaModelsWithSelectedShow(
      [
        {
          id: 'mystery-reasoner',
          displayName: 'mystery-reasoner',
          inputModalities: ['text'],
          outputModalities: ['text'],
          supportsTools: true,
          supportsVision: false,
          supportsThinking: false
        }
      ],
      {
        model: 'mystery-reasoner',
        baseUrl: 'https://ollama.com',
        apiKey: 'test-ollama-key',
        signal: AbortSignal.timeout(2000)
      }
    )
    expect(next.find((m) => m.id === 'mystery-reasoner')?.supportsThinking).toBe(true)
    expect(next.find((m) => m.id === 'mystery-reasoner')?.thinkingMode).toBe('effort')
    expect(next.find((m) => m.id === 'mystery-reasoner')?.supportedThinkingEfforts).toEqual([
      'low',
      'medium',
      'high',
      'max'
    ])
    const show = seen.find((s) => s.url.includes('/api/show'))
    expect(show?.method).toBe('POST')
    expect(show?.auth).toBe('Bearer test-ollama-key')
  })

  it('still calls /api/show when the selected model already supports thinking', async () => {
    setDnsLookupForTests(async () => [{ address: PUBLIC_IP, family: 4 }])
    const seen: Array<{ url: string; auth?: string; method?: string }> = []
    setPublicFetchForTests(async (url, _addresses, _signal, headers, _allowLocal, request) => {
      seen.push({
        url: url.href,
        auth: headers?.Authorization,
        method: request?.method
      })
      if (url.pathname.endsWith('/api/show')) {
        return new Response(
          JSON.stringify({ capabilities: ['completion', 'tools', 'thinking'] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      return new Response('not found', { status: 404 })
    })

    const models = [
      {
        id: 'gpt-oss:120b-cloud',
        displayName: 'gpt-oss:120b-cloud',
        inputModalities: ['text'] as const,
        outputModalities: ['text'] as const,
        supportsTools: true,
        supportsVision: false,
        supportsThinking: true,
        thinkingMode: 'boolean' as const
      }
    ]
    const next = await enrichOllamaModelsWithSelectedShow(models, {
      model: 'gpt-oss:120b-cloud',
      baseUrl: 'https://ollama.com',
      apiKey: 'test-ollama-key',
      signal: AbortSignal.timeout(2000)
    })
    expect(next.find((m) => m.id === 'gpt-oss:120b-cloud')?.thinkingMode).toBe('effort')
    expect(next.find((m) => m.id === 'gpt-oss:120b-cloud')?.thinkingCanDisable).toBe(false)
    expect(next.find((m) => m.id === 'gpt-oss:120b-cloud')?.supportedThinkingEfforts).toEqual([
      'low',
      'medium',
      'high'
    ])
    const show = seen.find((s) => s.url.includes('/api/show'))
    expect(show?.method).toBe('POST')
    expect(show?.auth).toBe('Bearer test-ollama-key')
  })

  it('parses context_length from /api/show model_info even when effort ladder exists', async () => {
    setDnsLookupForTests(async () => [{ address: PUBLIC_IP, family: 4 }])
    setPublicFetchForTests(async (url) => {
      if (url.pathname.endsWith('/api/show')) {
        return new Response(
          JSON.stringify({
            capabilities: ['completion', 'tools', 'thinking'],
            model_info: {
              'general.architecture': 'qwen2',
              'qwen2.context_length': 131_072
            },
            parameters: 'num_ctx                        8192\n'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      return new Response('not found', { status: 404 })
    })

    const models = [
      {
        id: 'qwen2.5:32b',
        displayName: 'qwen2.5:32b',
        inputModalities: ['text'] as const,
        outputModalities: ['text'] as const,
        supportsTools: true,
        supportsVision: false,
        supportsThinking: true,
        thinkingMode: 'effort' as const,
        supportedThinkingEfforts: ['low', 'medium', 'high', 'max'] as const
      }
    ]
    const next = await enrichOllamaModelsWithSelectedShow(models, {
      model: 'qwen2.5:32b',
      baseUrl: 'https://ollama.com',
      apiKey: 'test-ollama-key',
      signal: AbortSignal.timeout(2000)
    })
    // Architecture max wins over Modelfile num_ctx
    expect(next.find((m) => m.id === 'qwen2.5:32b')?.contextWindow).toBe(131_072)
  })

  it('falls back to num_ctx from parameters on local Ollama when model_info omits context_length', async () => {
    setPublicFetchForTests(async (url) => {
      if (url.pathname.endsWith('/api/show')) {
        return new Response(
          JSON.stringify({
            capabilities: ['completion', 'tools'],
            parameters: 'temperature 0.7\nnum_ctx 65536\n'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      return new Response('not found', { status: 404 })
    })

    const next = await enrichOllamaModelsWithSelectedShow(
      [
        {
          id: 'llama3.2',
          displayName: 'llama3.2',
          inputModalities: ['text'],
          outputModalities: ['text'],
          supportsTools: true,
          supportsVision: false
        }
      ],
      {
        model: 'llama3.2',
        baseUrl: 'http://127.0.0.1:11434',
        signal: AbortSignal.timeout(2000)
      }
    )
    expect(next.find((m) => m.id === 'llama3.2')?.contextWindow).toBe(65_536)
  })

  it('leaves Cloud thinking unset when tags omit capabilities', async () => {
    setDnsLookupForTests(async () => [{ address: PUBLIC_IP, family: 4 }])
    setPublicFetchForTests(async (url) => {
      if (url.pathname.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'glm-5.2' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      if (url.pathname.endsWith('/api/tags')) {
        return new Response(
          JSON.stringify({
            models: [{ name: 'glm-5.2', details: {} }]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      return new Response('not found', { status: 404 })
    })

    const models = await ollamaProvider.listModels({
      baseUrl: 'https://ollama.com',
      apiKey: 'test-ollama-key',
      signal: AbortSignal.timeout(2000)
    })
    const m = models.find((x) => x.id === 'glm-5.2')
    expect(m?.supportsThinking).toBeUndefined()
    expect(m?.contextWindow).toBeUndefined()
  })

  it('parses details.context_length from Cloud /api/show without model_info', async () => {
    setDnsLookupForTests(async () => [{ address: PUBLIC_IP, family: 4 }])
    setPublicFetchForTests(async (url) => {
      if (url.pathname.endsWith('/api/show')) {
        return new Response(
          JSON.stringify({
            capabilities: ['completion', 'tools', 'thinking'],
            details: { context_length: 976_000 },
            parameters: 'num_ctx 8192\n'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      return new Response('not found', { status: 404 })
    })

    const next = await enrichOllamaModelsWithSelectedShow(
      [
        {
          id: 'glm-5.2',
          displayName: 'glm-5.2',
          inputModalities: ['text'],
          outputModalities: ['text'],
          supportsTools: true,
          supportsVision: false
        }
      ],
      {
        model: 'glm-5.2',
        baseUrl: 'https://ollama.com',
        apiKey: 'test-ollama-key',
        signal: AbortSignal.timeout(2000)
      }
    )
    expect(next.find((m) => m.id === 'glm-5.2')?.contextWindow).toBe(976_000)
    expect(next.find((m) => m.id === 'glm-5.2')?.supportsThinking).toBe(true)
  })

  it('ignores Cloud Modelfile num_ctx when show has no architecture window', async () => {
    setDnsLookupForTests(async () => [{ address: PUBLIC_IP, family: 4 }])
    setPublicFetchForTests(async (url) => {
      if (url.pathname.endsWith('/api/show')) {
        return new Response(
          JSON.stringify({
            parameters: 'num_ctx 8192\n'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      return new Response('not found', { status: 404 })
    })

    const next = await enrichOllamaModelsWithSelectedShow(
      [
        {
          id: 'minimax-m3',
          displayName: 'minimax-m3',
          inputModalities: ['text'],
          outputModalities: ['text'],
          supportsTools: true,
          supportsVision: false
        }
      ],
      {
        model: 'minimax-m3',
        baseUrl: 'https://ollama.com',
        apiKey: 'test-ollama-key',
        signal: AbortSignal.timeout(2000)
      }
    )
    expect(next.find((m) => m.id === 'minimax-m3')?.contextWindow).toBeUndefined()
    expect(next.find((m) => m.id === 'minimax-m3')?.supportsThinking).toBeUndefined()
  })

  it('strips :cloud when POSTing /api/show and aliases the catalog row', async () => {
    setDnsLookupForTests(async () => [{ address: PUBLIC_IP, family: 4 }])
    const showBodies: string[] = []
    setPublicFetchForTests(async (url, _addresses, _signal, _headers, _allowLocal, request) => {
      if (url.pathname.endsWith('/api/show')) {
        showBodies.push(request?.body ?? '')
        return new Response(
          JSON.stringify({
            capabilities: ['completion', 'tools', 'thinking'],
            context_length: '131072'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      return new Response('not found', { status: 404 })
    })

    const next = await enrichOllamaModelsWithSelectedShow(
      [
        {
          id: 'gpt-oss:120b',
          displayName: 'gpt-oss:120b',
          inputModalities: ['text'],
          outputModalities: ['text'],
          supportsTools: true,
          supportsVision: false
        }
      ],
      {
        model: 'gpt-oss:120b-cloud',
        baseUrl: 'https://ollama.com',
        apiKey: 'test-ollama-key',
        signal: AbortSignal.timeout(2000)
      }
    )
    expect(JSON.parse(showBodies[0] ?? '{}')).toEqual({ model: 'gpt-oss:120b' })
    const m = next.find((x) => x.id === 'gpt-oss:120b')
    expect(m?.contextWindow).toBe(131_072)
    expect(m?.supportsThinking).toBe(true)
    expect(m?.thinkingCanDisable).toBe(false)
  })

  it('does not mark empty Cloud show complete so a later retry still fetches', async () => {
    setDnsLookupForTests(async () => [{ address: PUBLIC_IP, family: 4 }])
    let showCalls = 0
    setPublicFetchForTests(async (url) => {
      if (url.pathname.endsWith('/api/show')) {
        showCalls += 1
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      return new Response('not found', { status: 404 })
    })

    const stub = [
      {
        id: 'glm-5.2',
        displayName: 'glm-5.2',
        inputModalities: ['text'] as const,
        outputModalities: ['text'] as const,
        supportsTools: true,
        supportsVision: false,
        supportsThinking: false
      }
    ]
    const first = await enrichOllamaModelsWithSelectedShow(stub, {
      model: 'glm-5.2',
      baseUrl: 'https://ollama.com',
      apiKey: 'test-ollama-key',
      signal: AbortSignal.timeout(2000)
    })
    expect(first.find((m) => m.id === 'glm-5.2')?.supportsThinking).toBeUndefined()

    await enrichOllamaModelsWithSelectedShow(first, {
      model: 'glm-5.2',
      baseUrl: 'https://ollama.com',
      apiKey: 'test-ollama-key',
      signal: AbortSignal.timeout(2000)
    })
    expect(showCalls).toBe(2)
  })
})
