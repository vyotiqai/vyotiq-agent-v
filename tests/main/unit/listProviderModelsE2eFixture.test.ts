import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listProviderModels } from '@main/agent/providers'
import { resetModelCacheForTests } from '@main/agent/providers/modelCache'
import { resetSoftWarnCooldownsForTests } from '@main/agent/providers/log'
import { setPublicFetchForTests } from '@main/net/webFetch'

vi.mock('@shared/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn()
  }
}))

vi.mock('@main/e2e/chatFixtureReplay', () => ({
  isChatFixtureReplayEnabled: vi.fn(() => true)
}))

describe('listProviderModels under GUI e2e fixture replay', () => {
  beforeEach(() => {
    resetModelCacheForTests()
    resetSoftWarnCooldownsForTests()
    setPublicFetchForTests(async () => {
      throw new Error('network should not be hit in e2e fixture catalog path')
    })
  })

  afterEach(() => {
    setPublicFetchForTests(null)
    resetModelCacheForTests()
    resetSoftWarnCooldownsForTests()
  })

  it('returns seed models without a seed-fallback warning so Send stays enabled', async () => {
    const res = await listProviderModels({
      provider: 'ollama',
      forceRefresh: true
    })

    expect(res.warning).toBeUndefined()
    expect(res.models.some((m) => m.id === 'qwen2.5')).toBe(true)
  })
})
