import { describe, expect, it } from 'vitest'
import { emptySecretStatus, type CustomProvider } from '@shared/ipc'
import {
  CUSTOM_OPENAI_DEFAULT,
  defaultModelFor,
  isProviderConfigured,
  listConfiguredProviders,
  providerLabel,
  providerNeedsKey,
  providerOptionsForConfigured,
  resolveProviderChatBaseUrl,
  resolveProviderListBaseUrl,
  seedModelsFor
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

describe('custom provider ids (custom:<slug>)', () => {
  const list: CustomProvider[] = [
    {
      id: 'custom:deepinfra',
      name: 'DeepInfra',
      baseUrl: 'https://api.deepinfra.com/v1'
    },
    {
      id: 'custom:lan-llama',
      name: 'LAN Llama',
      baseUrl: 'http://192.168.1.10:8080/v1'
    }
  ]

  it('resolves chat and list base URLs from the saved list entry first', () => {
    expect(resolveProviderChatBaseUrl('custom:deepinfra', { customProviders: list })).toBe(
      'https://api.deepinfra.com/v1'
    )
    expect(
      resolveProviderListBaseUrl('custom:deepinfra', undefined, { customProviders: list })
    ).toBe('https://api.deepinfra.com/v1')
  })

  it('falls back to the legacy customOpenAiBaseUrl for custom:default and missing entries', () => {
    const settings = { customOpenAiBaseUrl: 'https://legacy.example.com/v1' }
    expect(resolveProviderChatBaseUrl('custom:default', settings)).toBe(
      'https://legacy.example.com/v1'
    )
    expect(resolveProviderChatBaseUrl('custom:missing', settings)).toBe(
      'https://legacy.example.com/v1'
    )
    expect(resolveProviderListBaseUrl('custom:missing', undefined, settings)).toBe(
      'https://legacy.example.com/v1'
    )
    // Product default when neither a list entry nor the legacy field exists.
    expect(resolveProviderChatBaseUrl('custom:missing', {})).toBe(CUSTOM_OPENAI_DEFAULT)
  })

  it('lets an explicit request base win for listModels', () => {
    expect(
      resolveProviderListBaseUrl('custom:deepinfra', 'https://req.example.com/v1', {
        customProviders: list
      })
    ).toBe('https://req.example.com/v1')
  })

  it('labels dynamic ids from the list entry, falling back to Custom', () => {
    expect(providerLabel('custom:deepinfra', list)).toBe('DeepInfra')
    expect(providerLabel('custom:deepinfra')).toBe('Custom')
    expect(providerLabel('custom:lan-llama', list)).toBe('LAN Llama')
    expect(providerLabel('custom')).toBe('Custom OpenAI-compatible')
  })

  it('seeds and defaults models for dynamic ids via the custom catalog', () => {
    expect(seedModelsFor('custom:deepinfra')).toEqual(seedModelsFor('custom'))
    expect(defaultModelFor('custom:deepinfra')).toBe(defaultModelFor('custom'))
  })

  it('key-gates public hosts but not loopback/LAN hosts', () => {
    expect(providerNeedsKey('custom:deepinfra', 'https://api.deepinfra.com/v1')).toBe(true)
    expect(providerNeedsKey('custom:lan', 'http://192.168.1.10:8080/v1')).toBe(false)
    expect(providerNeedsKey('custom:lan', 'http://127.0.0.1:8080/v1')).toBe(false)
  })

  it('resolves configuration from the list entry, then the legacy field', () => {
    const secrets = emptySecretStatus()
    // LAN entry is keyless → configured; public entry needs a key.
    expect(
      isProviderConfigured('custom:lan-llama', secrets, { customProviders: list })
    ).toBe(true)
    expect(
      isProviderConfigured('custom:deepinfra', secrets, { customProviders: list })
    ).toBe(false)
    // Stored key satisfies the public host.
    expect(
      isProviderConfigured('custom:deepinfra', { ...secrets, 'custom:deepinfra': true }, {
        customProviders: list
      })
    ).toBe(true)
    // Missing entry falls back to the legacy field.
    expect(
      isProviderConfigured('custom:missing', secrets, {
        customOpenAiBaseUrl: CUSTOM_OPENAI_DEFAULT
      })
    ).toBe(true)
  })
})
