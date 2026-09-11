import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  compatStreamOptions,
  buildOpenAiCompatBody,
  openAiCompatMessageReasoningDelta,
  parseOpenAiCompatDeltaContent,
  parseOpenAiCompatUsage,
  toOpenAiCompatThinkChunkContent,
  absorbOpenAiCompatThinkChunks,
  toOpenAiMessages,
  xaiProvider,
  XAI_OPTS,
  MISTRAL_OPTS
} from '@main/agent/providers/openai'
import { parseOpenAiResponsesUsage } from '@main/agent/providers/openaiResponses'
import type { ProviderChatRequest } from '@main/agent/providers/types'

describe('compatStreamOptions', () => {
  it('includes usage by default', () => {
    expect(compatStreamOptions({ defaultBaseUrl: 'https://api.openai.com/v1' })).toEqual({
      stream_options: { include_usage: true }
    })
  })

  it('requests include_usage for Mistral (rejected hosts auto-retry without it)', () => {
    expect(
      compatStreamOptions({ defaultBaseUrl: 'https://api.mistral.ai/v1' })
    ).toEqual({ stream_options: { include_usage: true } })
  })

  it('requests include_usage for Ollama so the final usage chunk is sent', () => {
    expect(
      compatStreamOptions({ defaultBaseUrl: 'http://127.0.0.1:11434/v1', ollamaVision: true })
    ).toEqual({ stream_options: { include_usage: true } })
    expect(
      compatStreamOptions({ defaultBaseUrl: 'https://ollama.com', ollamaVision: true })
    ).toEqual({ stream_options: { include_usage: true } })
  })
})

