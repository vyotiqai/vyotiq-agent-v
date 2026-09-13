import { describe, expect, it } from 'vitest'
import { requestMaxOutputTokens } from '@main/agent/providers/requestLimits'

describe('requestMaxOutputTokens', () => {
  it('omits max_tokens for OpenAI-compatible providers (catalog max is not a request default)', () => {
    expect(requestMaxOutputTokens('openrouter', { maxOutputTokens: 65_536 })).toBeUndefined()
    expect(requestMaxOutputTokens('openai', { maxOutputTokens: 32_768 })).toBeUndefined()
    expect(requestMaxOutputTokens('groq', { maxOutputTokens: 16_384 })).toBeUndefined()
  })

  it('passes catalog max for providers that use it in their native API', () => {
    expect(requestMaxOutputTokens('anthropic', { maxOutputTokens: 8192 })).toBe(8192)
    expect(requestMaxOutputTokens('gemini', { maxOutputTokens: 8192 })).toBe(8192)
  })
})
