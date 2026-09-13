import { afterEach, describe, expect, it, vi } from 'vitest'
import { countTextsTokensAsync, resetTokenizerCache } from '@main/agent/context/tokenizer'
import { resetTokenizerPoolForTests } from '@main/agent/context/tokenizerPool'

vi.mock('@main/agent/context/tokenizerPool', async () => {
  const actual = await vi.importActual<typeof import('@main/agent/context/tokenizerPool')>(
    '@main/agent/context/tokenizerPool'
  )
  return {
    ...actual,
    encodeCountsInWorker: vi.fn()
  }
})

import { encodeCountsInWorker } from '@main/agent/context/tokenizerPool'

describe('tokenizer worker offload', () => {
  afterEach(() => {
    resetTokenizerCache()
    resetTokenizerPoolForTests()
    vi.mocked(encodeCountsInWorker).mockReset()
  })

  it('uses worker counts when the pool returns them', async () => {
    vi.mocked(encodeCountsInWorker).mockResolvedValue([42, 7])
    const counts = await countTextsTokensAsync([
      { text: 'alpha-unique-worker-test', encoding: 'o200k_base' },
      { text: 'beta-unique-worker-test', encoding: 'o200k_base' }
    ])
    expect(encodeCountsInWorker).toHaveBeenCalledOnce()
    expect(counts).toEqual([42, 7])
  })

  it('falls back to sync BPE when the worker pool is unavailable', async () => {
    vi.mocked(encodeCountsInWorker).mockResolvedValue(null)
    const counts = await countTextsTokensAsync([
      { text: 'hello world', encoding: 'o200k_base' }
    ])
    expect(counts[0]).toBe(2)
  })

  it('does not call the worker for cache hits or large heuristic text', async () => {
    vi.mocked(encodeCountsInWorker).mockResolvedValue([2])
    await countTextsTokensAsync([{ text: 'hello world', encoding: 'o200k_base' }])
    vi.mocked(encodeCountsInWorker).mockClear()

    const counts = await countTextsTokensAsync([
      { text: 'hello world', encoding: 'o200k_base' },
      { text: 'a'.repeat(120_000), encoding: 'o200k_base' },
      { text: '', encoding: 'o200k_base' }
    ])
    expect(encodeCountsInWorker).not.toHaveBeenCalled()
    expect(counts).toEqual([2, 30_000, 0])
  })
})
