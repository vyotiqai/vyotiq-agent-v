import { afterEach, describe, expect, it, vi } from 'vitest'
import { anthropicProvider, streamAnthropicMessages } from '@main/agent/providers/anthropic'
import { geminiProvider } from '@main/agent/providers/gemini'
import { streamOpenAiResponses } from '@main/agent/providers/openaiResponses'
import { providerFetchFailureChunk } from '@main/agent/providers/log'
import { shouldRetryStreamErrorChunk } from '@main/agent/streamRetry'
import type { ProviderChatRequest, StreamChunk } from '@main/agent/providers/types'

function sseBody(frames: string[]): Response {
  return new Response(frames.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  })
}

const baseReq = (partial: Partial<ProviderChatRequest> = {}): ProviderChatRequest => ({
  model: 'claude-sonnet-5',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
  signal: new AbortController().signal,
  apiKey: 'test-key',
  ...partial
})

async function collect(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of gen) out.push(chunk)
  return out
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('in-band stream errors carry an HTTP status', () => {
  const anthropicError = (type: string, message: string): Response =>
    sseBody([`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type, message } })}\n\n`])

  it('maps Anthropic error types to statuses so overloads retry and bad requests do not', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => anthropicError('overloaded_error', 'Overloaded')))
    const overloaded = (await collect(anthropicProvider.streamChat(baseReq()))).find(
      (c) => c.type === 'error'
    )!
    expect(overloaded).toMatchObject({ errorCode: 'PROVIDER_HTTP', httpStatus: 529 })
    expect(
      shouldRetryStreamErrorChunk(overloaded.errorCode!, overloaded.error!, 1, overloaded.httpStatus)
    ).toBe(true)

    vi.stubGlobal('fetch', vi.fn(async () => anthropicError('invalid_request_error', 'prompt is too long')))
    const invalid = (await collect(anthropicProvider.streamChat(baseReq()))).find(
      (c) => c.type === 'error'
    )!
    expect(invalid).toMatchObject({ errorCode: 'PROVIDER_HTTP', httpStatus: 400 })
    expect(shouldRetryStreamErrorChunk(invalid.errorCode!, invalid.error!, 1, invalid.httpStatus)).toBe(
      false
    )

    vi.stubGlobal('fetch', vi.fn(async () => anthropicError('some_new_error', 'Something')))
    const unknown = (await collect(anthropicProvider.streamChat(baseReq()))).find(
      (c) => c.type === 'error'
    )!
    expect(unknown.errorCode).toBe('PROVIDER_HTTP')
    expect(unknown.httpStatus).toBeUndefined()
  })

  it('uses the Gemini in-band error code as the status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseBody(['data: {"error":{"code":503,"message":"The model is overloaded.","status":"UNAVAILABLE"}}\n\n'])
      )
    )
    const err = (await collect(geminiProvider.streamChat(baseReq({ model: 'gemini-2.0-flash' })))).find(
      (c) => c.type === 'error'
    )!
    expect(err).toMatchObject({ errorCode: 'PROVIDER_HTTP', httpStatus: 503 })
    expect(shouldRetryStreamErrorChunk(err.errorCode!, err.error!, 1, err.httpStatus)).toBe(true)
  })
})

describe('anthropic body-fallback ladder', () => {
  it('returns a transient 529 as-is instead of retrying on a body without output_config', async () => {
    const bodies: Array<Record<string, unknown>> = []
    let n = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)))
        n += 1
        if (n <= 5) {
          return new Response('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', {
            status: 529,
            headers: { 'retry-after': '0' }
          })
        }
        return sseBody(['data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'])
      })
    )
    const chunks = await collect(
      anthropicProvider.streamChat(baseReq({ thinking: { enabled: true, effort: 'low', display: 'summarized' } }))
    )
    expect(chunks.find((c) => c.type === 'error')).toMatchObject({ errorCode: 'PROVIDER_HTTP', httpStatus: 529 })
    expect(bodies).toHaveLength(5)
    expect(bodies.every((b) => (b.output_config as { effort?: string })?.effort === 'low')).toBe(true)
  })

  it('still steps down the ladder on a 400', async () => {
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)))
        if (bodies.length === 1) return new Response('{"error":{"message":"unknown field"}}', { status: 400 })
        return sseBody(['data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'])
      })
    )
    const chunks = await collect(
      anthropicProvider.streamChat(baseReq({ thinking: { enabled: true, effort: 'low', display: 'summarized' } }))
    )
    expect(chunks.some((c) => c.type === 'error')).toBe(false)
    expect(bodies[1]!.output_config).toBeUndefined()
  })
})

