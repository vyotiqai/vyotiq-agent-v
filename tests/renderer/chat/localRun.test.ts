import { describe, expect, it } from 'vitest'
import { providerRunsLocally } from '@renderer/lib/chat/localRun'

const endpoints = {
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  customOpenAiBaseUrl: 'http://127.0.0.1:8080/v1',
  customProviders: [
    { id: 'custom:lmstudio', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1' },
    { id: 'custom:gateway', name: 'Gateway', baseUrl: 'https://gateway.example.com/v1' }
  ]
} as unknown as Parameters<typeof providerRunsLocally>[1]

describe('providerRunsLocally (W5)', () => {
  it('is local Ollama only while no key routes it to Ollama Cloud', () => {
    expect(providerRunsLocally('ollama', endpoints, false)).toBe(true)
    expect(providerRunsLocally('ollama', endpoints, true)).toBe(false)
    expect(providerRunsLocally('ollama', { ...endpoints, ollamaBaseUrl: 'http://gpu-box.lan:11434' }, false)).toBe(false)
  })

  it('reads an OpenAI-compatible endpoint by its host', () => {
    expect(providerRunsLocally('custom', endpoints, false)).toBe(true)
    expect(providerRunsLocally('custom', { ...endpoints, customOpenAiBaseUrl: 'https://api.example.com/v1' }, false)).toBe(false)
    expect(providerRunsLocally('custom:lmstudio', endpoints, false)).toBe(true)
    expect(providerRunsLocally('custom:gateway', endpoints, false)).toBe(false)
    expect(providerRunsLocally('custom:missing', endpoints, false)).toBe(false)
  })

  it('never counts a hosted provider as local', () => {
    expect(providerRunsLocally('anthropic', endpoints, false)).toBe(false)
    expect(providerRunsLocally('openai', endpoints, false)).toBe(false)
  })
})
