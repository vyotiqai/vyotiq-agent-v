import { describe, expect, it } from 'vitest'
import { parseGeminiUsage } from '@main/agent/providers/gemini'

describe('parseGeminiUsage', () => {
  it('parses camelCase usage metadata', () => {
    expect(
      parseGeminiUsage({
        promptTokenCount: 1200,
        candidatesTokenCount: 80,
        totalTokenCount: 1280,
        cachedContentTokenCount: 400
      })
    ).toEqual({
      inputTokens: 1200,
      inputTokensIncludesCache: true,
      outputTokens: 80,
      totalTokens: 1280,
      cachedInputTokens: 400,
      reasoningTokens: undefined
    })
  })

  it('parses thinking tokens as reasoning tokens', () => {
    expect(
      parseGeminiUsage({
        promptTokenCount: 1200,
        candidatesTokenCount: 80,
        totalTokenCount: 1400,
        thoughtsTokenCount: 120
      }).reasoningTokens
    ).toBe(120)
    expect(
      parseGeminiUsage({
        prompt_token_count: 1200,
        thoughts_token_count: 64
      }).reasoningTokens
    ).toBe(64)
  })

  it('parses snake_case usage metadata', () => {
    expect(
      parseGeminiUsage({
        prompt_token_count: 900,
        candidates_token_count: 50,
        total_token_count: 950,
        cached_content_token_count: 300
      })
    ).toEqual({
      inputTokens: 900,
      inputTokensIncludesCache: true,
      outputTokens: 50,
      totalTokens: 950,
      cachedInputTokens: 300,
      reasoningTokens: undefined
    })
  })

  it('omits cachedInputTokens when no cache hit is reported', () => {
    expect(
      parseGeminiUsage({
        promptTokenCount: 100,
        candidatesTokenCount: 20,
        totalTokenCount: 120
      })
    ).toEqual({
      inputTokens: 100,
      inputTokensIncludesCache: true,
      outputTokens: 20,
      totalTokens: 120,
      cachedInputTokens: undefined,
      reasoningTokens: undefined
    })
  })
})
