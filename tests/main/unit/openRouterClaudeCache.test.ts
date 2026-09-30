import { describe, expect, it } from 'vitest'
import { buildOpenAiCompatBody, usesAnthropicCacheControlViaOpenRouter } from '@main/agent/providers/openai'
import { volatileSessionMessage } from '@main/agent/providers/systemZones'
import type { ProviderChatRequest } from '@main/agent/providers/types'

const OPENROUTER = { defaultBaseUrl: 'https://openrouter.ai/api/v1', requireToolsParam: true, openRouterReasoning: true, enablePromptCache: true }

function req(model: string, extra: Partial<ProviderChatRequest> = {}): ProviderChatRequest {
  return {
    model,
    messages: [
      { role: 'user', content: 'read a.ts' },
      { role: 'assistant', content: 'Reading.', toolCalls: [{ id: 't1', name: 'read', arguments: '{"path":"a.ts"}' }] },
      { role: 'tool', toolCallId: 't1', toolName: 'read', content: 'export const a = 1' }
    ],
    tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } }],
    systemStable: 'STABLE PREFIX',
    systemVolatile: 'CLOCK',
    promptCacheKey: 'run-1',
    signal: new AbortController().signal,
    ...extra
  }
}

/**
 * Anthropic caches only at explicit `cache_control` breakpoints. Through
 * OpenRouter they ride on message content parts; without them every Claude
 * step was billed as fresh input.
 */
describe('Claude through OpenRouter', () => {
  it('marks the stable system and the last cacheable history turn, leaving the volatile turn outside', () => {
    const body = buildOpenAiCompatBody(req('anthropic/claude-sonnet-5.5'), OPENROUTER, 'openrouter')
    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages[0]).toEqual({
      role: 'system',
      content: [{ type: 'text', text: 'STABLE PREFIX', cache_control: { type: 'ephemeral' } }]
    })
    // The tool row stays a plain string; the breakpoint lands on the turn before it.
    const tool = messages.find((m) => m.role === 'tool')!
    expect(typeof tool.content).toBe('string')
    const assistant = messages.find((m) => m.role === 'assistant')!
    expect(assistant.content).toEqual([{ type: 'text', text: 'Reading.', cache_control: { type: 'ephemeral' } }])
    expect(messages.at(-1)).toEqual(volatileSessionMessage('CLOCK'))
    // Exactly two breakpoints — Anthropic allows four.
    expect(JSON.stringify(body).match(/cache_control/g)).toHaveLength(2)
    // No OpenAI explicit-mode fields mixed in.
    expect(JSON.stringify(body)).not.toContain('prompt_cache_breakpoint')
  })

  it('applies to a custom endpoint pointed at openrouter.ai, and to nothing else', () => {
    expect(usesAnthropicCacheControlViaOpenRouter('custom', 'anthropic/claude-opus-5.5', 'https://openrouter.ai/api/v1')).toBe(true)
    expect(usesAnthropicCacheControlViaOpenRouter('openrouter', 'claude-haiku-4.5', undefined)).toBe(true)
    expect(usesAnthropicCacheControlViaOpenRouter('openrouter', 'openai/gpt-5.5', undefined)).toBe(false)
    expect(usesAnthropicCacheControlViaOpenRouter('custom', 'anthropic/claude-opus-5.5', 'http://127.0.0.1:8080/v1')).toBe(false)
    expect(usesAnthropicCacheControlViaOpenRouter('custom', 'claude', 'not a url')).toBe(false)

    const gpt = buildOpenAiCompatBody(req('openai/gpt-5.5'), OPENROUTER, 'openrouter')
    expect(JSON.stringify(gpt)).not.toContain('cache_control')
    expect((gpt.messages as Array<Record<string, unknown>>)[0]).toEqual({ role: 'system', content: 'STABLE PREFIX' })
  })

  it('keeps the cached prefix byte-identical from one step to the next', () => {
    const one = buildOpenAiCompatBody(req('anthropic/claude-sonnet-5.5', { systemVolatile: 'CLOCK 1' }), OPENROUTER, 'openrouter')
    const two = buildOpenAiCompatBody(req('anthropic/claude-sonnet-5.5', { systemVolatile: 'CLOCK 2' }), OPENROUTER, 'openrouter')
    const prefix = (b: Record<string, unknown>) => JSON.stringify([b.tools, (b.messages as unknown[]).slice(0, -1)])
    expect(prefix(one)).toBe(prefix(two))
  })
})