describe('buildOpenAiCompatBody prompt cache', () => {
  const baseReq: ProviderChatRequest = {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    signal: new AbortController().signal
  }

  it('omits max_tokens when maxOutputTokens is unset', () => {
    const body = buildOpenAiCompatBody(baseReq, { defaultBaseUrl: 'https://openrouter.ai/api/v1' })
    expect(body.max_tokens).toBeUndefined()
  })

  it('includes max_tokens only when explicitly set on the request', () => {
    const body = buildOpenAiCompatBody(
      { ...baseReq, maxOutputTokens: 4096 },
      { defaultBaseUrl: 'https://openrouter.ai/api/v1' }
    )
    expect(body.max_tokens).toBe(4096)
  })

  it('includes temperature and stop when set', () => {
    const body = buildOpenAiCompatBody(
      { ...baseReq, temperature: 0, stop: ['\n\n', '```'] },
      { defaultBaseUrl: 'https://openrouter.ai/api/v1' }
    )
    expect(body.temperature).toBe(0)
    expect(body.stop).toEqual(['\n\n', '```'])
  })

  it('includes prompt_cache_key when enabled for OpenAI', () => {
    const body = buildOpenAiCompatBody(
      { ...baseReq, promptCacheKey: 'run-abc' },
      { defaultBaseUrl: 'https://api.openai.com/v1', enablePromptCache: true }
    )
    expect(body.prompt_cache_key).toBe('run-abc')
  })

  it('omits prompt_cache_key for providers without enablePromptCache', () => {
    const body = buildOpenAiCompatBody(
      { ...baseReq, promptCacheKey: 'run-abc' },
      { defaultBaseUrl: 'https://api.groq.com/openai/v1' }
    )
    expect(body.prompt_cache_key).toBeUndefined()
  })

  it('omits prompt_cache_key for DeepSeek (automatic prefix cache only)', () => {
    const body = buildOpenAiCompatBody(
      { ...baseReq, promptCacheKey: 'run-abc' },
      { defaultBaseUrl: 'https://api.deepseek.com/v1' }
    )
    expect(body.prompt_cache_key).toBeUndefined()
  })

  it('MISTRAL_OPTS ships enablePromptCache (prompt_cache_key officially documented by Mistral)', () => {
    expect(MISTRAL_OPTS.enablePromptCache).toBe(true)
    const body = buildOpenAiCompatBody(
      { ...baseReq, promptCacheKey: 'run-abc' },
      MISTRAL_OPTS,
      'mistral'
    )
    expect(body.prompt_cache_key).toBe('run-abc')
  })

  it('XAI_OPTS ships convIdHeader and chat bodies stay header-affine (no body key for CC)', () => {
    expect(XAI_OPTS.convIdHeader).toBe(true)
    const body = buildOpenAiCompatBody(
      { ...baseReq, promptCacheKey: 'run-abc' },
      XAI_OPTS,
      'xai'
    )
    // xAI Chat Completions affinity is the x-grok-conv-id HEADER; prompt_cache_key is Responses-API only.
    expect(body.prompt_cache_key).toBeUndefined()
  })

  it('suppresses prompt_cache_key when the omitCacheKey override is set', () => {
    const body = buildOpenAiCompatBody(
      { ...baseReq, promptCacheKey: 'run-abc' },
      { defaultBaseUrl: 'https://api.openai.com/v1', enablePromptCache: true },
      'openai',
      { omitCacheKey: true }
    )
    expect(body.prompt_cache_key).toBeUndefined()
    expect(body.prompt_cache_options).toBeUndefined()
  })

  it('strips omitFields from the built body (strict-host unknown-field recovery)', () => {
    const body = buildOpenAiCompatBody(
      { ...baseReq, thinking: { enabled: true, effort: 'high', display: 'summarized' } },
      { defaultBaseUrl: 'http://127.0.0.1:8080/v1' },
      'custom',
      { omitFields: ['include_reasoning', 'service_tier'] }
    )
    expect(body.include_reasoning).toBeUndefined()
    expect(body.reasoning_effort).toBe('high')
  })

  it('sanitizes restricted schema keywords only when the sanitizeTools override is set', () => {
    const tools = [
      {
        name: 'lookup',
        description: 'lookup',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
          additionalProperties: false
        }
      }
    ]
    const raw = buildOpenAiCompatBody(
      { ...baseReq, tools },
      { defaultBaseUrl: 'https://opencode.ai/zen/go/v1' },
      'opencode'
    )
    const rawParams = (
      raw.tools as Array<{ function: { parameters: Record<string, unknown> } }>
    )[0]!.function.parameters
    expect(rawParams.additionalProperties).toBe(false)

    const sanitized = buildOpenAiCompatBody(
      { ...baseReq, tools },
      { defaultBaseUrl: 'https://opencode.ai/zen/go/v1' },
      'opencode',
      { sanitizeTools: true }
    )
    const params = (
      sanitized.tools as Array<{ function: { parameters: Record<string, unknown> } }>
    )[0]!.function.parameters
    expect(params.additionalProperties).toBeUndefined()
    expect(
      (params.properties as Record<string, Record<string, unknown>>).id!.format
    ).toBeUndefined()
    expect(params.required).toEqual(['id'])
  })
})

describe('xai conv-id cache affinity header', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends x-grok-conv-id from the run promptCacheKey on chat requests', async () => {
    const headersSeen: Array<Record<string, string>> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        headersSeen.push(init?.headers as Record<string, string>)
        return new Response(
          [
            'data: {"choices":[{"delta":{"content":"hi"}}],"usage":{"prompt_tokens":10,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":8}}}\n\n',
            'data: [DONE]\n\n'
          ].join(''),
          { status: 200, headers: { 'content-type': 'text/event-stream' } }
        )
      })
    )

    const chunks: unknown[] = []
    for await (const chunk of xaiProvider.streamChat({
      model: 'grok-4.6',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      signal: new AbortController().signal,
      apiKey: 'test-key',
      promptCacheKey: 'run-abc'
    })) {
      chunks.push(chunk)
    }

    expect(chunks.length).toBeGreaterThan(0)
    expect(headersSeen.length).toBeGreaterThan(0)
    for (const h of headersSeen) {
      expect(h['x-grok-conv-id']).toBe('run-abc')
    }
  })
})

