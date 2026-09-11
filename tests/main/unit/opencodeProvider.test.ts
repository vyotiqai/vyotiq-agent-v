import { describe, expect, it, beforeAll, vi, afterEach } from 'vitest'
import { ProviderIdSchema } from '@shared/ipc/schemas/providers'
import type { ModelInfo } from '@shared/ipc'
import { seedModelsFor } from '@shared/providers'
import {
  opencodeGoTransportFor,
  loadOpenCodeGoCatalog,
  preloadOpenCodeGoCatalog
} from '@shared/domain/opencodeGoCatalog'
import { PUBLIC_CATALOG_PROVIDERS, getProvider } from '@main/agent/providers'
import { buildOpenAiCompatBody, shouldRetryOmitCacheKey } from '@main/agent/providers/openai'
import { buildAnthropicBody } from '@main/agent/providers/anthropic'
import { streamOpenAiResponses } from '@main/agent/providers/openaiResponses'
import {
  mergeGoMeta,
  opencodeEndpointFor,
  OPENCODE_CHAT_OPTS,
  OPENCODE_GO_BASE
} from '@main/agent/providers/opencode'

// Endpoints table from https://opencode.ai/docs/go/ — structural routing only.
const RESPONSES_ENDPOINT_MODELS = [
  'grok-4.5',
  'grok-4.6',
  'gpt-5.6-luna',
  'muse-spark-1.2-contributor',
  'muse-spark-1.3-contributor'
]
const MESSAGES_ENDPOINT_MODELS = [
  'minimax-m3',
  'minimax-m2.7',
  'minimax-m2.5',
  'qwen3.8-max',
  'qwen3.7-max',
  'qwen3.7-plus',
  'qwen3.6-plus'
]

// Resolve the live models.dev `opencode-go` registry before any assertion that
// depends on runtime-fetched metadata (context windows, effort ladders).
// 30s: the public fetch can exceed vitest's 10s default under full-suite load.
beforeAll(async () => {
  await loadOpenCodeGoCatalog()
}, 30_000)

