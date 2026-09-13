import { describe, expect, it } from 'vitest'
import { collectStructuredResponse } from '@main/agent/schemas/structured'
import type { LlmProvider, ProviderChatRequest, StreamChunk } from '@main/agent/providers/types'

function fakeProvider(chunks: StreamChunk[]): LlmProvider {
  return {
    id: 'fake',
    streamChat: async function* () {
      for (const chunk of chunks) yield chunk
    }
  } as unknown as LlmProvider
}

type StructuredRequest = ProviderChatRequest & {
  responseFormat: NonNullable<ProviderChatRequest['responseFormat']>
}

function request(): StructuredRequest {
  return {
    signal: new AbortController().signal,
    responseFormat: { type: 'json_schema', name: 'test', schema: {} }
  } as StructuredRequest
}

describe('collectStructuredResponse', () => {
  it('collects text chunks and returns a parsed payload', async () => {
    const provider = fakeProvider([{ type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }])
    const result = await collectStructuredResponse(provider, request(), (raw) => ({
      ok: true,
      data: JSON.parse(raw) as { a: number }
    }))
    expect(result).toEqual({ ok: true, data: { a: 1 }, rawText: '{"a":1}' })
  })

  it('trims surrounding whitespace before parsing', async () => {
    const provider = fakeProvider([{ type: 'text', text: '  {"ok":true}\n\n' }])
    const result = await collectStructuredResponse(provider, request(), (raw) => ({
      ok: true,
      data: JSON.parse(raw) as { ok: boolean }
    }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.rawText).toBe('{"ok":true}')
  })

  it('surfaces a parse failure with the raw text', async () => {
    const provider = fakeProvider([{ type: 'text', text: 'not json' }])
    const result = await collectStructuredResponse<{ a: number }>(provider, request(), () => ({
      ok: false,
      error: 'bad payload'
    }))
    expect(result).toEqual({ ok: false, rawText: 'not json', error: 'bad payload' })
  })

  it('surfaces a non-retriable provider error chunk', async () => {
    const provider = fakeProvider([{ type: 'error', error: 'invalid api key' }])
    const result = await collectStructuredResponse<{ a: number }>(provider, request(), () => ({
      ok: true,
      data: { a: 1 }
    }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('invalid api key')
  })

  it('returns an abort error when the signal fires mid-stream', async () => {
    const controller = new AbortController()
    const provider = fakeProvider([{ type: 'text', text: 'partial' }])
    const req: StructuredRequest = { ...request(), signal: controller.signal }
    const pending = collectStructuredResponse<{ a: number }>(provider, req, () => ({
      ok: true,
      data: { a: 1 }
    }))
    controller.abort()
    const result = await pending
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('Request aborted')
  })
})
