import { describe, expect, it } from 'vitest'
import {
  estimateStepCost,
  resolveModelPrice
} from '@shared/pricing/modelPrices'

describe('resolveModelPrice', () => {
  it('matches exact and dated Anthropic ids via prefix', () => {
    const exact = resolveModelPrice('anthropic', 'claude-opus-4-5')
    const dated = resolveModelPrice('anthropic', 'claude-opus-4-5-20251101')
    expect(exact).not.toBeNull()
    expect(dated).not.toBeNull()
    expect(dated?.price).toEqual(exact?.price)
    expect(exact?.price.input).toBe(5)
    expect(exact?.price.cachedInput).toBe(0.5)
    expect(exact?.price.cacheWrite).toBe(6.25)
    expect(exact?.price.output).toBe(25)
  })

  it('prefers the longest matching prefix (sonnet-5 vs sonnet-4 families)', () => {
    expect(resolveModelPrice('anthropic', 'claude-sonnet-5')?.price.input).toBe(2)
    expect(
      resolveModelPrice('anthropic', 'claude-sonnet-4-6')?.price.input
    ).toBe(3)
    expect(resolveModelPrice('anthropic', 'claude-sonnet-4')?.price.input).toBe(3)
  })

  it('matches OpenAI cached-input rates', () => {
    const sol = resolveModelPrice('openai', 'gpt-5.6-sol')
    expect(sol?.price.input).toBe(1.25)
    expect(sol?.price.cachedInput).toBe(0.125)
    expect(sol?.price.output).toBe(10)
  })

  it('resolves OpenRouter vendor-prefixed ids to the underlying model price', () => {
    const claude = resolveModelPrice('openrouter', 'anthropic/claude-opus-4-5')
    expect(claude?.price.input).toBe(5)
    const gpt = resolveModelPrice('openrouter', 'openai/gpt-5.6-luna')
    expect(gpt?.price.input).toBe(0.5)
  })

  it('resolves Groq ids with and without the vendor prefix', () => {
    expect(resolveModelPrice('groq', 'openai/gpt-oss-120b')?.price.input).toBe(0.15)
    expect(resolveModelPrice('groq', 'gpt-oss-120b')?.price.output).toBe(0.6)
  })

  it('returns null for unknown providers/models — never a guessed price', () => {
    expect(resolveModelPrice('custom', 'my-private-model')).toBeNull()
    expect(resolveModelPrice('anthropic', 'claude-futura-9')).toBeNull()
    expect(resolveModelPrice('openai', 'gpt-9-x')).toBeNull()
    expect(resolveModelPrice('xai', 'grok-legacy')).toBeNull()
    expect(resolveModelPrice('groq', 'llama-3.3-70b-versatile')).toBeNull()
    expect(resolveModelPrice('openrouter', 'unknown-vendor/unknown-model')).toBeNull()
  })

  it('prices Ollama (local) as free rather than unknown', () => {
    const local = resolveModelPrice('ollama', 'qwen3:14b')
    expect(local?.price.input).toBe(0)
    expect(local?.price.output).toBe(0)
  })
})

