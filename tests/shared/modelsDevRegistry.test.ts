import { afterEach, describe, expect, it } from 'vitest'
import {
  __setModelsDevRegistryForTests,
  resolveModelsDevContextWindow,
  type ModelsDevRegistryFixture
} from '@shared/domain/modelsDevRegistry'

afterEach(() => {
  __setModelsDevRegistryForTests(null)
})

const FIXTURE: ModelsDevRegistryFixture = {
  // Real api URL shape (template var in the path — host must still match).
  'cloudflare-workers-ai': {
    api: 'https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1',
    models: {
      '@cf/zai-org/glm-5.3-flash': { id: '@cf/zai-org/glm-5.3-flash', limit: { context: 1_310_720 } },
      '@cf/zai-org/glm-4.7-flash': { id: '@cf/zai-org/glm-4.7-flash', limit: { context: 131_072 } }
    }
  },
  deepinfra: {
    api: 'https://api.deepinfra.com/v1/openai',
    models: {
      // Registry ids keep vendor prefixes and mixed case on some hosts.
      'zai-org/GLM-4.7-Flash': { id: 'zai-org/GLM-4.7-Flash', limit: { context: 202_752 } }
    }
  },
  deepseek: {
    api: 'https://api.deepseek.com',
    models: { 'deepseek-chat': { id: 'deepseek-chat', limit: { context: 1_000_000 } } }
  },
  // Fixed provider without an api field — provider-id mapping must cover it.
  groq: {
    models: { 'llama-4-scout-17b-16e-instruct': { id: 'llama-4-scout-17b-16e-instruct', limit: { context: 131_072 } } }
  },
  'gateway-a': { models: { 'consensus-model': { id: 'consensus-model', limit: { context: 65_536 } } } },
  'gateway-b': { models: { 'consensus-model': { id: 'consensus-model', limit: { context: 65_536 } } } },
  'gateway-c': { models: { 'disputed-model': { id: 'disputed-model', limit: { context: 32_768 } } } },
  'gateway-d': { models: { 'disputed-model': { id: 'disputed-model', limit: { context: 131_072 } } } }
}

describe('models.dev registry context windows', () => {
  it('matches the endpoint host to the serving provider (full id)', async () => {
    __setModelsDevRegistryForTests(FIXTURE)
    expect(
      await resolveModelsDevContextWindow('@cf/zai-org/glm-5.3-flash', {
        apiHost: 'api.cloudflare.com'
      })
    ).toBe(1_310_720)
  })

  it('matches vendor-stripped core ids within the host provider', async () => {
    __setModelsDevRegistryForTests(FIXTURE)
    expect(
      await resolveModelsDevContextWindow('GLM-4.7-Flash', { apiHost: 'api.deepinfra.com' })
    ).toBe(202_752)
  })

  it('keeps serving values provider-specific, not global', async () => {
    __setModelsDevRegistryForTests(FIXTURE)
    const cf = await resolveModelsDevContextWindow('@cf/zai-org/glm-4.7-flash', {
      apiHost: 'api.cloudflare.com'
    })
    const deepinfra = await resolveModelsDevContextWindow('glm-4.7-flash', {
      apiHost: 'api.deepinfra.com'
    })
    expect(cf).toBe(131_072)
    expect(deepinfra).toBe(202_752)
  })

  it('resolves fixed providers by registry id without a host', async () => {
    __setModelsDevRegistryForTests(FIXTURE)
    expect(await resolveModelsDevContextWindow('deepseek-chat', { providerId: 'deepseek' })).toBe(
      1_000_000
    )
    expect(
      await resolveModelsDevContextWindow('llama-4-scout-17b-16e-instruct', { providerId: 'groq' })
    ).toBe(131_072)
  })

  it('falls back to consensus when every provider agrees', async () => {
    __setModelsDevRegistryForTests(FIXTURE)
    expect(
      await resolveModelsDevContextWindow('consensus-model', {
        providerId: 'custom',
        apiHost: '10.0.0.5:8080'
      })
    ).toBe(65_536)
  })

  it('never invents a window when serving configs disagree', async () => {
    __setModelsDevRegistryForTests(FIXTURE)
    expect(
      await resolveModelsDevContextWindow('disputed-model', {
        providerId: 'custom',
        apiHost: '10.0.0.5:8080'
      })
    ).toBeUndefined()
  })

  it('returns undefined for unlisted models on unreachable hosts; single listing is unanimous', async () => {
    __setModelsDevRegistryForTests(FIXTURE)
    expect(
      await resolveModelsDevContextWindow('totally-unknown-model-xyz', {
        providerId: 'custom',
        apiHost: '192.168.1.10:8080'
      })
    ).toBeUndefined()
    // One provider lists deepseek-chat with one value — no dispute to guess about.
    expect(
      await resolveModelsDevContextWindow('deepseek-chat', {
        providerId: 'custom',
        apiHost: 'example.invalid'
      })
    ).toBe(1_000_000)
  })

  it('is case-insensitive on ids and hosts', async () => {
    __setModelsDevRegistryForTests(FIXTURE)
    expect(
      await resolveModelsDevContextWindow('@CF/ZAI-ORG/GLM-4.7-Flash', {
        apiHost: 'API.CLOUDFLARE.COM'
      })
    ).toBe(131_072)
  })
})