describe('OpenCode Go (opencode) provider wiring', () => {
  it('is a recognized provider id', () => {
    expect(ProviderIdSchema.safeParse('opencode').success).toBe(true)
  })

  it('seeds with the live registry model ids, all bare (no opencode-go/ prefix)', async () => {
    const state = await loadOpenCodeGoCatalog()
    const liveIds = [...state.models.keys()].sort()
    const models = seedModelsFor('opencode')
    // Seeds are sourced from the same live registry — every live id is seeded.
    expect(models.length).toBe(liveIds.length)
    expect(models.map((m) => m.id).sort()).toEqual(liveIds)
    for (const m of models) {
      expect(m.id).not.toMatch(/^opencode-go\//)
    }
  })

  it('routes Responses-API models to /responses', () => {
    for (const id of RESPONSES_ENDPOINT_MODELS) {
      expect(opencodeEndpointFor(id)).toBe('responses')
      expect(opencodeEndpointFor(`opencode-go/${id}`)).toBe('responses')
    }
  })

  it('routes Anthropic Messages models to /messages', () => {
    for (const id of MESSAGES_ENDPOINT_MODELS) {
      expect(opencodeEndpointFor(id)).toBe('messages')
      expect(opencodeEndpointFor(`opencode-go/${id}`)).toBe('messages')
    }
  })

  it('defaults every other routed model to chat completions', () => {
    // Spot-check documented chat models route to chat.
    for (const id of ['kimi-k3', 'glm-5.2', 'deepseek-v4-pro', 'hy3', 'longcat-2.0']) {
      expect(opencodeEndpointFor(id)).toBe('chat')
    }
  })

  it('routes live-catalog-only ids by their documented family', () => {
    expect(opencodeGoTransportFor('qwen3.5-plus')).toBe('messages')
    for (const id of ['kimi-k2.5', 'glm-5', 'mimo-v2-pro', 'mimo-v2-omni', 'hy3-preview']) {
      expect(opencodeGoTransportFor(id)).toBe('chat')
      expect(opencodeEndpointFor(id)).toBe('chat')
    }
  })

  it('is listed as a public (keyless) catalog provider', () => {
    expect(PUBLIC_CATALOG_PROVIDERS.has('opencode')).toBe(true)
    expect(getProvider('opencode').id).toBe('opencode')
  })

  it('backfills seeds with registry context/output windows and modalities', () => {
    const models = new Map(seedModelsFor('opencode').map((m) => [m.id, m]))
    const glm52 = models.get('glm-5.2')!
    expect(glm52.contextWindow).toBe(1_000_000)
    expect(glm52.maxOutputTokens).toBe(131_072)
    expect(models.get('kimi-k3')!.contextWindow).toBe(1_048_576)
    expect(models.get('hy3')!.contextWindow).toBe(256_000)
    expect(models.get('minimax-m3')!.maxOutputTokens).toBe(131_072)
    expect(models.get('deepseek-v4-pro')!.maxOutputTokens).toBe(384_000)
    expect(models.get('kimi-k3')!.inputModalities).toContain('image')
    expect(models.get('gpt-5.6-luna')!.inputModalities).toContain('file')
  })

  it('exposes thinking with transport-aware API and effort ladders on seeds', () => {
    const models = new Map(seedModelsFor('opencode').map((m) => [m.id, m]))
    const grok = models.get('grok-4.5')!
    expect(grok.supportsThinking).toBe(true)
    expect(grok.thinkingApi).toBe('responses')
    expect(grok.supportedThinkingEfforts).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh'])

    const minimax = models.get('minimax-m3')!
    expect(minimax.thinkingApi).toBe('messages')
    expect(minimax.supportedThinkingEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    // Messages mount is Anthropic-native: budget policy, not the effort dialect.
    expect(minimax.thinkingMode).toBe('manual')

    const glm = models.get('glm-5.2')!
    expect(glm.thinkingApi).toBe('chat_completions')
    expect(glm.supportedThinkingEfforts).toEqual(['high', 'max'])
    expect(glm.thinkingCanDisable).toBe(false)

    const glm53 = models.get('glm-5.3')!
    expect(glm53.thinkingApi).toBe('chat_completions')
    expect(glm53.supportedThinkingEfforts).toEqual(['low', 'high', 'max'])
    expect(glm53.thinkingCanDisable).toBe(false)

    // hy3 declares an `effort: none` rung, so disable must stay available.
    expect(models.get('hy3')!.thinkingCanDisable).toBe(true)

    // Registry marks every Go model reasoning-capable — even non-family ids.
    for (const id of ['longcat-2.0', 'hy3', 'mimo-v2.5', 'ox-alpha-free']) {
      const m = models.get(id)!
      expect(m.supportsThinking).toBe(true)
      expect(m.supportedThinkingEfforts?.length ?? 0).toBeGreaterThan(0)
    }
  })

  it('clamps live catalog rows to the registry ladder and marks disable unsupported', async () => {
    const live: ModelInfo = {
      id: 'opencode-go/glm-5.3-flash',
      displayName: 'GLM-5.3-Flash (2x usage)',
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportsTools: true,
      supportsVision: false,
      supportsThinking: true,
      thinkingApi: 'chat_completions',
      thinkingMode: 'effort',
      thinkingCanDisable: true,
      supportedThinkingEfforts: ['low', 'medium', 'high']
    }
    const merged = await mergeGoMeta(live)
    expect(merged.id).toBe('glm-5.3-flash')
    expect(merged.supportedThinkingEfforts).toEqual(['low', 'high', 'max'])
    expect(merged.thinkingCanDisable).toBe(false)
    // No declared ladder → row metadata passes through untouched.
    const glm5 = await mergeGoMeta({ ...live, id: 'glm-5' })
    expect(glm5.supportedThinkingEfforts).toEqual(['low', 'medium', 'high'])
    expect(glm5.thinkingCanDisable).toBe(true)
  })
})

describe('opencode chat transport prompt-cache wiring', () => {
  it('ships enablePromptCache so the loop promptCacheKey reaches the wire', () => {
    expect(OPENCODE_CHAT_OPTS.enablePromptCache).toBe(true)
  })

  it('ships optionalApiKey so the public /models catalog loads before a key is saved (live: HTTP 200 keyless)', () => {
    expect(OPENCODE_CHAT_OPTS.optionalApiKey).toBe(true)
  })

  it('ships stripReasoningReplay so prior-turn reasoning never re-enters history (live 6265fa90: ritual openers 21/24 steps, 98% of thinking bytes, zero compactions)', () => {
    expect(OPENCODE_CHAT_OPTS.stripReasoningReplay).toBe(true)
  })

  it('chat bodies carry prompt_cache_key for cache affinity (live 72d5df60: 0%/100% shard bounce)', () => {
    const body = buildOpenAiCompatBody(
      {
        model: 'glm-5.3-flash',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        signal: new AbortController().signal,
        promptCacheKey: 'run-xyz'
      },
      OPENCODE_CHAT_OPTS,
      'opencode'
    )
    expect(body.prompt_cache_key).toBe('run-xyz')
  })

  it('chat bodies omit prior-turn reasoning_content while the wire body still carries everything else', () => {
    const body = buildOpenAiCompatBody(
      {
        model: 'glm-5.3-flash',
        messages: [
          {
            role: 'assistant',
            content: '',
            reasoningState: { kind: 'openai_compat', reasoningContent: 'stale thinking' },
            toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }]
          },
          { role: 'tool', toolCallId: 'c1', content: '{}' }
        ],
        tools: [],
        signal: new AbortController().signal
      },
      OPENCODE_CHAT_OPTS,
      'opencode'
    )
    const wire = body.messages as Array<Record<string, unknown>>
    const assistant = wire.find((m) => m.role === 'assistant')
    expect(assistant?.reasoning_content).toBeUndefined()
    expect(assistant?.tool_calls).toBeDefined()
  })
})

