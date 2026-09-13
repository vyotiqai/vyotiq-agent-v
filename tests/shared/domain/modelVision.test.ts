import { describe, expect, it } from 'vitest'
import { idSuggestsVision } from '@shared/domain/modelVision'

describe('idSuggestsVision', () => {
  it('matches known vision-capable families', () => {
    const visionIds = [
      'gpt-4o',
      'gpt-4o-mini',
      'chatgpt-4o-latest',
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4.1-nano',
      'gpt-4.5',
      'gpt-4-turbo',
      'gpt-4-turbo-2024-04-09',
      'gpt-5.6',
      'o1',
      'o1-pro',
      'o1-pro-2025-03-19',
      'o3',
      'o3-pro',
      'o3-2025-04-16',
      'o4-mini',
      'o4-mini-2025-04-16',
      'qwen2-vl-7b',
      'qwen2.5-vl-72b',
      'qwen3-vl-235b',
      'qvq-72b',
      'gemma3:4b',
      'gemma3:12b',
      'gemma3:27b-it',
      'minicpm-v',
      'internvl2-8b',
      'llama-4-scout-17b-16e-instruct',
      'claude-sonnet-4',
      'gemini-2.5-pro',
      'grok-4-latest',
      'pixtral-large-latest',
      'mistral-small-latest',
      'mistral-large-latest',
      'moondream',
      'llava:13b',
      'llama3.2-vision:11b',
      'glm-5.3-flash',
      'glm-4.5v',
      'openai/gpt-4.1',
      'mistral/mistral-large-latest'
    ]
    for (const id of visionIds) {
      expect(idSuggestsVision(id), id).toBe(true)
    }
  })

  it('keeps text-only variants and chat-only ids false', () => {
    const textOnlyIds = [
      'gemma3:1b',
      'gemma3:1b-it-qat',
      'o1-mini',
      'o1-preview',
      'o3-mini',
      'o3-mini-high',
      'gpt-3.5-turbo',
      'gpt-4',
      'gpt-4-32k',
      'deepseek-chat',
      'deepseek-v4-flash',
      'glm-4.6',
      'glm-5.2',
      'qwen2.5',
      'qwen3-235b-a22b',
      'llama3.2',
      'llama-3.3-70b',
      'mistral-7b',
      'gpt-oss:120b',
      'phi-4',
      'kimi-k2'
    ]
    for (const id of textOnlyIds) {
      expect(idSuggestsVision(id), id).toBe(false)
    }
  })
})
