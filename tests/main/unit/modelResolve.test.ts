import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listProviderModelsMock = vi.hoisted(() => vi.fn())

vi.mock('@main/agent/providers', () => ({ listProviderModels: listProviderModelsMock }))

import { resolveModelInfo } from '@main/agent/modelResolve'
import { __setModelsDevRegistryForTests } from '@shared/domain/modelsDevRegistry'

const SIGNAL = new AbortController().signal

const REGISTRY_FIXTURE = {
  'cloudflare-workers-ai': {
    api: 'https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1',
    models: {
      '@cf/zai-org/glm-5.3-flash': { id: '@cf/zai-org/glm-5.3-flash', limit: { context: 1_310_720 } },
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast': {
        id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        limit: { context: 24_000 }
      }
    }
  },
  deepinfra: {
    api: 'https://api.deepinfra.com/v1/openai',
    models: { 'zai-org/glm-4.7-flash': { id: 'zai-org/glm-4.7-flash', limit: { context: 202_752 } } }
  }
}

describe('resolveModelInfo', () => {
  beforeEach(() => {
    listProviderModelsMock.mockReset()
    // Default: empty registry so lookups never hit the network.
    __setModelsDevRegistryForTests({})
  })

  afterEach(() => {
    __setModelsDevRegistryForTests(null)
  })

  it('keeps a live catalog context window when present', async () => {
    listProviderModelsMock.mockResolvedValue({
      models: [{ id: 'deepseek-chat', contextWindow: 65_536, supportsTools: true }]
    })
    const info = await resolveModelInfo('openai', 'deepseek-chat', null, undefined, SIGNAL)
    expect(info.id).toBe('deepseek-chat')
    expect(info.contextWindow).toBe(65_536)
  })

  it('falls back to seed metadata for a seeded ollama model absent from the live list', async () => {
    listProviderModelsMock.mockResolvedValue({ models: [] })
    const info = await resolveModelInfo('ollama', 'qwen2.5', null, undefined, SIGNAL)
    expect(info.id).toBe('qwen2.5')
    expect(info.contextWindow).toBeGreaterThan(0)
  })

  it('uses the conservative 128k default for fully unknown models', async () => {
    listProviderModelsMock.mockResolvedValue({ models: [] })
    const info = await resolveModelInfo(
      'custom',
      'totally-unknown-model-xyz',
      null,
      undefined,
      SIGNAL
    )
    expect(info.id).toBe('totally-unknown-model-xyz')
    expect(info.contextWindow).toBe(128_000)
  })

  it('passes provider credentials through to the catalog listing', async () => {
    listProviderModelsMock.mockResolvedValue({ models: [] })
    await resolveModelInfo('openai', 'm', 'sk-test-key', 'https://example.invalid/v1', SIGNAL)
    expect(listProviderModelsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai',
        apiKey: 'sk-test-key',
        baseUrl: 'https://example.invalid/v1',
        model: 'm'
      })
    )
  })

  it('resolves manually entered Cloudflare ids from the registry via the base URL host', async () => {
    __setModelsDevRegistryForTests(REGISTRY_FIXTURE)
    listProviderModelsMock.mockResolvedValue({ models: [] })
    const info = await resolveModelInfo(
      'custom',
      '@cf/zai-org/glm-5.3-flash',
      'cf-key',
      'https://api.cloudflare.com/client/v4/accounts/acct/ai/v1',
      SIGNAL
    )
    expect(info.contextWindow).toBe(1_310_720)
  })

  it('backfills context windows for live-listed rows that omit context_length', async () => {
    __setModelsDevRegistryForTests(REGISTRY_FIXTURE)
    listProviderModelsMock.mockResolvedValue({
      models: [{ id: 'zai-org/glm-4.7-flash', supportsTools: true }]
    })
    const info = await resolveModelInfo(
      'custom',
      'zai-org/glm-4.7-flash',
      null,
      'https://api.deepinfra.com/v1/openai',
      SIGNAL
    )
    expect(info.contextWindow).toBe(202_752)
  })
})
