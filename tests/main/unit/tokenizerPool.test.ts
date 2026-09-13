import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PathLike } from 'node:fs'

const fsActual = vi.hoisted(async () => await vi.importActual<typeof import('node:fs')>('node:fs'))
const existsSyncMock = vi.hoisted(() => vi.fn<(path: PathLike) => boolean>())

vi.mock('node:fs', async () => {
  const actual = await fsActual
  return {
    ...actual,
    existsSync: (path: PathLike) => existsSyncMock(path)
  }
})

import {
  encodeCountsInWorker,
  resetTokenizerPoolForTests
} from '@main/agent/context/tokenizerPool'

describe('tokenizerPool', () => {
  beforeEach(async () => {
    resetTokenizerPoolForTests()
    const actual = await fsActual
    existsSyncMock.mockImplementation((path) => actual.existsSync(path))
  })

  afterEach(() => {
    resetTokenizerPoolForTests()
    existsSyncMock.mockReset()
  })

  it('retries pool create after a missing worker script (does not sticky-fail)', async () => {
    const actual = await fsActual
    existsSyncMock.mockImplementation((path) => {
      if (String(path).includes('tokenizer.worker')) return false
      return actual.existsSync(path)
    })

    expect(await encodeCountsInWorker([{ text: 'a', encoding: 'o200k_base' }])).toBeNull()
    expect(await encodeCountsInWorker([{ text: 'b', encoding: 'o200k_base' }])).toBeNull()

    const workerProbes = existsSyncMock.mock.calls.filter((c) =>
      String(c[0]).includes('tokenizer.worker')
    )
    // Without sticky-fail, each encode attempt re-checks the script path.
    expect(workerProbes.length).toBeGreaterThanOrEqual(2)
  })
})
