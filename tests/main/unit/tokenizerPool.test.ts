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

/**
 * Stand-in for a `worker_threads` Worker, faithful on the two behaviours these
 * tests turn on: `postMessage` after the thread is gone is a silent no-op (no
 * throw, no reply — measured against real Node), and `terminate()` emits `exit`.
 */
const { FakeWorker } = vi.hoisted(() => {
  class FakeWorker {
    static instances: FakeWorker[] = []
    static autoReply = true
    readonly posted: Array<{ id: number; items: unknown[] }> = []
    private listeners = new Map<string, Array<(arg: never) => void>>()
    dead = false

    constructor(readonly script: string) {
      FakeWorker.instances.push(this)
    }

    on(event: string, fn: (arg: never) => void): this {
      const list = this.listeners.get(event) ?? []
      list.push(fn)
      this.listeners.set(event, list)
      return this
    }

    emit(event: string, arg?: unknown): void {
      for (const fn of this.listeners.get(event) ?? []) (fn as (a: unknown) => void)(arg)
    }

    postMessage(msg: { id: number; items: unknown[] }): void {
      // A dead worker accepts the message and drops it. This is the whole reason a
      // retained dead slot can never settle its promise.
      if (this.dead) return
      this.posted.push(msg)
      if (!FakeWorker.autoReply) return
      queueMicrotask(() => this.emit('message', { id: msg.id, counts: msg.items.map(() => 1) }))
    }

    async terminate(): Promise<number> {
      this.dead = true
      this.emit('exit', 0)
      return 0
    }
  }
  return { FakeWorker }
})

vi.mock('node:worker_threads', async () => {
  const actual = await vi.importActual<typeof import('node:worker_threads')>('node:worker_threads')
  return { ...actual, Worker: FakeWorker }
})

import {
  encodeCountsInWorker,
  resetTokenizerPoolForTests
} from '@main/agent/context/tokenizerPool'

const ITEM = { text: 'a', encoding: 'o200k_base' } as const

/** Resolves to 'HUNG' when the pool never settles, so a regression fails fast. */
async function withinTick(promise: Promise<unknown>): Promise<unknown> {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve('HUNG'), 100))
  ])
}

describe('tokenizerPool', () => {
  beforeEach(async () => {
    resetTokenizerPoolForTests()
    FakeWorker.instances.length = 0
    FakeWorker.autoReply = true
    const actual = await fsActual
    existsSyncMock.mockImplementation((path) => actual.existsSync(path))
  })

  afterEach(() => {
    resetTokenizerPoolForTests()
    existsSyncMock.mockReset()
    vi.useRealTimers()
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

  it('retires a worker that exits with nothing in flight, so the next batch still settles', async () => {
    existsSyncMock.mockImplementation(() => true)

    expect(await encodeCountsInWorker([ITEM])).toEqual([1])
    const [first] = FakeWorker.instances
    expect(first).toBeDefined()

    // Exit with an empty pending map: the pool used to return early here and keep
    // the dead slot, and every later batch routed to it hung forever.
    first!.dead = true
    first!.emit('exit', 0)

    expect(await withinTick(encodeCountsInWorker([ITEM]))).toEqual([1])
  })

  it('bounds a batch a worker never answers, instead of waiting forever', async () => {
    existsSyncMock.mockImplementation(() => true)
    FakeWorker.autoReply = false
    vi.useFakeTimers()

    const pending = encodeCountsInWorker([ITEM])
    const settled = vi.waitFor(() => expect(FakeWorker.instances.length).toBeGreaterThan(0))
    await vi.advanceTimersByTimeAsync(0)
    await settled

    const rejected = expect(pending).rejects.toThrow(/did not answer/)
    await vi.advanceTimersByTimeAsync(30_000)
    await rejected

    // The wedged worker left the pool, so the next batch is not queued behind it.
    FakeWorker.autoReply = true
    vi.useRealTimers()
    expect(await withinTick(encodeCountsInWorker([ITEM]))).toEqual([1])
  })
})
