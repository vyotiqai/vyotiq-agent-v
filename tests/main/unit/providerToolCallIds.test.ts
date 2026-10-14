import { afterEach, describe, expect, it, vi } from 'vitest'
import { customProvider } from '@main/agent/providers/openai'
import { geminiProvider } from '@main/agent/providers/gemini'
import type { ProviderChatRequest, StreamChunk } from '@main/agent/providers/types'

function sseBody(frames: string[]): Response {
  return new Response(frames.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  })
}

const baseReq = (partial: Partial<ProviderChatRequest> = {}): ProviderChatRequest => ({
  model: 'm',
  // Literal loopback IP: base-URL validation needs no DNS lookup.
  baseUrl: 'http://127.0.0.1:8080/v1',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
  signal: new AbortController().signal,
  apiKey: 'test-key',
  ...partial
})

async function toolCalls(gen: AsyncGenerator<StreamChunk>): Promise<Array<NonNullable<StreamChunk['toolCall']>>> {
  const out: Array<NonNullable<StreamChunk['toolCall']>> = []
  for await (const chunk of gen) if (chunk.type === 'tool_call' && chunk.toolCall) out.push(chunk.toolCall)
  return out
}

const twoCalls = [
  { id: 'call_a', type: 'function', function: { name: 'read', arguments: '{"path":"a.ts"}' } },
  { id: 'call_b', type: 'function', function: { name: 'grep', arguments: '{"pattern":"x"}' } }
]

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('openai-compat parallel calls without index', () => {
  it('keeps two calls from one message snapshot apart', async () => {
    const snap = { choices: [{ message: { tool_calls: twoCalls }, finish_reason: 'tool_calls' }] }
    vi.stubGlobal('fetch', vi.fn(async () => sseBody([`data: ${JSON.stringify(snap)}\n\n`, 'data: [DONE]\n\n'])))
    const calls = await toolCalls(customProvider.streamChat(baseReq()))
    expect(calls.map((c) => [c.id, c.name, c.arguments])).toEqual([
      ['call_a', 'read', '{"path":"a.ts"}'],
      ['call_b', 'grep', '{"pattern":"x"}']
    ])
  })

  it('keeps two calls from one delta apart', async () => {
    const frame = { choices: [{ delta: { tool_calls: twoCalls } }] }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseBody([
          `data: ${JSON.stringify(frame)}\n\n`,
          'data: {"choices":[{"finish_reason":"tool_calls","delta":{}}]}\n\n',
          'data: [DONE]\n\n'
        ])
      )
    )
    const calls = await toolCalls(customProvider.streamChat(baseReq()))
    expect(calls.map((c) => c.name)).toEqual(['read', 'grep'])
  })

  it('still folds an id-less snapshot row into the single live call', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseBody([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","type":"function","function":{"name":"edit","arguments":""}}]}}]}\n\n',
          'data: {"choices":[{"message":{"tool_calls":[{"type":"function","function":{"name":"edit","arguments":"{\\"path\\":\\"a.ts\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
          'data: [DONE]\n\n'
        ])
      )
    )
    const calls = await toolCalls(customProvider.streamChat(baseReq()))
    expect(calls).toEqual([{ id: 'call_x', name: 'edit', arguments: '{"path":"a.ts"}' }])
  })
})

describe('synthesized tool-call ids are unique per stream', () => {
  it('gemini ids do not repeat across steps', async () => {
    const frame =
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read","args":{"path":"a.ts"}}}]},"finishReason":"STOP"}]}\n\n'
    vi.stubGlobal('fetch', vi.fn(async () => sseBody([frame])))
    const first = await toolCalls(geminiProvider.streamChat(baseReq({ model: 'gemini-2.0-flash', baseUrl: undefined })))
    vi.stubGlobal('fetch', vi.fn(async () => sseBody([frame])))
    const second = await toolCalls(geminiProvider.streamChat(baseReq({ model: 'gemini-2.0-flash', baseUrl: undefined })))
    expect(first[0]!.id).toMatch(/^gemini_/)
    expect(first[0]!.id).not.toBe(second[0]!.id)
  })

  it('openai-compat ids for id-less hosts do not repeat across steps', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"a.ts\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"finish_reason":"tool_calls","delta":{}}]}\n\n',
      'data: [DONE]\n\n'
    ]
    vi.stubGlobal('fetch', vi.fn(async () => sseBody(frames)))
    const first = await toolCalls(customProvider.streamChat(baseReq()))
    vi.stubGlobal('fetch', vi.fn(async () => sseBody(frames)))
    const second = await toolCalls(customProvider.streamChat(baseReq()))
    expect(first[0]!.id).toMatch(/^call_/)
    expect(first[0]!.id).not.toBe(second[0]!.id)
  })
})
