import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PathLike } from 'node:fs'

const fsActual = vi.hoisted(async () => await vi.importActual<typeof import('node:fs')>('node:fs'))
vi.mock('node:fs', async () => {
  const actual = await fsActual
  return { ...actual, existsSync: (_path: PathLike) => true }
})

/**
 * A mis-bundled worker: constructs fine, exits 0 on the next macrotask (as a real
 * thread that dies on load does) and never answers.
 */
const { DyingWorker } = vi.hoisted(() => {
  class DyingWorker {
    static instances = 0
    private listeners = new Map<string, Array<(arg: unknown) => void>>()
    constructor(readonly script: string) {
      DyingWorker.instances++
      setTimeout(() => {
        for (const fn of this.listeners.get('exit') ?? []) fn(0)
      }, 0)
    }
    on(event: string, fn: (arg: unknown) => void): this {
      const list = this.listeners.get(event) ?? []
      list.push(fn)
      this.listeners.set(event, list)
      return this
    }
    postMessage(): void {}
    async terminate(): Promise<number> {
      return 0
    }
  }
  return { DyingWorker }
})

vi.mock('node:worker_threads', async () => {
  const actual = await vi.importActual<typeof import('node:worker_threads')>('node:worker_threads')
  return { ...actual, Worker: DyingWorker }
})

import { encodeCountsInWorker, resetTokenizerPoolForTests } from '@main/agent/context/tokenizerPool'

afterEach(() => {
  resetTokenizerPoolForTests()
  DyingWorker.instances = 0
})

const ITEM = { text: 'a', encoding: 'o200k_base' } as const

describe('tokenizer pool gives up on workers that die on startup', () => {
  it('stops spawning after a bounded number of early deaths and reports "no pool"', async () => {
    const outcomes: Array<'null' | 'rejected' | 'counts'> = []
    for (let i = 0; i < 12; i++) {
      try {
        const counts = await encodeCountsInWorker([ITEM])
        outcomes.push(counts === null ? 'null' : 'counts')
      } catch {
        outcomes.push('rejected')
      }
    }
    // Bounded: two pool generations, then never again.
    expect(DyingWorker.instances).toBeLessThanOrEqual(4)
    // After giving up, callers get a clean `null` (sync fallback), not a rejection.
    expect(outcomes.slice(-4)).toEqual(['null', 'null', 'null', 'null'])
  })

  it('reset re-arms the pool', async () => {
    for (let i = 0; i < 12; i++) await encodeCountsInWorker([ITEM]).catch(() => null)
    const spawned = DyingWorker.instances
    resetTokenizerPoolForTests()
    await encodeCountsInWorker([ITEM]).catch(() => null)
    expect(DyingWorker.instances).toBeGreaterThan(spawned)
  })
})