describe('mergeOpenAiCompatToolArgDelta', () => {
  it('yields the first fragment as-is', async () => {
    const { mergeOpenAiCompatToolArgDelta } = await import('@main/agent/providers/openai')
    expect(mergeOpenAiCompatToolArgDelta('', '{"path":"')).toEqual({
      arguments: '{"path":"',
      yieldDelta: '{"path":"'
    })
  })

  it('yields only the suffix when the host re-sends growing full JSON', async () => {
    const { mergeOpenAiCompatToolArgDelta } = await import('@main/agent/providers/openai')
    const first = mergeOpenAiCompatToolArgDelta('', '{"path":"a.ts","diff":"')
    const second = mergeOpenAiCompatToolArgDelta(
      first.arguments,
      '{"path":"a.ts","diff":"@@\\n+line'
    )
    expect(second.yieldDelta).toBe('@@\\n+line')
    expect(second.arguments).toBe('{"path":"a.ts","diff":"@@\\n+line')
  })

  it('appends true fragment deltas', async () => {
    const { mergeOpenAiCompatToolArgDelta } = await import('@main/agent/providers/openai')
    const first = mergeOpenAiCompatToolArgDelta('', '{"path":"')
    const second = mergeOpenAiCompatToolArgDelta(first.arguments, 'a.ts"}')
    expect(second).toEqual({
      arguments: '{"path":"a.ts"}',
      yieldDelta: 'a.ts"}'
    })
  })

  it('replaces a wholly different complete payload and yields it so the UI can paint', async () => {
    const { mergeOpenAiCompatToolArgDelta } = await import('@main/agent/providers/openai')
    const next = mergeOpenAiCompatToolArgDelta('{"old":1}', '{"new":true,"x":2}')
    expect(next.arguments).toBe('{"new":true,"x":2}')
    expect(next.yieldDelta).toBe('{"new":true,"x":2}')
  })

  it('yields path-only then path+contents complete snapshots (live edit dump)', async () => {
    const { mergeOpenAiCompatToolArgDelta } = await import('@main/agent/providers/openai')
    const pathOnly = '{"path":"plan.md"}'
    const withContents = '{"path":"plan.md","contents":"# Plan\\nline two"}'
    const first = mergeOpenAiCompatToolArgDelta('', pathOnly)
    expect(first.yieldDelta).toBe(pathOnly)
    const second = mergeOpenAiCompatToolArgDelta(first.arguments, withContents)
    expect(second.arguments).toBe(withContents)
    expect(second.yieldDelta).toBe(withContents)
  })

  it('takes the last complete snapshot when IPC concatenated two objects', async () => {
    const { mergeOpenAiCompatToolArgDelta } = await import('@main/agent/providers/openai')
    const pathOnly = '{"path":"plan.md"}'
    const withContents = '{"path":"plan.md","contents":"hello"}'
    const merged = mergeOpenAiCompatToolArgDelta(pathOnly, pathOnly + withContents)
    expect(merged.arguments).toBe(withContents)
    expect(merged.yieldDelta).toBe(withContents)
  })

  it('appends mid-object fragments instead of replacing a valid prefix (live 24e7f3d6)', async () => {
    const { mergeOpenAiCompatToolArgDelta } = await import('@main/agent/providers/openai')
    // Prefix stops mid-string so a later fragment starting with `", "questions"` can complete it.
    const first = mergeOpenAiCompatToolArgDelta('', '{"title":"Plan')
    const second = mergeOpenAiCompatToolArgDelta(
      first.arguments,
      '", "questions": [{"id":"purpose","prompt":"What?","type":"single","options":["A"]}]}'
    )
    expect(second.arguments.startsWith('{"title":"Plan')).toBe(true)
    expect(second.arguments).toContain('"questions"')
    expect(JSON.parse(second.arguments)).toEqual({
      title: 'Plan',
      questions: [{ id: 'purpose', prompt: 'What?', type: 'single', options: ['A'] }]
    })
  })

  it('keeps the object prefix when a fragment opens the questions array (live 4406e6a2)', async () => {
    const { mergeOpenAiCompatToolArgDelta } = await import('@main/agent/providers/openai')
    // Live DeepSeek chunking: `{"questions": ` then a longer fragment starting
    // with `[`. Replacing on the `[` root dropped the prefix and produced `[…]}`.
    const chunks = [
      '{"questions": ',
      '[{"id": "topic", "prompt": "What topic should I research?", "type": "single", "options": ["AI coding agents", "Frontend"], "allowCustom": true}',
      ', {"id": "output", "prompt": "How would you like it delivered?", "type": "single", "options": ["Chat summary", "Markdown file"], "allowCustom": false}]',
      '}'
    ]
    let accumulated = ''
    for (const chunk of chunks) {
      accumulated = mergeOpenAiCompatToolArgDelta(accumulated, chunk).arguments
    }

    expect(accumulated.startsWith('[')).toBe(false)
    expect(accumulated).toBe(chunks.join(''))
    expect(JSON.parse(accumulated)).toEqual({
      questions: [
        {
          id: 'topic',
          prompt: 'What topic should I research?',
          type: 'single',
          options: ['AI coding agents', 'Frontend'],
          allowCustom: true
        },
        {
          id: 'output',
          prompt: 'How would you like it delivered?',
          type: 'single',
          options: ['Chat summary', 'Markdown file'],
          allowCustom: false
        }
      ]
    })
  })

  it('still replaces a re-sent payload that only differs by whitespace', async () => {
    const { mergeOpenAiCompatToolArgDelta } = await import('@main/agent/providers/openai')
    const merged = mergeOpenAiCompatToolArgDelta('{"path":"a.ts","start', '{"path": "a.ts", "startLine": 3}')
    expect(merged.arguments).toBe('{"path": "a.ts", "startLine": 3}')
    expect(merged.yieldDelta).toBe('{"path": "a.ts", "startLine": 3}')
  })

  it('appends a nested object fragment that follows an open array', async () => {
    const { mergeOpenAiCompatToolArgDelta } = await import('@main/agent/providers/openai')
    const first = mergeOpenAiCompatToolArgDelta('', '{"todos": [')
    const second = mergeOpenAiCompatToolArgDelta(
      first.arguments,
      '{"id": "1", "content": "Verify the fix", "status": "pending"}]}'
    )
    expect(JSON.parse(second.arguments)).toEqual({
      todos: [{ id: '1', content: 'Verify the fix', status: 'pending' }]
    })
  })
})

