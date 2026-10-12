import { describe, expect, it } from 'vitest'
import {
  BOOSTED_MAX_OUTPUT_TOKENS,
  MODERATE_MAX_OUTPUT_TOKENS,
  requestMaxOutputTokens
} from '@main/agent/providers/requestLimits'
import { shouldRetryOmitMaxTokens } from '@main/agent/providers/httpErrors'

describe('requestMaxOutputTokens', () => {
  it('never sends the catalog max to OpenAI-compatible hosts', () => {
    expect(requestMaxOutputTokens('openrouter', { maxOutputTokens: 65_536 })).toBe(MODERATE_MAX_OUTPUT_TOKENS)
    expect(requestMaxOutputTokens('openai', { maxOutputTokens: 32_768 })).toBeUndefined()
  })

  it('sends a moderate limit to hosted compat APIs, capped by the catalog', () => {
    expect(requestMaxOutputTokens('deepseek', { maxOutputTokens: 8192 })).toBe(8192)
    expect(requestMaxOutputTokens('groq', {})).toBe(MODERATE_MAX_OUTPUT_TOKENS)
  })

  it('raises the limit after a cut-off reply', () => {
    expect(requestMaxOutputTokens('openrouter', { maxOutputTokens: 65_536 }, { boost: true })).toBe(
      BOOSTED_MAX_OUTPUT_TOKENS
    )
    expect(requestMaxOutputTokens('deepseek', { maxOutputTokens: 8192 }, { boost: true })).toBe(8192)
  })

  it('leaves local servers on their own default unless the user set a limit', () => {
    expect(requestMaxOutputTokens('ollama', { maxOutputTokens: 8192 })).toBeUndefined()
    expect(requestMaxOutputTokens('custom', {})).toBeUndefined()
    expect(requestMaxOutputTokens('custom', { maxOutputTokens: 4096, limitsSource: 'user' })).toBe(4096)
  })

  it('passes catalog max for providers that use it in their native API', () => {
    expect(requestMaxOutputTokens('anthropic', { maxOutputTokens: 8192 })).toBe(8192)
    expect(requestMaxOutputTokens('gemini', { maxOutputTokens: 8192 })).toBe(8192)
  })
})

describe('shouldRetryOmitMaxTokens', () => {
  it('matches a host rejecting the value', () => {
    expect(
      shouldRetryOmitMaxTokens(400, JSON.stringify({ error: { message: 'Invalid max_tokens value, the valid range of max_tokens is [1, 8192]' } }))
    ).toBe(true)
    expect(shouldRetryOmitMaxTokens(402, '')).toBe(true)
  })

  it('ignores unrelated errors', () => {
    expect(shouldRetryOmitMaxTokens(400, JSON.stringify({ error: { message: 'model not found' } }))).toBe(false)
    expect(shouldRetryOmitMaxTokens(500, 'max_tokens')).toBe(false)
  })
})
