import { describe, expect, it } from 'vitest'
import {
  baseModelInfo,
  normalizeOpenAiStyleModels,
  thinkingPartialFromCatalogRow
} from '@main/agent/providers/normalize'

describe('catalog thinking fields', () => {
  it('maps OpenRouter reasoning object into ModelInfo', () => {
    const models = normalizeOpenAiStyleModels(
      {
        data: [
          {
            id: 'google/gemini-3.5-flash',
            name: 'Gemini 3.5 Flash',
            supported_parameters: ['tools', 'reasoning'],
            reasoning: {
              supported_efforts: ['high', 'medium', 'low', 'minimal', 'none'],
              default_effort: 'medium',
              default_enabled: true,
              mandatory: true,
              supports_max_tokens: false
            },
            architecture: { input_modalities: ['text'], output_modalities: ['text'] },
            context_length: 128000
          }
        ]
      },
      { providerId: 'openrouter', requireToolsParam: true }
    )
    expect(models).toHaveLength(1)
    const m = models[0]!
    expect(m.supportsThinking).toBe(true)
    expect(m.supportedThinkingEfforts).toEqual(['high', 'medium', 'low', 'minimal'])
    expect(m.thinkingCanDisable).toBe(false)
    expect(m.thinkingDefaultEffort).toBe('medium')
    expect(m.thinkingApi).toBe('chat_completions')
  })

  it('infers thinking from supported_parameters when reasoning object absent', () => {
    const partial = thinkingPartialFromCatalogRow(
      { id: 'x', supported_parameters: ['tools', 'reasoning_effort'] },
      'openrouter'
    )
    expect(partial.supportsThinking).toBe(true)
  })

  it('falls back to heuristic when catalog omits thinking', () => {
    const m = baseModelInfo('gpt-5.6', {}, 'openai')
    expect(m.supportsThinking).toBe(true)
    expect(m.thinkingApi).toBe('responses')
    expect(m.supportedThinkingEfforts).toContain('high')
  })

  it('leaves Ollama thinking unset when capabilities are omitted', () => {
    const m = baseModelInfo('deepseek-r1:latest', { supportsTools: true }, 'ollama')
    expect(m.supportsThinking).toBeUndefined()
    expect(m.thinkingMode).toBeUndefined()
  })

  it('maps live Ollama capabilities thinking to protocol effort ladder', () => {
    const partial = thinkingPartialFromCatalogRow(
      { id: 'gpt-oss:120b-cloud', capabilities: ['completion', 'tools', 'thinking'] },
      'ollama'
    )
    expect(partial.supportsThinking).toBe(true)
    expect(partial.thinkingMode).toBe('effort')
    expect(partial.thinkingCanDisable).toBe(false)
    expect(partial.supportedThinkingEfforts).toEqual(['low', 'medium', 'high'])

    const m = baseModelInfo('gpt-oss:120b-cloud', { supportsTools: true, ...partial }, 'ollama')
    expect(m.supportsThinking).toBe(true)
    expect(m.thinkingMode).toBe('effort')
    expect(m.thinkingCanDisable).toBe(false)
    expect(m.supportedThinkingEfforts).toEqual(['low', 'medium', 'high'])
  })

  it('does not invent thinking for Ollama cloud ids without capabilities', () => {
    expect(
      baseModelInfo('deepseek-v3.1:671b-cloud', { supportsTools: true }, 'ollama').supportsThinking
    ).toBeUndefined()
    expect(baseModelInfo('glm-5.2', { supportsTools: true }, 'ollama').supportsThinking).toBeUndefined()
    expect(
      baseModelInfo('gemma4:31b-cloud', { supportsTools: true }, 'ollama').supportsThinking
    ).toBeUndefined()
  })

  it('maps Ollama capabilities string array to supportsThinking and effort ladder', () => {
    const partial = thinkingPartialFromCatalogRow(
      { id: 'plain-cloud-thinker', capabilities: ['completion', 'tools', 'thinking'] },
      'ollama'
    )
    expect(partial.supportsThinking).toBe(true)
    expect(partial.thinkingMode).toBe('effort')
    expect(partial.supportedThinkingEfforts).toEqual(['low', 'medium', 'high', 'max'])

    const noThink = thinkingPartialFromCatalogRow(
      { id: 'llama3.2', capabilities: ['completion', 'tools'] },
      'ollama'
    )
    expect(noThink.supportsThinking).toBe(false)
    expect(noThink.thinkingMode).toBeUndefined()
  })

  it('does not treat object-style capabilities as an Ollama array', () => {
    const partial = thinkingPartialFromCatalogRow(
      {
        id: 'claude-sonnet-4-6',
        capabilities: { thinking: true, extended_thinking: false }
      },
      'anthropic'
    )
    expect(partial.supportsThinking).toBe(true)
  })

  it('sets adaptive mode for Anthropic 4.6 via provider defaults', () => {
    const m = baseModelInfo('claude-sonnet-4-6', {}, 'anthropic')
    expect(m.supportsThinking).toBe(true)
    expect(m.thinkingMode).toBe('adaptive')
    expect(m.thinkingApi).toBe('messages')
  })

  it('does not overwrite adaptive_thinking true with thinking/extended false', () => {
    const partial = thinkingPartialFromCatalogRow(
      {
        id: 'claude-sonnet-4-6',
        capabilities: {
          adaptive_thinking: true,
          thinking: false,
          extended_thinking: false
        }
      },
      'anthropic'
    )
    expect(partial.supportsThinking).toBe(true)
  })

  it('accepts reasoning boolean true as supportsThinking', () => {
    const partial = thinkingPartialFromCatalogRow({ id: 'x', reasoning: true }, 'openrouter')
    expect(partial.supportsThinking).toBe(true)
  })

  it('keeps OpenRouter reasoning-only rows when tools param missing', () => {
    const models = normalizeOpenAiStyleModels(
      {
        data: [
          {
            id: 'deepseek/deepseek-r1',
            name: 'DeepSeek R1',
            supported_parameters: ['reasoning', 'reasoning_effort'],
            architecture: { input_modalities: ['text'], output_modalities: ['text'] }
          },
          {
            id: 'some/no-tools-no-reason',
            name: 'Plain',
            supported_parameters: ['temperature'],
            architecture: { input_modalities: ['text'], output_modalities: ['text'] }
          }
        ]
      },
      { providerId: 'openrouter', requireToolsParam: true }
    )
    expect(models.map((m) => m.id)).toEqual(['deepseek/deepseek-r1'])
    expect(models[0]!.supportsThinking).toBe(true)
    expect(models[0]!.thinkingApi).toBe('chat_completions')
  })

  it('sets thinkingApi for catalog-true models even when heuristic misses', () => {
    const m = baseModelInfo(
      'some-vendor/plain-model-v2',
      { supportsThinking: true },
      'openrouter'
    )
    expect(m.supportsThinking).toBe(true)
    expect(m.thinkingApi).toBe('chat_completions')
  })
})
