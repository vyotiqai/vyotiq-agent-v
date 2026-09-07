import { describe, expect, it } from 'vitest'
import {
  knownContextWindow,
  resolveModelContextWindow,
  withResolvedContextWindow
} from '@shared/domain/modelContextWindows'
import { seedModelsFor } from '@shared/providers'
import { contentWindow, contextWindowFor } from '@main/agent/context/budget'

describe('knownContextWindow', () => {
  it('returns 1M for DeepSeek V4 models and legacy aliases', () => {
    expect(knownContextWindow('deepseek-v4-flash', 'deepseek')).toBe(1_000_000)
    expect(knownContextWindow('deepseek-v4-pro', 'deepseek')).toBe(1_000_000)
    expect(knownContextWindow('deepseek-chat', 'deepseek')).toBe(1_000_000)
    expect(knownContextWindow('deepseek-reasoner', 'deepseek')).toBe(1_000_000)
    expect(knownContextWindow('deepseek/deepseek-v4-flash', 'openrouter')).toBe(1_000_000)
  })

  it('returns 1.05M-class windows for GPT-5.6 and Gemini 3', () => {
    expect(knownContextWindow('gpt-5.6', 'openai')).toBe(1_048_576)
    expect(knownContextWindow('gpt-5.6-terra', 'openai')).toBe(1_048_576)
    expect(knownContextWindow('gemini-3.6-flash', 'gemini')).toBe(1_048_576)
    expect(knownContextWindow('grok-4-latest', 'xai')).toBe(1_000_000)
  })

  it('backfills missing contextWindow without overriding larger API values', () => {
    const missing = withResolvedContextWindow(
      {
        id: 'deepseek-v4-flash',
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
        supportsVision: false
      },
      'deepseek'
    )
    expect(missing.contextWindow).toBe(1_000_000)

    const bogusDefault = withResolvedContextWindow(
      {
        id: 'deepseek-v4-flash',
        contextWindow: 128_000,
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
        supportsVision: false
      },
      'deepseek'
    )
    expect(bogusDefault.contextWindow).toBe(1_000_000)

    const kept = withResolvedContextWindow(
      {
        id: 'deepseek-v4-flash',
        contextWindow: 2_000_000,
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
        supportsVision: false
      },
      'deepseek'
    )
    expect(kept.contextWindow).toBe(2_000_000)
  })
})

describe('resolveModelContextWindow', () => {
  it('prefers live catalog over known table when API reports a real window', () => {
    expect(
      resolveModelContextWindow({ id: 'gpt-5.6', contextWindow: 200_000 }, 'openai')
    ).toBe(200_000)
  })

  it('backfills from known when catalog omits length', () => {
    expect(
      resolveModelContextWindow({ id: 'gpt-5.6', contextWindow: undefined }, 'openai')
    ).toBe(1_048_576)
  })

  it('replaces generic 128k when known window is larger', () => {
    expect(
      resolveModelContextWindow(
        { id: 'deepseek-v4-flash', contextWindow: 128_000 },
        'deepseek'
      )
    ).toBe(1_000_000)
  })
})

describe('Ollama Cloud known windows', () => {
  it('looks up Cloud ids after stripping :cloud and size tags', () => {
    expect(knownContextWindow('gpt-oss:120b', 'ollama')).toBe(131_072)
    expect(knownContextWindow('gpt-oss:120b-cloud', 'ollama')).toBe(131_072)
    expect(knownContextWindow('glm-5.2', 'ollama')).toBe(976_000)
    expect(knownContextWindow('gemma4:31b-cloud', 'ollama')).toBe(262_144)
    expect(knownContextWindow('gemma4:e4b', 'ollama')).toBe(262_144)
    expect(knownContextWindow('minimax-m3', 'ollama')).toBe(512_000)
    expect(knownContextWindow('kimi-k3:cloud', 'ollama')).toBe(1_048_576)
  })

  it('does not invent a window for unlisted local Ollama ids', () => {
    expect(knownContextWindow('llama3.2', 'ollama')).toBeUndefined()
    expect(knownContextWindow('qwen2.5', 'ollama')).toBeUndefined()
  })

  it('prefers live show over the Cloud fallback table', () => {
    expect(
      resolveModelContextWindow({ id: 'glm-5.2', contextWindow: 200_000 }, 'ollama')
    ).toBe(200_000)
    expect(
      resolveModelContextWindow({ id: 'glm-5.2', contextWindow: 128_000 }, 'ollama')
    ).toBe(976_000)
  })
})