describe('estimateStepCost', () => {
  it('computes Anthropic cost with cache read + write rates', () => {
    const resolved = resolveModelPrice('anthropic', 'claude-opus-4-5')
    expect(resolved).not.toBeNull()
    // 1M uncached input + 1M cache read + 1M cache write + 1M output
    // = 5 + 0.5 + 6.25 + 25 = 36.75 USD
    const cost = estimateStepCost(
      {
        inputTokens: 1_000_000,
        inputTokensIncludesCache: false,
        cachedInputTokens: 1_000_000,
        cacheCreationInputTokens: 1_000_000,
        outputTokens: 1_000_000
      },
      resolved!
    )
    expect(cost).toBeCloseTo(36.75, 10)
  })

  it('subtracts cached tokens when input includes them (OpenAI)', () => {
    const resolved = resolveModelPrice('openai', 'gpt-5.6-sol')
    expect(resolved).not.toBeNull()
    // 1M input incl. 800k cached, 500k output:
    // 200k*1.25 + 800k*0.125 + 500k*10 (per 1M) = 0.25 + 0.10 + 5 = 5.35 USD
    const cost = estimateStepCost(
      {
        inputTokens: 1_000_000,
        inputTokensIncludesCache: true,
        cachedInputTokens: 800_000,
        outputTokens: 500_000
      },
      resolved!
    )
    expect(cost).toBeCloseTo(5.35, 10)
  })

  it('bills Gemini thoughts at the verified thoughts rate', () => {
    const resolved = resolveModelPrice('gemini', 'gemini-3.8-flash')
    expect(resolved).not.toBeNull()
    // 200k input + 100k output + 50k thoughts:
    // 0.15 + 0.375 + 0.009 = 0.534 USD
    const cost = estimateStepCost(
      {
        inputTokens: 200_000,
        inputTokensIncludesCache: true,
        outputTokens: 100_000,
        reasoningTokens: 50_000
      },
      resolved!
    )
    expect(cost).toBeCloseTo(0.534, 10)
  })

  it('applies Gemini long-context tier above 200k input', () => {
    const resolved = resolveModelPrice('gemini', 'gemini-2.5-pro')
    expect(resolved).not.toBeNull()
    // 250k input (>200k) + 100k output: 0.625 + 1.5 = 2.125 USD
    const cost = estimateStepCost(
      { inputTokens: 250_000, inputTokensIncludesCache: true, outputTokens: 100_000 },
      resolved!
    )
    expect(cost).toBeCloseTo(2.125, 10)
    // At or below threshold uses standard rates: 200k*1.25/1M + 100k*10/1M = 1.25
    const stdCost = estimateStepCost(
      { inputTokens: 200_000, inputTokensIncludesCache: true, outputTokens: 100_000 },
      resolved!
    )
    expect(stdCost).toBeCloseTo(1.25, 10)
  })

  it('computes DeepSeek cost with discounted cache-hit rate', () => {
    const resolved = resolveModelPrice('deepseek', 'deepseek-flash')
    expect(resolved).not.toBeNull()
    // 1M input incl. 500k cached + 200k output (peak rates):
    // 500k*0.30 + 500k*0.006 + 200k*1.20 (per 1M) = 0.15 + 0.003 + 0.24 = 0.393
    const cost = estimateStepCost(
      {
        inputTokens: 1_000_000,
        inputTokensIncludesCache: true,
        cachedInputTokens: 500_000,
        outputTokens: 200_000
      },
      resolved!
    )
    expect(cost).toBeCloseTo(0.393, 10)
  })

  it('does not double-bill reasoning already included in output (OpenAI)', () => {
    const resolved = resolveModelPrice('openai', 'gpt-5.6-luna')
    expect(resolved).not.toBeNull()
    const withReasoning = estimateStepCost(
      {
        inputTokens: 100_000,
        inputTokensIncludesCache: true,
        outputTokens: 10_000,
        reasoningTokens: 4_000
      },
      resolved!
    )
    const withoutReasoning = estimateStepCost(
      { inputTokens: 100_000, inputTokensIncludesCache: true, outputTokens: 10_000 },
      resolved!
    )
    expect(withReasoning).toBe(withoutReasoning)
  })

  it('returns null when token counts are missing', () => {
    const resolved = resolveModelPrice('openai', 'gpt-5.6-sol')
    expect(estimateStepCost({ outputTokens: 100 }, resolved!)).toBeNull()
    expect(estimateStepCost({ inputTokens: 100 }, resolved!)).toBeNull()
    expect(estimateStepCost({}, resolved!)).toBeNull()
  })

  it('estimates zero cost for Ollama local models', () => {
    const resolved = resolveModelPrice('ollama', 'llama3.2:latest')
    expect(estimateStepCost(
      { inputTokens: 50_000, inputTokensIncludesCache: true, outputTokens: 5_000 },
      resolved!
    )).toBe(0)
  })
})