describe('parseOpenAiCompatUsage cache metrics', () => {
  it('reads DeepSeek prompt_cache_hit_tokens', () => {
    const usage = parseOpenAiCompatUsage({
      prompt_tokens: 1000,
      completion_tokens: 50,
      prompt_cache_hit_tokens: 900,
      prompt_cache_miss_tokens: 100
    })
    expect(usage?.cachedInputTokens).toBe(900)
    expect(usage?.inputTokens).toBe(1000)
  })

  it('reads Groq/OpenAI prompt_tokens_details.cached_tokens', () => {
    const usage = parseOpenAiCompatUsage({
      prompt_tokens: 500,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 400 }
    })
    expect(usage?.cachedInputTokens).toBe(400)
  })

  it('reads xAI top-level cached_prompt_text_tokens', () => {
    const usage = parseOpenAiCompatUsage({
      prompt_tokens: 800,
      completion_tokens: 30,
      cached_prompt_text_tokens: 700
    })
    expect(usage?.cachedInputTokens).toBe(700)
    expect(usage?.inputTokens).toBe(800)
  })

  it('returns undefined for empty usage payloads', () => {
    expect(parseOpenAiCompatUsage(null)).toBeUndefined()
    expect(parseOpenAiCompatUsage({})).toBeUndefined()
  })

  it('reads OpenRouter cost, cache_discount, and cache_write_tokens', () => {
    const usage = parseOpenAiCompatUsage({
      prompt_tokens: 2000,
      completion_tokens: 80,
      cost: 0.0123,
      cache_discount: 0.004,
      prompt_tokens_details: { cached_tokens: 1500, cache_write_tokens: 200 }
    })
    expect(usage?.billedCost).toBe(0.0123)
    expect(usage?.billedCostSaved).toBe(0.004)
    expect(usage?.cachedInputTokens).toBe(1500)
    expect(usage?.cacheCreationInputTokens).toBe(200)
  })

  it('parses cost-only usage payloads', () => {
    const usage = parseOpenAiCompatUsage({ cost: 0.01 })
    expect(usage?.billedCost).toBe(0.01)
    expect(usage?.inputTokens).toBeUndefined()
  })

  it('does not treat upstream_inference_cost as billed', () => {
    const usage = parseOpenAiCompatUsage({
      prompt_tokens: 10,
      completion_tokens: 2,
      cost_details: { upstream_inference_cost: 9.99 }
    })
    expect(usage?.billedCost).toBeUndefined()
  })

  it('reads Ollama cloud usage when total_tokens is zero', () => {
    const usage = parseOpenAiCompatUsage({
      prompt_tokens: 31,
      completion_tokens: 28,
      total_tokens: 0
    })
    expect(usage?.inputTokens).toBe(31)
    expect(usage?.outputTokens).toBe(28)
    expect(usage?.billedCost).toBeUndefined()
  })
})