describe('permanent request-construction failures are not network waits', () => {
  it('tags an invalid header value PROVIDER_REQUEST without echoing the key', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Headers.append: "Bearer sk-secret\nvalue" is an invalid header value.')
    })
    vi.stubGlobal('fetch', fetchMock)
    const err = (await collect(anthropicProvider.streamChat(baseReq()))).find((c) => c.type === 'error')!
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(err.errorCode).toBe('PROVIDER_REQUEST')
    expect(err.error).not.toContain('sk-secret')
    expect(shouldRetryStreamErrorChunk(err.errorCode!, err.error!, 1)).toBe(false)
  })

  it('tags ByteString, bad URL and refused redirects PROVIDER_REQUEST', () => {
    const byteString = new TypeError(
      'Cannot convert argument to a ByteString because the character at index 12 has a value of 8203 which is greater than 255.'
    )
    const badUrl = new TypeError('Failed to parse URL from not a url', {
      cause: Object.assign(new TypeError('Invalid URL'), { code: 'ERR_INVALID_URL' })
    })
    const redirect = new Error('Refusing cross-origin redirect from https://a.example to https://b.example')
    for (const err of [byteString, badUrl, redirect]) {
      expect(providerFetchFailureChunk('custom', err).errorCode).toBe('PROVIDER_REQUEST')
    }
  })

  it('keeps anything that could be a network failure on PROVIDER_NETWORK', () => {
    const reset = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    })
    const unknown = new Error('something odd happened')
    expect(providerFetchFailureChunk('custom', reset).errorCode).toBe('PROVIDER_NETWORK')
    expect(providerFetchFailureChunk('custom', unknown).errorCode).toBe('PROVIDER_NETWORK')
  })
})

describe('streams that close before the response completes', () => {
  it('anthropic: a cut stream is a retriable error, not a done with half a tool call', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseBody([
          'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}\n\n',
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"read","input":{}}}\n\n',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.ts\\",\\"limit\\":2"}}\n\n'
        ])
      )
    )
    const chunks = await collect(anthropicProvider.streamChat(baseReq()))
    expect(chunks.some((c) => c.type === 'tool_call' || c.type === 'done')).toBe(false)
    const err = chunks.find((c) => c.type === 'error')!
    expect(err.errorCode).toBe('PROVIDER_NETWORK')
    expect(shouldRetryStreamErrorChunk(err.errorCode!, err.error!, 1)).toBe(true)
  })

  it('anthropic: message_stop alone is enough to finish', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseBody([
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
          'data: {"type":"message_stop"}\n\n'
        ])
      )
    )
    const chunks = await collect(anthropicProvider.streamChat(baseReq()))
    expect(chunks.some((c) => c.type === 'error')).toBe(false)
    expect(chunks.some((c) => c.type === 'done')).toBe(true)
  })

  it('responses: a cut stream is a retriable error instead of flushing a partial call', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseBody([
          'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"read"}}\n\n',
          'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"path\\":"}\n\n'
        ])
      )
    )
    const chunks = await collect(streamOpenAiResponses(baseReq({ model: 'gpt-5' })))
    expect(chunks.some((c) => c.type === 'tool_call' || c.type === 'done')).toBe(false)
    expect(chunks.find((c) => c.type === 'error')?.errorCode).toBe('PROVIDER_NETWORK')
  })

  // No compatible host has been seen streaming these routes; one that never
  // sends the terminal event must not have every reply turned into an error.
  it('compatible hosts still finish a stream without the terminal event', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseBody(['data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n'])
      )
    )
    const messages = await collect(
      streamAnthropicMessages(baseReq({ model: 'qwen3.8-max' }), 'https://opencode.ai/zen/go/v1/messages')
    )
    expect(messages.some((c) => c.type === 'error')).toBe(false)
    expect(messages.some((c) => c.type === 'done')).toBe(true)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseBody(['data: {"type":"response.output_text.delta","delta":"hi"}\n\n']))
    )
    const responses = await collect(
      streamOpenAiResponses(baseReq({ model: 'grok-4.6' }), 'https://opencode.ai/zen/go/v1/responses')
    )
    expect(responses.some((c) => c.type === 'error')).toBe(false)
    expect(responses.some((c) => c.type === 'done')).toBe(true)
  })
})
