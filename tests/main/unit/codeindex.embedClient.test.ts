import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EmbedUtilityClient,
  resetEmbedUtilityClientForTests
} from '@main/agent/codeindex/embed/embedUtilityClient'

function float32Base64(values: readonly number[]): string {
  const arr = new Float32Array(values)
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64')
}

type FakeChild = EventEmitter & {
  pid: number
  messages: unknown[]
  postMessage: (message: unknown) => void
  kill: ReturnType<typeof vi.fn>
}

function makeFork(opts?: {
  onPost?: (child: FakeChild, message: { id: number; op: string; texts?: string[] }) => void
}): { children: FakeChild[]; fork: (script: string) => FakeChild } {
  const children: FakeChild[] = []
  const fork = (script: string): FakeChild => {
    expect(script.endsWith('embedUtility.js')).toBe(true)
    const child = new EventEmitter() as FakeChild
    child.pid = 4242
    child.messages = []
    child.kill = vi.fn(() => {
      child.emit('exit', 0)
    })
    child.postMessage = (message: unknown): void => {
      // Utility protocol is JSON-safe: postMessage clones strip class identity.
      child.messages.push(JSON.parse(JSON.stringify(message)))
      const msg = message as { id: number; op: string; texts?: string[] }
      if (opts?.onPost) {
        opts.onPost(child, msg)
        return
      }
      const canned =
        msg.op === 'embed'
          ? { id: msg.id, ok: true, vecs: (msg.texts ?? []).map(() => float32Base64([0.25, -0.5, 0])) }
          : { id: msg.id, ok: true }
      queueMicrotask(() => {
        child.emit('message', canned)
      })
    }
    children.push(child)
    queueMicrotask(() => {
      child.emit('spawn')
    })
    return child
  }
  return { children, fork }
}

describe('EmbedUtilityClient', () => {
  afterEach(() => {
    resetEmbedUtilityClientForTests()
  })

  it('ensure + embed round-trip: wire shape is JSON-safe, vectors decode exactly', async () => {
    const { fork, children } = makeFork()
    const client = new EmbedUtilityClient({ forkImpl: fork })

    await expect(client.ensure('C:/models/x')).resolves.toBeUndefined()
    const vecs = await client.embed(['alpha', 'beta'])
    expect(vecs).toHaveLength(2)
    for (const vec of vecs) {
      expect(vec).toBeInstanceOf(Float32Array)
      expect(vec.length).toBe(3)
      expect(vec[0]).toBeCloseTo(0.25)
      expect(vec[1]).toBeCloseTo(-0.5)
      expect(vec[2]).toBe(0)
    }

    const first = children[0]!.messages[0]! as { op: string; modelDir?: string }
    const second = children[0]!.messages[1]! as { op: string; texts?: string[] }
    expect(first).toEqual({ id: 1, op: 'ensure', modelDir: 'C:/models/x' })
    expect(second).toEqual({ id: 2, op: 'embed', texts: ['alpha', 'beta'] })
  })

  it('rejects on a vector count mismatch', async () => {
    const { fork } = makeFork({
      onPost: (child, msg) => {
        const res =
          msg.op === 'embed'
            ? { id: msg.id, ok: true, vecs: [float32Base64([1])] }
            : { id: msg.id, ok: true }
        queueMicrotask(() => child.emit('message', res))
      }
    })
    const client = new EmbedUtilityClient({ forkImpl: fork })
    await expect(client.embed(['a', 'b'])).rejects.toThrow(/count mismatch/)
  })

  it('propagates worker errors verbatim', async () => {
    const { fork } = makeFork({
      onPost: (child, msg) => {
        queueMicrotask(() => child.emit('message', { id: msg.id, ok: false, error: 'Embedding session not loaded — call ensure first' }))
      }
    })
    const client = new EmbedUtilityClient({ forkImpl: fork })
    await expect(client.ensure('x')).rejects.toThrow(/call ensure first/)
  })

  it('times out a silent worker', async () => {
    const { fork } = makeFork({
      onPost: () => {
        /* never responds */
      }
    })
    const client = new EmbedUtilityClient({ forkImpl: fork, timeoutMs: 30 })
    await expect(client.ensure('x')).rejects.toThrow(/timeout \(ensure\)/)
  })

  it('aborts: pending request rejected and the shared worker torn down when idle', async () => {
    const { fork, children } = makeFork({
      onPost: () => {
        /* never responds */
      }
    })
    const client = new EmbedUtilityClient({ forkImpl: fork })
    const ac = new AbortController()
    const promise = client.embed(['a'], ac.signal)
    queueMicrotask(() => ac.abort())
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    // Last pending request was aborted: the client must free the worker.
    await vi.waitFor(() => {
      expect(children[0]!.kill).toHaveBeenCalled()
    })
  })

  it('rejects pending requests when the worker exits mid-flight', async () => {
    const { fork, children } = makeFork({
      onPost: () => {
        /* hold */
      }
    })
    const client = new EmbedUtilityClient({ forkImpl: fork })
    const promise = client.ensure('x')
    // Let the spawn settle first (mirrors real exit timing), then kill.
    await new Promise((r) => setTimeout(r, 20))
    children[0]!.emit('exit', 1)
    await expect(promise).rejects.toThrow(/Embedding worker exited/)
  })

  it('idle self-dispose frees the worker after a quiet stretch; new work cancels the timer', async () => {
    vi.useFakeTimers()
    try {
      const { fork, children } = makeFork()
      const client = new EmbedUtilityClient({ forkImpl: fork, idleMs: 120_000 })
      await client.embed(['a'])
      // Before the idle window elapses the worker stays alive.
      await vi.advanceTimersByTimeAsync(119_000)
      expect(children[0]!.kill).not.toHaveBeenCalled()
      await client.embed(['b'])
      await vi.advanceTimersByTimeAsync(1_000)
      expect(children[0]!.kill).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(children[0]!.kill).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})