describe('prompt cache key field-rejection fallback', () => {
  it('retries 400/422 when the body names prompt_cache_key as rejected', () => {
    expect(
      shouldRetryOmitCacheKey(
        400,
        JSON.stringify({ error: { message: 'Extra inputs are not permitted: prompt_cache_key' } })
      )
    ).toBe(true)
    expect(
      shouldRetryOmitCacheKey(
        422,
        JSON.stringify({ message: 'Unknown parameter: prompt_cache_key' })
      )
    ).toBe(true)
  })

  it('does not retry unrelated errors or other statuses', () => {
    expect(
      shouldRetryOmitCacheKey(400, JSON.stringify({ error: { message: 'invalid model' } }))
    ).toBe(false)
    expect(shouldRetryOmitCacheKey(500, 'prompt_cache_key is bad')).toBe(false)
  })
})

describe('opencode non-chat transport cache wiring (regression pins)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** Minimal SSE body for a completed Responses interaction (no data assertions needed). */
  function responsesSse(): Response {
    return new Response(
      [
        'data: {"type":"response.output_text.delta","delta":"ok"}\n\n',
        'data: {"type":"response.completed","response":{"id":"resp_cache_pin"}}\n\n'
      ].join(''),
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    )
  }

  it('responses transport sends prompt_cache_key with the gateway base URL', async () => {
    let capturedUrl = ''
    let capturedBody: Record<string, unknown> | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = String(input)
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return responsesSse()
      })
    )

    await collectChunks(
      streamOpenAiResponses(
        {
          model: 'gpt-5.6-luna',
          messages: [{ role: 'user', content: 'hi' }],
          tools: [],
          signal: new AbortController().signal,
          apiKey: 'test-key',
          promptCacheKey: 'run-xyz'
        },
        `${OPENCODE_GO_BASE}/responses`
      )
    )

    expect(OPENCODE_GO_BASE).toBe('https://opencode.ai/zen/go/v1')
    expect(capturedUrl).toBe('https://opencode.ai/zen/go/v1/responses')
    expect(capturedBody?.prompt_cache_key).toBe('run-xyz')
  })

  it('messages transport marks cache_control breakpoints on tools, system, and history', () => {
    const body = buildAnthropicBody({
      model: 'minimax-m3',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'second' },
        { role: 'user', content: 'third' }
      ],
      systemStable: 'stable instructions',
      systemVolatile: 'clock=step-1',
      tools: [
        { name: 'read', description: 'read', parameters: { type: 'object', properties: {} } },
        { name: 'edit', description: 'edit', parameters: { type: 'object', properties: {} } }
      ],
      signal: new AbortController().signal,
      apiKey: 'test-key'
    })

    const tools = body.tools as Array<Record<string, unknown>>
    expect(tools.at(-1)?.cache_control).toEqual({ type: 'ephemeral' })

    const system = body.system as Array<Record<string, unknown>>
    expect(system[0]?.cache_control).toEqual({ type: 'ephemeral' })

    const messages = body.messages as Array<{ role: string; content: unknown }>
    const historyLast = messages[messages.length - 2] // before the trailing volatile user message
    expect(historyLast.role).toBe('user')
    const lastBlock = (historyLast.content as Array<Record<string, unknown>>).at(-1)
    expect(lastBlock?.cache_control).toEqual({ type: 'ephemeral' })
    // Volatile rides AFTER the cacheable prefix as an unmarked trailing message.
    const volatileMsg = messages.at(-1)
    expect(JSON.stringify(volatileMsg?.content)).not.toContain('cache_control')
  })
})

/** Drain a stream generator to completion, discarding the chunks. */
async function collectChunks(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _chunk of gen) void _chunk
}