describe('parseOpenAiResponsesUsage', () => {
  it('reads cache_write_tokens into cacheCreationInputTokens', () => {
    const usage = parseOpenAiResponsesUsage({
      input_tokens: 800,
      output_tokens: 40,
      total_tokens: 840,
      input_tokens_details: { cached_tokens: 600, cache_write_tokens: 50 }
    })
    expect(usage?.cacheCreationInputTokens).toBe(50)
    expect(usage?.cachedInputTokens).toBe(600)
    expect(usage?.billedCost).toBeUndefined()
  })
})

describe('openAiCompatMessageReasoningDelta', () => {
  it('emits the full message when no reasoning streamed yet', () => {
    expect(openAiCompatMessageReasoningDelta('Plan the audit.', '')).toBe('Plan the audit.')
  })

  it('emits only the new suffix when message extends streamed reasoning', () => {
    expect(openAiCompatMessageReasoningDelta('Plan the audit. Start with src.', 'Plan the audit.')).toBe(
      ' Start with src.'
    )
  })

  it('returns null when message does not extend accumulated reasoning', () => {
    expect(openAiCompatMessageReasoningDelta('Plan the audit.', 'Plan the audit.')).toBeNull()
  })
})

describe('parseOpenAiCompatDeltaContent ThinkChunk', () => {
  it('keeps plain string content as text', () => {
    expect(parseOpenAiCompatDeltaContent('Hello')).toEqual({
      text: 'Hello',
      reasoning: null,
      thinkChunks: null
    })
    expect(parseOpenAiCompatDeltaContent('')).toEqual({
      text: null,
      reasoning: null,
      thinkChunks: null
    })
  })

  it('extracts Mistral ThinkChunk reasoning and TextChunk answer', () => {
    expect(
      parseOpenAiCompatDeltaContent([
        {
          type: 'thinking',
          thinking: [{ type: 'text', text: '17*23 = ' }, { type: 'text', text: '391' }]
        },
        { type: 'text', text: 'The product is 391.' }
      ])
    ).toEqual({
      text: 'The product is 391.',
      reasoning: '17*23 = 391',
      thinkChunks: [
        {
          text: '17*23 = 391',
          thinking: [
            { type: 'text', text: '17*23 = ' },
            { type: 'text', text: '391' }
          ]
        }
      ]
    })
  })

  it('preserves signature and closed on ThinkChunks', () => {
    expect(
      parseOpenAiCompatDeltaContent([
        {
          type: 'thinking',
          thinking: [{ type: 'text', text: 'step A' }],
          signature: 'sig-a',
          closed: true
        },
        {
          type: 'thinking',
          thinking: [{ type: 'text', text: 'step B' }],
          signature: 'sig-b',
          closed: true
        },
        { type: 'text', text: 'done' }
      ])
    ).toEqual({
      text: 'done',
      reasoning: 'step Astep B',
      thinkChunks: [
        {
          text: 'step A',
          signature: 'sig-a',
          closed: true,
          thinking: [{ type: 'text', text: 'step A' }]
        },
        {
          text: 'step B',
          signature: 'sig-b',
          closed: true,
          thinking: [{ type: 'text', text: 'step B' }]
        }
      ]
    })
  })

  it('preserves ToolReference and Reference inner parts', () => {
    expect(
      parseOpenAiCompatDeltaContent([
        {
          type: 'thinking',
          thinking: [
            { type: 'text', text: 'See ' },
            {
              type: 'tool_reference',
              tool: 'web_search',
              title: 'Docs',
              url: 'https://example.com'
            },
            { type: 'reference', reference_ids: [1, 'a'] }
          ]
        }
      ])
    ).toEqual({
      text: null,
      reasoning: 'See ',
      thinkChunks: [
        {
          text: 'See ',
          thinking: [
            { type: 'text', text: 'See ' },
            {
              type: 'tool_reference',
              tool: 'web_search',
              title: 'Docs',
              url: 'https://example.com'
            },
            { type: 'reference', reference_ids: [1, 'a'] }
          ]
        }
      ]
    })
  })

  it('handles thinking-only and string thinking field', () => {
    expect(
      parseOpenAiCompatDeltaContent([{ type: 'thinking', thinking: 'step one' }])
    ).toEqual({ text: null, reasoning: 'step one', thinkChunks: [{ text: 'step one' }] })
  })

  it('omits include_usage when omitIncludeUsage override is set', () => {
    const body = buildOpenAiCompatBody(
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        signal: new AbortController().signal
      },
      { defaultBaseUrl: 'https://api.openai.com/v1' },
      'openai',
      { omitIncludeUsage: true }
    )
    expect(body.stream_options).toBeUndefined()
  })
})

