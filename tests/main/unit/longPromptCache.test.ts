import { describe, expect, it } from 'vitest'
import { buildAnthropicBody } from '@main/agent/providers/anthropic'
import { estimateStepCost } from '@shared/pricing/modelPrices'
import type { ProviderChatRequest } from '@main/agent/providers/types'

function request(extra: Partial<ProviderChatRequest> = {}): ProviderChatRequest {
  return {
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } }],
    systemStable: 'stable rules',
    systemVolatile: '',
    signal: new AbortController().signal,
    ...extra
  } as ProviderChatRequest
}

describe('long prompt cache', () => {
  it('keeps the 5-minute marks by default', () => {
    const body = buildAnthropicBody(request())
    const tools = body.tools as Array<{ cache_control?: Record<string, unknown> }>
    expect(tools[0]?.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('marks only the stable prefix for an hour; history keeps the 5-minute mark', () => {
    const body = buildAnthropicBody(request({ promptCacheTtl: '1h' }))
    const tools = body.tools as Array<{ cache_control?: Record<string, unknown> }>
    const system = body.system as Array<{ cache_control?: Record<string, unknown> }>
    expect(tools[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(system[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    const messages = body.messages as Array<{ content: Array<{ cache_control?: Record<string, unknown> }> }>
    const marks = messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).map((c) => c.cache_control)
    expect(marks.filter(Boolean)).toEqual([{ type: 'ephemeral' }])
  })

  it('prices a 1-hour write at twice the input rate', () => {
    const price = { price: { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 } }
    const short = estimateStepCost(
      { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 1_000_000 },
      price as never
    )
    const long = estimateStepCost(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 1_000_000,
        cacheCreationLongInputTokens: 1_000_000
      },
      price as never
    )
    expect(short).toBeCloseTo(3.75)
    expect(long).toBeCloseTo(6)
  })
})
