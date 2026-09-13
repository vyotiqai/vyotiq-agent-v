import { describe, expect, it } from 'vitest'
import { ollamaCatalogNeedsShow } from '@renderer/features/chat/components/composer/useProviderCatalogCache'
import { pickerModelsFromCatalogEntry } from '@renderer/features/chat/components/composer/composerModelUtils'
import type { ModelInfo } from '@shared/ipc'

const textModel = (id: string, extra?: Partial<ModelInfo>): ModelInfo => ({
  id,
  inputModalities: ['text'],
  outputModalities: ['text'],
  supportsTools: true,
  supportsVision: false,
  ...extra
})

describe('ollamaCatalogNeedsShow', () => {
  it('retries when the selected model is missing', () => {
    expect(ollamaCatalogNeedsShow(undefined)).toBe(true)
  })

  it('retries when the context window is missing even if thinking is confirmed false', () => {
    expect(ollamaCatalogNeedsShow(textModel('llama3.2', { supportsThinking: false }))).toBe(true)
  })

  it('retries when thinking is unset even if a known window exists', () => {
    expect(ollamaCatalogNeedsShow(textModel('glm-5.2', { contextWindow: 976_000 }))).toBe(true)
  })

  it('does not treat confirmed false plus a window as show-complete skip for missing window only', () => {
    expect(
      ollamaCatalogNeedsShow(
        textModel('llama3.2', { supportsThinking: false, contextWindow: 32_768 })
      )
    ).toBe(false)
  })

  it('skips show once thinking effort ladder and window are present', () => {
    expect(
      ollamaCatalogNeedsShow(
        textModel('glm-5.2', {
          supportsThinking: true,
          thinkingMode: 'effort',
          supportedThinkingEfforts: ['low', 'medium', 'high', 'max'],
          contextWindow: 976_000
        })
      )
    ).toBe(false)
  })
})

describe('pickerModelsFromCatalogEntry', () => {
  it('keeps previous live models while a catalog refresh is loading', () => {
    const models = [textModel('glm-5.2'), textModel('gpt-oss:120b')]
    expect(
      pickerModelsFromCatalogEntry({
        models,
        warning: null,
        loading: true
      })
    ).toEqual(models)
  })

  it('wipes picker models for seed-fallback warnings', () => {
    expect(
      pickerModelsFromCatalogEntry({
        models: [textModel('qwen2.5')],
        warning: 'Cannot reach Ollama. Showing seed defaults (not live models).',
        loading: false
      })
    ).toBeNull()
  })
})