describe('toOpenAiCompatThinkChunkContent', () => {
  it('builds closed ThinkChunk plus TextChunk for multi-turn replay', () => {
    expect(toOpenAiCompatThinkChunkContent('answer', 'reason')).toEqual([
      {
        type: 'thinking',
        thinking: [{ type: 'text', text: 'reason' }],
        closed: true
      },
      { type: 'text', text: 'answer' }
    ])
    expect(toOpenAiCompatThinkChunkContent(null, 'reason only')).toEqual([
      {
        type: 'thinking',
        thinking: [{ type: 'text', text: 'reason only' }],
        closed: true
      }
    ])
  })

  it('replays stored multi-chunk layout with signatures', () => {
    expect(
      toOpenAiCompatThinkChunkContent('final', 'step Astep B', [
        { text: 'step A', signature: 'sig-a', closed: true },
        { text: 'step B', signature: 'sig-b', closed: true }
      ])
    ).toEqual([
      {
        type: 'thinking',
        thinking: [{ type: 'text', text: 'step A' }],
        closed: true,
        signature: 'sig-a'
      },
      {
        type: 'thinking',
        thinking: [{ type: 'text', text: 'step B' }],
        closed: true,
        signature: 'sig-b'
      },
      { type: 'text', text: 'final' }
    ])
  })

  it('replays full inner thinking parts without flattening', () => {
    expect(
      toOpenAiCompatThinkChunkContent('answer', 'See docs', [
        {
          text: 'See docs',
          closed: true,
          thinking: [
            { type: 'text', text: 'See ' },
            {
              type: 'tool_reference',
              tool: 'web_search',
              title: 'Docs',
              url: 'https://example.com'
            },
            { type: 'text', text: 'docs' },
            { type: 'reference', reference_ids: [3] }
          ]
        }
      ])
    ).toEqual([
      {
        type: 'thinking',
        thinking: [
          { type: 'text', text: 'See ' },
          {
            type: 'tool_reference',
            tool: 'web_search',
            title: 'Docs',
            url: 'https://example.com'
          },
          { type: 'text', text: 'docs' },
          { type: 'reference', reference_ids: [3] }
        ],
        closed: true
      },
      { type: 'text', text: 'answer' }
    ])
  })
})

