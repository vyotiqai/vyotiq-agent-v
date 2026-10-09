import { afterEach, describe, expect, it } from 'vitest'
import {
  matchCustomModelPrice,
  resolveModelPrice,
  setCustomModelPrices,
  setExternalPriceLookup,
  type CustomModelPrice
} from '../../src/shared/pricing/modelPrices'
import {
  __setModelsDevRegistryForTests,
  lookupModelsDevPrice
} from '../../src/shared/domain/modelsDevRegistry'

afterEach(() => {
  setCustomModelPrices([])
  setExternalPriceLookup(null)
  __setModelsDevRegistryForTests(null)
})

describe('custom model prices', () => {
  const prices: CustomModelPrice[] = [
    { provider: '*', model: 'llama-*', input: 1, output: 2 },
    { provider: 'custom:lab', model: 'llama-*', input: 3, output: 4 },
    { provider: 'custom:lab', model: 'llama-3.3-70b', input: 5, output: 6 },
    { provider: 'custom:lab', model: 'llama-3.3-*', input: 7, output: 8 }
  ]

  it('prefers an exact id, then the longest prefix, then a provider-specific entry', () => {
    expect(matchCustomModelPrice(prices, 'custom:lab', 'Llama-3.3-70B')?.input).toBe(5)
    expect(matchCustomModelPrice(prices, 'custom:lab', 'llama-3.3-8b')?.input).toBe(7)
    expect(matchCustomModelPrice(prices, 'custom:lab', 'llama-2-7b')?.input).toBe(3)
    expect(matchCustomModelPrice(prices, 'groq', 'llama-2-7b')?.input).toBe(1)
    expect(matchCustomModelPrice(prices, 'groq', 'mixtral')).toBeNull()
  })

  it('wins over the table, and says where it came from', () => {
    const table = resolveModelPrice('anthropic', 'claude-sonnet-4-5')
    expect(table?.origin).toBe('table')
    setCustomModelPrices([{ provider: 'anthropic', model: 'claude-sonnet-4-5', input: 0.5, output: 1, cachedInput: 0.1 }])
    const custom = resolveModelPrice('anthropic', 'claude-sonnet-4-5')
    expect(custom).toMatchObject({ origin: 'custom', price: { input: 0.5, output: 1, cachedInput: 0.1 } })
  })
})

describe('models.dev prices', () => {
  it('prices a model the table does not know, by the endpoint host first', () => {
    __setModelsDevRegistryForTests({
      togetherai: {
        api: 'https://api.together.xyz/v1',
        models: { 'meta-llama/Llama-3.3-70B': { id: 'meta-llama/Llama-3.3-70B', cost: { input: 0.88, output: 0.88 } } }
      },
      fireworks: {
        api: 'https://api.fireworks.ai/inference/v1',
        models: { 'meta-llama/Llama-3.3-70B': { id: 'meta-llama/Llama-3.3-70B', cost: { input: 0.9, output: 0.9, cache_read: 0.45 } } }
      }
    })
    expect(lookupModelsDevPrice('meta-llama/llama-3.3-70b', { apiHost: 'api.fireworks.ai' })).toEqual({
      input: 0.9,
      output: 0.9,
      cachedInput: 0.45
    })
    // Two hosts disagree and no host was named: no answer rather than a guess.
    expect(lookupModelsDevPrice('meta-llama/llama-3.3-70b')).toBeNull()
  })

  it('answers through resolveModelPrice only after the table, and only when installed', () => {
    __setModelsDevRegistryForTests({
      'amazon-bedrock': { models: { 'new-model-1': { id: 'new-model-1', cost: { input: 2, output: 8 } } } }
    })
    expect(resolveModelPrice('bedrock', 'new-model-1')).toBeNull()
    setExternalPriceLookup((_provider, modelId) => lookupModelsDevPrice(modelId, { providerId: 'bedrock' }))
    expect(resolveModelPrice('bedrock', 'new-model-1')).toMatchObject({
      origin: 'registry',
      price: { input: 2, output: 8 }
    })
    // The table still answers first for a model it knows.
    expect(resolveModelPrice('anthropic', 'claude-sonnet-4-5')?.origin).toBe('table')
  })

  it('ignores a catalog entry without both rates', () => {
    __setModelsDevRegistryForTests({
      groq: { models: { half: { id: 'half', cost: { input: 1 } } } }
    })
    expect(lookupModelsDevPrice('half', { providerId: 'groq' })).toBeNull()
  })
})
