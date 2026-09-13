import { describe, expect, it } from 'vitest'
import { emptySecretStatus } from '@shared/ipc'
import {
  CUSTOM_OPENAI_DEFAULT,
  isProviderConfigured,
  listConfiguredProviders,
  providerOptionsForConfigured
} from '@shared/domain/providers'

describe('isProviderConfigured', () => {
  it('treats cloud providers as configured only when a key is saved', () => {
    const secrets = emptySecretStatus()
    expect(isProviderConfigured('openai', secrets)).toBe(false)
    secrets.openai = true
    expect(isProviderConfigured('openai', secrets)).toBe(true)
  })

  it('treats local Ollama as configured without a key', () => {
    const secrets = emptySecretStatus()
    expect(isProviderConfigured('ollama', secrets, { ollamaBaseUrl: 'http://127.0.0.1:11434' })).toBe(
      true
    )
  })

  it('requires a key for Ollama Cloud', () => {
    const secrets = emptySecretStatus()
    expect(
      isProviderConfigured('ollama', secrets, { ollamaBaseUrl: 'https://ollama.com' })
    ).toBe(false)
    secrets.ollama = true
    expect(
      isProviderConfigured('ollama', secrets, { ollamaBaseUrl: 'https://ollama.com' })
    ).toBe(true)
  })

  it('treats private custom hosts as configured without a key', () => {
    const secrets = emptySecretStatus()
    expect(
      isProviderConfigured('custom', secrets, { customOpenAiBaseUrl: CUSTOM_OPENAI_DEFAULT })
    ).toBe(true)
  })

  it('requires a key for public custom hosts', () => {
    const secrets = emptySecretStatus()
    expect(
      isProviderConfigured('custom', secrets, {
        customOpenAiBaseUrl: 'https://api.fireworks.ai/inference/v1'
      })
    ).toBe(false)
    secrets.custom = true
    expect(
      isProviderConfigured('custom', secrets, {
        customOpenAiBaseUrl: 'https://api.fireworks.ai/inference/v1'
      })
    ).toBe(true)
  })
})

describe('listConfiguredProviders', () => {
  it('returns only configured providers in catalog order', () => {
    const secrets = emptySecretStatus()
    secrets.openai = true
    secrets.groq = true
    expect(
      listConfiguredProviders(secrets, {
        ollamaBaseUrl: 'http://127.0.0.1:11434',
        customOpenAiBaseUrl: CUSTOM_OPENAI_DEFAULT
      })
    ).toEqual(['openai', 'ollama', 'groq', 'custom'])
  })

  it('always includes requested providers even when unconfigured', () => {
    const secrets = emptySecretStatus()
    expect(
      listConfiguredProviders(secrets, {
        ollamaBaseUrl: 'http://127.0.0.1:11434',
        alwaysInclude: ['anthropic']
      })
    ).toEqual(['anthropic', 'ollama', 'custom'])
  })
})

describe('providerOptionsForConfigured', () => {
  it('maps configured providers to menu options', () => {
    const secrets = emptySecretStatus()
    secrets.openai = true
    expect(
      providerOptionsForConfigured(secrets, {
        ollamaBaseUrl: 'http://127.0.0.1:11434'
      })
    ).toEqual([
      { value: 'openai', label: 'OpenAI' },
      { value: 'ollama', label: 'Ollama' },
      { value: 'custom', label: 'Custom OpenAI-compatible' }
    ])
  })
})
