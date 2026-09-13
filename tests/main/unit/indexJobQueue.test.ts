import { afterEach, describe, expect, it } from 'vitest'
import {
  enqueueIndexJob,
  resetIndexJobQueueForTests,
  indexJobQueuePendingCountForTests,
  IndexQueueFullError,
  INDEX_JOB_QUEUE_MAX_PENDING,
  activeIndexJobPreemptSignal,
  dropPendingByCoalesceKey
} from '@main/agent/indexJobQueue'

describe('indexJobQueue', () => {
  afterEach(async () => {
    // Drain any leftover work quietly before reset.
    for (let i = 0; i < 80 && indexJobQueuePendingCountForTests() > 0; i++) {
      await new Promise((r) => setImmediate(r))
    }
    resetIndexJobQueueForTests()
  })

  it('runs jobs with concurrency 1 (serialized)', async () => {
    const order: string[] = []
    let releaseA!: () => void
    const gateA = new Promise<void>((r) => {
      releaseA = r
    })

    const p1 = enqueueIndexJob({
      priority: 'warm',
      run: async () => {
        order.push('a-start')
        await gateA
        order.push('a-end')
        return 1
      }
    })
    const p2 = enqueueIndexJob({
      priority: 'warm',
      run: async () => {
        order.push('b')
        return 2
      }
    })

    await Promise.resolve()
    expect(order).toEqual(['a-start'])
    expect(indexJobQueuePendingCountForTests()).toBe(1)

    releaseA()
    await expect(p1).resolves.toBe(1)
    await expect(p2).resolves.toBe(2)
    expect(order).toEqual(['a-start', 'a-end', 'b'])
  })

  it('preempts in-flight warm so interactive runs before warm finishes', async () => {
    const order: string[] = []
    let warmStarted!: () => void
    const warmStartedP = new Promise<void>((r) => {
      warmStarted = r
    })

    const warm = enqueueIndexJob({
      priority: 'warm',
      coalesceKey: 'warm:preempt',
      run: async () => {
        order.push('warm-start')
        warmStarted()
        const preempt = activeIndexJobPreemptSignal()
        await new Promise<void>((resolve, reject) => {
          if (!preempt) {
            reject(new Error('missing preempt signal'))
            return
          }
          if (preempt.aborted) {
            resolve()
            return
          }
          preempt.addEventListener('abort', () => resolve(), { once: true })
        })
        order.push('warm-aborted')
      }
    })
    await warmStartedP
    expect(order).toEqual(['warm-start'])

    const interactive = enqueueIndexJob({
      priority: 'interactive',
      run: async () => {
        order.push('interactive')
        return 'go'
      }
    })

    await expect(interactive).resolves.toBe('go')
    await warm
    // Drain re-queued warm copy.
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setImmediate(r))
    }
    expect(order[0]).toBe('warm-start')
    expect(order).toContain('interactive')
    expect(order).toContain('warm-aborted')
    // Preempt aborts the in-flight warm; interactive runs next (not after a full warm).
    expect(order.indexOf('warm-aborted')).toBeLessThan(order.indexOf('interactive'))
  })

  it('runs interactive ahead of queued warm', async () => {
    const order: string[] = []
    let releaseWarm!: () => void
    const gateWarm = new Promise<void>((r) => {
      releaseWarm = r
    })

    const warm = enqueueIndexJob({
      priority: 'warm',
      run: async () => {
        order.push('warm-start')
        const preempt = activeIndexJobPreemptSignal()
        await Promise.race([
          gateWarm,
          new Promise<void>((resolve) => {
            preempt?.addEventListener('abort', () => resolve(), { once: true })
          })
        ])
        order.push(preempt?.aborted ? 'warm-aborted' : 'warm-end')
      }
    })
    await Promise.resolve()
    expect(order).toEqual(['warm-start'])

    const interactive = enqueueIndexJob({
      priority: 'interactive',
      run: async () => {
        order.push('interactive')
      }
    })
    const warm2 = enqueueIndexJob({
      priority: 'warm',
      coalesceKey: 'warm:other',
      run: async () => {
        order.push('warm2')
      }
    })

    releaseWarm()
    await interactive
    await warm
    await warm2
    expect(order).toContain('interactive')
    expect(order.indexOf('interactive')).toBeLessThan(order.indexOf('warm2'))
  })

  it('coalesces duplicate warm keys into one promise', async () => {
    let runs = 0
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const blocker = enqueueIndexJob({
      priority: 'reindex',
      run: async () => {
        await gate
      }
    })
    const a = enqueueIndexJob({
      priority: 'warm',
      coalesceKey: 'warm:/ws',
      run: async () => {
        runs++
        return 'ok'
      }
    })
    const b = enqueueIndexJob({
      priority: 'warm',
      coalesceKey: 'warm:/ws',
      run: async () => {
        runs++
        return 'nope'
      }
    })

    expect(a).toBe(b)
    expect(indexJobQueuePendingCountForTests()).toBe(1)
    release()
    await blocker
    await expect(a).resolves.toBe('ok')
    expect(runs).toBe(1)
  })

  it('enqueues one trailing run when coalesce key is hit while in-flight', async () => {
    let runs = 0
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    let started!: () => void
    const startedP = new Promise<void>((r) => {
      started = r
    })

    const a = enqueueIndexJob({
      priority: 'warm',
      coalesceKey: 'warm:/ws-inflight',
      run: async () => {
        runs++
        started()
        await gate
        return 'first'
      }
    })
    await startedP

    const b = enqueueIndexJob({
      priority: 'warm',
      coalesceKey: 'warm:/ws-inflight',
      run: async () => {
        runs++
        return 'second'
      }
    })
    const c = enqueueIndexJob({
      priority: 'warm',
      coalesceKey: 'warm:/ws-inflight',
      run: async () => {
        runs++
        return 'third'
      }
    })

    expect(b).toBe(a)
    expect(c).toBe(a)
    expect(runs).toBe(1)

    release()
    await expect(a).resolves.toBe('first')
    for (let i = 0; i < 40; i++) {
      if (runs >= 2) break
      await new Promise((r) => setImmediate(r))
    }
    expect(runs).toBe(2)
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    expect(runs).toBe(2)
  })

  it('honors a second caller abort signal on a coalesced pending job', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const blocker = enqueueIndexJob({
      priority: 'reindex',
      run: async () => {
        await gate
      }
    })
    const shared = enqueueIndexJob({
      priority: 'warm',
      coalesceKey: 'warm:coalesce-abort',
      run: async () => 'should-not-run'
    })
    const ac = new AbortController()
    const joined = enqueueIndexJob({
      priority: 'warm',
      coalesceKey: 'warm:coalesce-abort',
      signal: ac.signal,
      run: async () => 'nope'
    })
    expect(joined).toBe(shared)
    ac.abort()
    await expect(shared).rejects.toMatchObject({ name: 'AbortError' })
    release()
    await blocker
  })

  it('upgrades coalesce priority when a higher-priority caller joins', async () => {
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const blocker = enqueueIndexJob({
      priority: 'interactive',
      run: async () => {
        order.push('blocker')
        await gate
      }
    })
    const warm = enqueueIndexJob({
      priority: 'warm',
      coalesceKey: 'upgrade:/ws',
      run: async () => {
        order.push('upgraded')
      }
    })
    // Another warm behind the coalesced key so we can observe ordering vs reindex.
    const trailingWarm = enqueueIndexJob({
      priority: 'warm',
      coalesceKey: 'warm:trailing',
      run: async () => {
        order.push('trailing-warm')
      }
    })
    const upgraded = enqueueIndexJob({
      priority: 'reindex',
      coalesceKey: 'upgrade:/ws',
      run: async () => {
        order.push('should-not-run')
      }
    })
    expect(upgraded).toBe(warm)
    release()
    await Promise.all([blocker, warm, trailingWarm])
    expect(order.indexOf('upgraded')).toBeLessThan(order.indexOf('trailing-warm'))
  })

  it('dropPendingByCoalesceKey removes a queued warm', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const blocker = enqueueIndexJob({
      priority: 'reindex',
      run: async () => {
        await gate
      }
    })
    let warmRan = false
    const warm = enqueueIndexJob({
      priority: 'warm',
      coalesceKey: 'warm:drop-me',
      run: async () => {
        warmRan = true
      }
    })
    expect(dropPendingByCoalesceKey('warm:drop-me')).toBe(true)
    await expect(warm).resolves.toBeUndefined()
    release()
    await blocker
    expect(warmRan).toBe(false)
  })

  it('rejects pending job when signal aborts before start', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const blocker = enqueueIndexJob({
      priority: 'reindex',
      run: async () => {
        await gate
      }
    })
    const ac = new AbortController()
    const pending = enqueueIndexJob({
      priority: 'interactive',
      signal: ac.signal,
      run: async () => 'should-not-run'
    })
    ac.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    release()
    await blocker
  })

  it('rejects warm under backpressure when queue is full', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })

    const blocker = enqueueIndexJob({
      priority: 'warm',
      run: async () => {
        await gate
      }
    })

    const fillers: Promise<unknown>[] = []
    for (let i = 0; i < INDEX_JOB_QUEUE_MAX_PENDING; i++) {
      fillers.push(
        enqueueIndexJob({
          priority: 'warm',
          coalesceKey: `warm:fill-${i}`,
          run: async () => i
        }).catch((err) => err)
      )
    }

    const overflow = enqueueIndexJob({
      priority: 'warm',
      coalesceKey: 'warm:overflow',
      run: async () => 'x'
    })
    const overflowResult = await overflow.then(
      (v) => ({ ok: true as const, v }),
      (err) => ({ ok: false as const, err })
    )
    expect(overflowResult.ok).toBe(false)
    if (!overflowResult.ok) {
      expect(overflowResult.err).toBeInstanceOf(IndexQueueFullError)
    }

    release()
    await blocker
    await Promise.all(fillers)
  })

  it('lets interactive displace a queued warm when full', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })

    const blocker = enqueueIndexJob({
      priority: 'reindex',
      run: async () => {
        await gate
      }
    })

    const warms: Promise<unknown>[] = []
    for (let i = 0; i < INDEX_JOB_QUEUE_MAX_PENDING; i++) {
      warms.push(
        enqueueIndexJob({
          priority: 'warm',
          coalesceKey: `warm:full-${i}`,
          run: async () => i
        }).catch((err) => err)
      )
    }

    const interactive = enqueueIndexJob({
      priority: 'interactive',
      run: async () => 'go'
    })

    release()
    await blocker
    await expect(interactive).resolves.toBe('go')
    await Promise.all(warms)
  })

  it('coalesced rejection does not become an unhandled rejection via finally cleanup', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const p = enqueueIndexJob({
        priority: 'warm',
        coalesceKey: 'warm:reject-finally',
        run: async () => {
          throw new Error('boom-coalesce')
        }
      })
      await expect(p).rejects.toThrow('boom-coalesce')
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
