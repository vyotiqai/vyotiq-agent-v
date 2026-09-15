import { describe, expect, it } from 'vitest'
import { emptySecretStatus } from '@shared/ipc'
import {
  deriveModelReadiness,
  modelReadinessSendReason
} from '../../../src/renderer/src/features/chat/components/composer/modelReadiness'

describe('deriveModelReadiness', () => {
  it('requires an API key for cloud providers without a saved secret', () => {
    const issue = deriveModelReadiness({
      provider: 'openai',
      model: 'gpt-4o',
      secrets: emptySecretStatus(),
      catalogWarning: null,
      liveCatalog: null,
      catalogLoading: false
    })
    expect(issue).toEqual({ kind: 'missing_key', provider: 'openai', label: 'OpenAI' })
    expect(modelReadinessSendReason(issue!)).toMatch(/API key/i)
  })

  it('treats local Ollama as configured without a key', () => {
    const issue = deriveModelReadiness({
      provider: 'ollama',
      model: 'qwen2.5',
      secrets: emptySecretStatus(),
      ollamaBaseUrl: 'http://127.0.0.1:11434',
      catalogWarning: null,
      liveCatalog: [{
        id: 'qwen2.5',
        displayName: 'qwen2.5',
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
        supportsVision: false
      }],
      catalogLoading: false
    })
    expect(issue).toBeNull()
  })

  it('flags seed-fallback catalog warnings as unreachable', () => {
    const issue = deriveModelReadiness({
      provider: 'ollama',
      model: 'qwen2.5',
      secrets: emptySecretStatus(),
      ollamaBaseUrl: 'http://127.0.0.1:11434',
      catalogWarning: 'Cannot reach Ollama at http://127.0.0.1:11434. Showing seed defaults (not live models).',
      liveCatalog: null,
      catalogLoading: false
    })
    expect(issue?.kind).toBe('unreachable')
  })

  it('flags a selected model missing from the live catalog', () => {
    const issue = deriveModelReadiness({
      provider: 'ollama',
      model: 'qwen2.5',
      secrets: emptySecretStatus(),
      ollamaBaseUrl: 'http://127.0.0.1:11434',
      catalogWarning: null,
      liveCatalog: [{
        id: 'llama3.2',
        displayName: 'llama3.2',
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
        supportsVision: false
      }],
      catalogLoading: false
    })
    expect(issue).toEqual({
      kind: 'model_missing',
      provider: 'ollama',
      label: 'Ollama',
      model: 'qwen2.5'
    })
  })

  it('does not block during the first catalog load before any warning', () => {
    const issue = deriveModelReadiness({
      provider: 'ollama',
      model: 'qwen2.5',
      secrets: emptySecretStatus(),
      ollamaBaseUrl: 'http://127.0.0.1:11434',
      catalogWarning: null,
      liveCatalog: null,
      catalogLoading: true
    })
    expect(issue).toBeNull()
  })
})
