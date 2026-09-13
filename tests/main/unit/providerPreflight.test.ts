import { describe, expect, it } from 'vitest'
import { preflightChatProviderAuth } from '@main/agent/providers/preflight'

describe('preflightChatProviderAuth', () => {
  it('allows local ollama without a key', () => {
    expect(
      preflightChatProviderAuth({
        providerId: 'ollama',
        apiKey: null,
        baseUrl: 'http://127.0.0.1:11434',
        encryptionAvailable: true,
        hasStoredBlob: false
      })
    ).toBeNull()
  })

  it('requires a key for ollama.com with a cloud-specific message', () => {
    const fail = preflightChatProviderAuth({
      providerId: 'ollama',
      apiKey: null,
      baseUrl: 'https://ollama.com',
      encryptionAvailable: true,
      hasStoredBlob: false
    })
    expect(fail?.code).toBe('PROVIDER_AUTH')
    expect(fail?.message).toMatch(/Ollama Cloud/i)
    expect(fail?.message).toMatch(/127\.0\.0\.1:11434/)
  })

  it('requires a key for openai', () => {
    const fail = preflightChatProviderAuth({
      providerId: 'openai',
      apiKey: null,
      baseUrl: null,
      encryptionAvailable: true,
      hasStoredBlob: false
    })
    expect(fail?.code).toBe('PROVIDER_AUTH')
    expect(fail?.message).toMatch(/openai/i)
  })
})
