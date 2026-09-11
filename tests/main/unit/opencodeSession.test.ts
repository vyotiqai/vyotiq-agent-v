import { afterEach, describe, expect, it, vi } from 'vitest'
import { opencodeProvider } from '@main/agent/providers/opencode'
import { createOpenAiCompatibleProvider } from '@main/agent/providers/openai'
import { streamOpenAiResponses } from '@main/agent/providers/openaiResponses'
import { streamAnthropicMessages } from '@main/agent/providers/anthropic'
import type { ProviderChatRequest, StreamChunk } from '@main/agent/providers/types'

// OpenCode Go refuses to route requests without a stable per-conversation
// session id ("Request is missing x-opencode-session and cannot be routed
// efficiently"). These pins hold every transport to the gateway's contract:
// header present with the run's promptCacheKey, stable fallback without one,
// and zero leakage to non-opencode providers.

const OPENCODE_SESSION = 'x-opencode-session'

function sse(frames: string[]): Response {
  return new Response(frames.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  })
}

const CHAT_FRAMES = [
  'data: {"choices":[{"delta":{"content":"Hello!"}}]}\n\n',
  'data: [DONE]\n\n'
]

const MESSAGES_FRAMES = [
  'event: content_block_start\n',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
  'event: content_block_delta\n',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello!"}}\n\n',
  'event: message_delta\n',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":10,"output_tokens":5}}\n\n',
  'event: message_stop\n',
  'data: {"type":"message_stop"}\n\n'
]

const RESPONSES_FRAMES = [
  'data: {"type":"response.output_text.delta","delta":"Hi there."}\n\n',
  'data: {"type":"response.completed"}\n\n'
]

/** Stub global fetch, capturing request headers; returns transport-matched SSE. */
function captureFetchHeaders(): Array<{ url: string; headers: Record<string, string> }> {
  const seen: Array<{ url: string; headers: Record<string, string> }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
      if (url.includes('/responses')) return sse(RESPONSES_FRAMES)
      if (url.includes('/messages')) return sse(MESSAGES_FRAMES)
      return sse(CHAT_FRAMES)
    })
  )
  return seen
}

function reqFor(model: string, promptCacheKey?: string): ProviderChatRequest {
  return {
    model,
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    signal: new AbortController().signal,
    apiKey: 'test-key',
    ...(promptCacheKey ? { promptCacheKey } : {})
  }
}

async function collect(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of gen) out.push(chunk)
  return out
}

describe('x-opencode-session: present on every opencode transport', () => {
  afterEach(() => vi.unstubAllGlobals())

  // deepseek-v4-pro / gpt-5.6-luna / qwen3.8-max pin the registry transport
  // table (chat / responses / messages) without hardcoding the whole catalog.
  const cases: Array<{ model: string; urlPart: string }> = [
    { model: 'deepseek-v4-pro', urlPart: '/chat/completions' },
    { model: 'gpt-5.6-luna', urlPart: '/responses' },
    { model: 'qwen3.8-max', urlPart: '/messages' }
  ]

  it.each(cases)('$model ($urlPart) sends the promptCacheKey as the session id', async (c) => {
    const seen = captureFetchHeaders()
    const chunks = await collect(opencodeProvider.streamChat(reqFor(c.model, 'run-abc')))
    expect(chunks.some((ch) => ch.type === 'error')).toBe(false)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[0].url).toContain(c.urlPart)
    expect(seen[0].headers[OPENCODE_SESSION]).toBe('run-abc')
    // Session header is OpenCode-specific — the xAI conv-id header must not appear.
    expect(seen[0].headers['x-grok-conv-id']).toBeUndefined()
  })

  it('falls back to a per-process id that is stable across calls without a promptCacheKey', async () => {
    const seen = captureFetchHeaders()
    await collect(opencodeProvider.streamChat(reqFor('deepseek-v4-pro')))
    await collect(opencodeProvider.streamChat(reqFor('gpt-5.6-luna')))
    await collect(opencodeProvider.streamChat(reqFor('qwen3.8-max')))
    expect(seen.length).toBe(3)
    const sessions = seen.map((s) => s.headers[OPENCODE_SESSION])
    for (const s of sessions) {
      expect(typeof s).toBe('string')
      expect(s!.length).toBeGreaterThan(0)
    }
    expect(new Set(sessions).size).toBe(1)
  })
})

describe('x-opencode-session: absent from non-opencode providers', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('plain openai-compatible chat provider sends no session header', async () => {
    const seen = captureFetchHeaders()
    const plain = createOpenAiCompatibleProvider('openai', {
      defaultBaseUrl: 'https://api.openai.com/v1'
    })
    const chunks = await collect(plain.streamChat(reqFor('gpt-5.6', 'run-abc')))
    expect(chunks.some((ch) => ch.type === 'error')).toBe(false)
    expect(seen[0].url).toBe('https://api.openai.com/v1/chat/completions')
    expect(OPENCODE_SESSION in seen[0].headers).toBe(false)
  })

  it('stock OpenAI responses transport sends no session header', async () => {
    const seen = captureFetchHeaders()
    await collect(streamOpenAiResponses(reqFor('gpt-5.6-luna', 'run-abc')))
    expect(seen[0].url).toBe('https://api.openai.com/v1/responses')
    expect(OPENCODE_SESSION in seen[0].headers).toBe(false)
  })

  it('stock anthropic messages transport sends no session header', async () => {
    const seen = captureFetchHeaders()
    await collect(streamAnthropicMessages(reqFor('claude-sonnet-4-6', 'run-abc')))
    expect(seen[0].url).toBe('https://api.anthropic.com/v1/messages')
    expect(OPENCODE_SESSION in seen[0].headers).toBe(false)
  })
})