describe('Cloudflare Workers AI known windows', () => {
  it('resolves full @cf/ catalog ids from the live catalog snapshot', () => {
    expect(knownContextWindow('@cf/zai-org/glm-5.3-flash', 'custom')).toBe(1_310_720)
    expect(knownContextWindow('@cf/zai-org/glm-4.7-flash', 'custom')).toBe(131_072)
    // Real catalog value — NOT the 128k/131k family number one would assume.
    expect(knownContextWindow('@cf/meta/llama-3.3-70b-instruct-fp8-fast', 'custom')).toBe(24_000)
    expect(knownContextWindow('@cf/qwen/qwen2.5-coder-32b-instruct', 'custom')).toBe(32_768)
    expect(knownContextWindow('@cf/openai/gpt-oss-120b', 'custom')).toBe(128_000)
    expect(knownContextWindow('@cf/zai-org/glm-5.3', 'custom')).toBe(1_310_720)
    expect(knownContextWindow('@cf/deepseek-ai/deepseek-v4-pro-0813', 'custom')).toBe(1_048_576)
  })

  it('matches @cf/ ids case-insensitively', () => {
    expect(knownContextWindow('@CF/Zai-Org/GLM-5.3-Flash', 'custom')).toBe(1_310_720)
  })

  it('does not apply Cloudflare windows to bare ids on other hosts', () => {
    // Only the full @cf/ id proves Cloudflare's serving configuration.
    expect(knownContextWindow('glm-5.2', 'custom')).toBeUndefined()
    expect(knownContextWindow('gpt-oss-120b', 'custom')).toBeUndefined()
  })

  it('budgets the loop against the real window for manually entered @cf/ models', () => {
    const model = {
      id: '@cf/zai-org/glm-5.3-flash',
      inputModalities: ['text'] as const,
      outputModalities: ['text'] as const,
      supportsTools: true,
      supportsVision: false
    }
    expect(contextWindowFor(model, 'custom')).toBe(1_310_720)
    // Per-share floor: 157,286 + 235,929 + 196,608 + 524,288 (remainder to buffer).
    expect(contentWindow(model, 'custom')).toBe(1_114_111)
  })
})

describe('DeepSeek seed + budget', () => {
  it('seeds V4 models with 1M windows', () => {
    const seeds = seedModelsFor('deepseek')
    expect(seeds.map((m) => m.id)).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
    expect(seeds.find((m) => m.id === 'deepseek-v4-flash')?.contextWindow).toBe(1_000_000)
  })

  it('uses known window when ModelInfo omits contextWindow', () => {
    const model = {
      id: 'deepseek-v4-pro',
      inputModalities: ['text'] as const,
      outputModalities: ['text'] as const,
      supportsTools: true,
      supportsVision: false
    }
    expect(contextWindowFor(model)).toBe(1_000_000)
    // content budget is non-buffer shares (85%), not a second buffer subtract
    expect(contentWindow(model)).toBe(850_000)
  })

  it('applies DeepSeek provider heuristic via providerId when id is unlisted', () => {
    const model = {
      id: 'deepseek-experimental-xyz',
      inputModalities: ['text'] as const,
      outputModalities: ['text'] as const,
      supportsTools: true,
      supportsVision: false
    }
    expect(contextWindowFor(model)).toBe(128_000)
    expect(contextWindowFor(model, 'deepseek')).toBe(1_000_000)
  })
})