describe('absorbOpenAiCompatThinkChunks', () => {
  it('appends into an open chunk and starts a new one after closed', () => {
    const mid = absorbOpenAiCompatThinkChunks([], [{ text: 'a' }])
    expect(mid).toEqual([{ text: 'a' }])
    const continued = absorbOpenAiCompatThinkChunks(mid, [
      { text: 'b', signature: 's1', closed: true }
    ])
    expect(continued).toEqual([{ text: 'ab', signature: 's1', closed: true }])
    const next = absorbOpenAiCompatThinkChunks(continued, [
      { text: 'c', signature: 's2', closed: true }
    ])
    expect(next).toEqual([
      { text: 'ab', signature: 's1', closed: true },
      { text: 'c', signature: 's2', closed: true }
    ])
  })

  it('keeps two unclosed ThinkChunks in one delta as separate chunks', () => {
    expect(
      absorbOpenAiCompatThinkChunks(
        [],
        [
          { text: 'first', thinking: [{ type: 'text', text: 'first' }] },
          { text: 'second', thinking: [{ type: 'text', text: 'second' }] }
        ]
      )
    ).toEqual([
      { text: 'first', thinking: [{ type: 'text', text: 'first' }] },
      { text: 'second', thinking: [{ type: 'text', text: 'second' }] }
    ])
  })

  it('merges structured inners across frames into the open chunk', () => {
    const mid = absorbOpenAiCompatThinkChunks(
      [],
      [{ text: 'Hel', thinking: [{ type: 'text', text: 'Hel' }] }]
    )
    expect(
      absorbOpenAiCompatThinkChunks(mid, [
        { text: 'lo', thinking: [{ type: 'text', text: 'lo' }], closed: true }
      ])
    ).toEqual([
      {
        text: 'Hello',
        closed: true,
        thinking: [
          { type: 'text', text: 'Hel' },
          { type: 'text', text: 'lo' }
        ]
      }
    ])
  })
})

describe('toOpenAiMessages tool argument wire safety', () => {
  it('wraps bare todo_write arrays when replaying assistant history', () => {
    const msgs = toOpenAiMessages(
      [
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'todo-1',
              name: 'todo_write',
              arguments: '[{"id":"1","content":"Verify the fix","status":"completed"}]'
            }
          ]
        }
      ],
      undefined
    )
    const assistant = msgs.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls))
    expect(assistant).toBeTruthy()
    const toolCall = (
      assistant as { tool_calls: Array<{ function: { arguments: string } }> }
    ).tool_calls[0]
    expect(JSON.parse(toolCall!.function.arguments)).toEqual({
      todos: [{ id: '1', content: 'Verify the fix', status: 'completed' }]
    })
  })

  it('never emits unparseable function.arguments', () => {
    const msgs = toOpenAiMessages(
      [
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'c1', name: 'edit', arguments: '[' },
            { id: 'c2', name: 'ask_question', arguments: 'not-json' },
            {
              id: 'c3',
              name: 'ask_question',
              arguments: '[{"id":"x","prompt":"X?","type":"single","options":["a"]}'
            }
          ]
        },
        { role: 'tool', toolCallId: 'c1', toolName: 'edit', content: 'invalid' },
        { role: 'tool', toolCallId: 'c2', toolName: 'ask_question', content: 'invalid' },
        { role: 'tool', toolCallId: 'c3', toolName: 'ask_question', content: 'ok' }
      ],
      undefined
    )
    const assistant = msgs.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls))
    expect(assistant).toBeTruthy()
    const toolCalls = (
      assistant as { tool_calls: Array<{ function: { arguments: string; name: string } }> }
    ).tool_calls
    for (const tc of toolCalls) {
      const parsed = JSON.parse(tc.function.arguments)
      expect(parsed).not.toBeNull()
      expect(typeof parsed).toBe('object')
      expect(Array.isArray(parsed)).toBe(false)
    }
    expect(JSON.parse(toolCalls[0]!.function.arguments)).toEqual({})
    expect(JSON.parse(toolCalls[1]!.function.arguments)).toEqual({})
    expect(JSON.parse(toolCalls[2]!.function.arguments)).toEqual({})
  })
})
