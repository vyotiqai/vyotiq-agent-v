import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EmbedUtilityClient,
  resetEmbedUtilityClientForTests,
  type EmbedUtilityClientOptions
} from '@main/agent/codeindex/embedUtilityClient'
import { createLocalHashEmbedder } from '@main/agent/codeindex/embed'
import { LIGHTON_DENSE_DIM } from '@main/agent/codeindex/types'
import * as processPriority from '@main/agent/processPriority'

type UtilityChild = NonNullable<EmbedUtilityClientOptions['forkImpl']> extends (
  script: string
) => infer R
  ? R
  : never

class FakeUtilityChild extends EventEmitter {
  pid = 4242
  killed = false
  messages: unknown[] = []
  /** When set, embed waits until this promise resolves (tests mid-batch cancel). */
  embedGate: Promise<void> | null = null
  /** Ops accepted but never auto-replied (hang / timeout tests). */
  holdOps = new Set<string>()
  heldMessages: Array<{ id: number; op: string }> = []

  postMessage(message: unknown): void {
    this.messages.push(message)
    const msg = message as {
      id: number
      op: string
      texts?: string[]
      modelId?: string
      targetId?: number
      workspaceRoot?: string
      dbPath?: string
      dimensions?: number
    }
    if (this.holdOps.has(msg.op)) {
      this.heldMessages.push({ id: msg.id, op: msg.op })
      return
    }
    queueMicrotask(() => {
      void (async () => {
        if (msg.op === 'dispose') {
          this.emit('message', { id: msg.id, ok: true })
          return
        }
        if (msg.op === 'ping') {
          this.emit('message', {
            id: msg.id,
            ok: true,
            rssMb: 12,
            heapUsedMb: 8,
            sessionLoaded: true
          })
          return
        }
        if (msg.op === 'ensure') {
          this.emit('message', {
            id: msg.id,
            ok: true,
            modelId: msg.modelId ?? 'mock-model',
            dimensions: LIGHTON_DENSE_DIM
          })
          return
        }
        if (msg.op === 'embed') {
          if (this.embedGate) await this.embedGate
          const embeddings = (msg.texts ?? []).map(() => {
            const v = new Float32Array(LIGHTON_DENSE_DIM)
            v[0] = 1
            return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)
          })
          this.emit('message', { id: msg.id, ok: true, embeddings })
          return
        }
        if (msg.op === 'syncCode') {
          this.emit('message', {
            id: msg.id,
            ok: true,
            sync: {
              scanned: 1,
              indexed: 1,
              skipped: 0,
              removed: 0,
              status: {
                ready: true,
                modelId: msg.modelId ?? 'hash',
                fileCount: 1,
                chunkCount: 1,
                lastIndexedAt: new Date().toISOString()
              },
              partial: false,
              syncComplete: true,
              cursor: null
            }
          })
          return
        }
        if (msg.op === 'syncSparse') {
          this.emit('message', {
            id: msg.id,
            ok: true,
            sync: {
              scanned: 1,
              indexed: 1,
              skipped: 0,
              removed: 0,
              partial: false,
              syncComplete: true,
              cursor: null
            }
          })
          return
        }
        if (msg.op === 'searchCode') {
          this.emit('message', {
            id: msg.id,
            ok: true,
            hits: [
              {
                path: 'src/a.ts',
                startLine: 1,
                endLine: 2,
                kind: 'function',
                name: 'alpha',
                parentName: null,
                score: 1,
                snippet: 'export function alpha() {}'
              }
            ],
            status: {
              ready: true,
              modelId: msg.modelId ?? 'hash',
              fileCount: 1,
              chunkCount: 1,
              lastIndexedAt: null
            }
          })
          return
        }
        if (msg.op === 'sparseLookup') {
          this.emit('message', {
            id: msg.id,
            ok: true,
            sparse: {
              kind: 'lookup',
              lookup: { ok: true, paths: ['src/a.ts'], mode: 'trigram' },
              fileCount: 1,
              syncComplete: true
            }
          })
          return
        }
        if (msg.op === 'sparseListFiles') {
          this.emit('message', {
            id: msg.id,
            ok: true,
            sparse: {
              kind: 'list',
              ready: true,
              paths: ['src/a.ts', 'src/b.ts'],
              fileCount: 2,
              syncComplete: true
            }
          })
          return
        }
        if (msg.op === 'cancel' || msg.op === 'dispose' || msg.op === 'ping') {
          this.emit('message', { id: msg.id, ok: true })
        }
      })()
    })
  }

  kill(): void {
    this.killed = true
    this.emit('exit', 0)
  }
}

describe('embedUtilityClient', () => {
  afterEach(() => {
    vi.useRealTimers()
    resetEmbedUtilityClientForTests()
  })

  it('gates on spawn and RPCs ensure/embed via mock utility', async () => {
    let child: FakeUtilityChild | null = null
    const client = new EmbedUtilityClient({
      forkImpl: () => {
        const c = new FakeUtilityChild()
        queueMicrotask(() => c.emit('spawn'))
        child = c
        return c as unknown as UtilityChild
      },
      scriptPath: '/virtual/embedUtility.js',
      timeoutMs: 5000
    })

    const session = await client.ensure({
      modelDir: '/models/x',
      modelId: 'test-model'
    })
    expect(session.modelId).toBe('test-model')
    expect(child).not.toBeNull()
    expect(child!.messages.some((m) => (m as { op: string }).op === 'ensure')).toBe(true)

    const vecs = await client.embed(['hello'], 'query')
    expect(vecs).toHaveLength(1)
    expect(vecs[0]!).toHaveLength(LIGHTON_DENSE_DIM)

    const ac = new AbortController()
    ac.abort()
    await expect(client.embed(['slow'], 'document', ac.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })

    await client.shutdown()
    expect(child!.killed).toBe(true)
  })

  it('does not lower utility child process priority after spawn', async () => {
    const spy = vi.spyOn(processPriority, 'lowerProcessPriority').mockReturnValue(true)
    try {
      const client = new EmbedUtilityClient({
        forkImpl: () => {
          const c = new FakeUtilityChild()
          queueMicrotask(() => c.emit('spawn'))
          return c as unknown as UtilityChild
        },
        scriptPath: '/virtual/embedUtility.js',
        timeoutMs: 5000
      })
      await client.ensure({
        modelDir: '/models/x',
        modelId: 'test-model'
      })
      expect(spy).not.toHaveBeenCalled()
      await client.shutdown()
    } finally {
      spy.mockRestore()
    }
  })

  it('sends cancel to utility when AbortSignal fires mid-embed', async () => {
    let releaseEmbed!: () => void
    const gate = new Promise<void>((r) => {
      releaseEmbed = r
    })
    let child: FakeUtilityChild | null = null
    const client = new EmbedUtilityClient({
      forkImpl: () => {
        const c = new FakeUtilityChild()
        c.embedGate = gate
        queueMicrotask(() => c.emit('spawn'))
        child = c
        return c as unknown as UtilityChild
      },
      scriptPath: '/virtual/embedUtility.js',
      timeoutMs: 5000
    })

    await client.ensure({ modelDir: '/models/x', modelId: 'test-model' })
    const ac = new AbortController()
    const pending = client.embed(['a', 'b', 'c'], 'document', ac.signal)
    await new Promise((r) => setImmediate(r))
    ac.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(child!.messages.some((m) => (m as { op: string }).op === 'cancel')).toBe(true)
    releaseEmbed()
    await client.shutdown()
  })

  it('RPCs syncCode / syncSparse', async () => {
    const client = new EmbedUtilityClient({
      forkImpl: () => {
        const c = new FakeUtilityChild()
        queueMicrotask(() => c.emit('spawn'))
        return c as unknown as UtilityChild
      },
      scriptPath: '/virtual/embedUtility.js',
      timeoutMs: 5000
    })

    const code = await client.syncCode({
      workspaceRoot: '/ws',
      dbPath: '/ws/index.sqlite',
      dimensions: 8,
      modelId: 'local-hash-v1',
      embedderKind: 'hash'
    })
    expect(code.indexed).toBe(1)

    const sparse = await client.syncSparse({
      workspaceRoot: '/ws',
      dbPath: '/ws/sparse.sqlite'
    })
    expect(sparse.syncComplete).toBe(true)
    await client.shutdown()
  })

  it('RPCs searchCode / sparseLookup / sparseListFiles', async () => {
    const client = new EmbedUtilityClient({
      forkImpl: () => {
        const c = new FakeUtilityChild()
        queueMicrotask(() => c.emit('spawn'))
        return c as unknown as UtilityChild
      },
      scriptPath: '/virtual/embedUtility.js',
      timeoutMs: 5000
    })

    const search = await client.searchCode({
      workspaceRoot: '/ws',
      dbPath: '/ws/index.sqlite',
      dimensions: 8,
      modelId: 'local-hash-v1',
      embedderKind: 'hash',
      query: 'alpha'
    })
    expect(search.hits).toHaveLength(1)
    expect(search.status.ready).toBe(true)

    const lookup = await client.sparseLookup({
      dbPath: '/ws/sparse.sqlite',
      query: 'alpha',
      kind: 'substring'
    })
    expect(lookup.lookup.ok).toBe(true)

    const list = await client.sparseListFiles({ dbPath: '/ws/sparse.sqlite' })
    expect(list.paths).toEqual(['src/a.ts', 'src/b.ts'])
    await client.shutdown()
  })

  it('retries spawn once after failure then succeeds', async () => {
    let attempts = 0
    const client = new EmbedUtilityClient({
      forkImpl: () => {
        attempts++
        const c = new FakeUtilityChild()
        if (attempts === 1) {
          queueMicrotask(() => c.emit('error', new Error('spawn boom')))
        } else {
          queueMicrotask(() => c.emit('spawn'))
        }
        return c as unknown as UtilityChild
      },
      scriptPath: '/virtual/embedUtility.js',
      timeoutMs: 5000
    })

    await client.ensure({ modelDir: '/models/x', modelId: 'test-model' })
    expect(attempts).toBe(2)
    await client.shutdown()
  })

  it('surfaces spawn failure after retry exhausted', async () => {
    const client = new EmbedUtilityClient({
      forkImpl: () => {
        const c = new FakeUtilityChild()
        queueMicrotask(() => c.emit('error', new Error('spawn always fails')))
        return c as unknown as UtilityChild
      },
      scriptPath: '/virtual/embedUtility.js',
      timeoutMs: 5000
    })

    await expect(client.ensure({ modelDir: '/models/x', modelId: 'm' })).rejects.toThrow(
      /spawn always fails/
    )
  })

  it('re-ensures after utility exit so later embeds succeed', async () => {
    let child: FakeUtilityChild | null = null
    let generation = 0
    const client = new EmbedUtilityClient({
      forkImpl: () => {
        generation++
        const c = new FakeUtilityChild()
        queueMicrotask(() => c.emit('spawn'))
        child = c
        return c as unknown as UtilityChild
      },
      scriptPath: '/virtual/embedUtility.js',
      timeoutMs: 5000
    })

    await client.ensure({ modelDir: '/models/x', modelId: 'test-model' })
    expect(generation).toBe(1)

    // Simulate unexpected child death.
    child!.emit('exit', 1)
    await new Promise((r) => setImmediate(r))

    const vecs = await client.embed(['hello'], 'document')
    expect(vecs).toHaveLength(1)
    expect(generation).toBe(2)
    const ensureOps = child!.messages.filter((m) => (m as { op: string }).op === 'ensure')
    expect(ensureOps.length).toBeGreaterThanOrEqual(1)
    await client.shutdown()
  })

  it('refreshes syncCode idle timeout on progress heartbeats', async () => {
    let child: FakeUtilityChild | null = null
    const client = new EmbedUtilityClient({
      forkImpl: () => {
        const c = new FakeUtilityChild()
        c.on('message-request', (message: unknown) => {
          const msg = message as { id: number; op: string }
          if (msg.op !== 'syncCode') return
          // Hold the response; only progress events keep the idle timer alive.
          void (async () => {
            for (let i = 0; i < 4; i++) {
              await new Promise((r) => setTimeout(r, 80))
              c.emit('message', {
                type: 'indexProgress',
                requestId: msg.id,
                indexProgress: {
                  kind: 'code',
                  stage: 'scanning',
                  filesDone: i + 1,
                  filesTotal: 4,
                  indexed: 0,
                  skipped: i + 1,
                  removed: 0,
                  embedChunks: 0,
                  currentPath: `f${i}.ts`
                },
                progress: (i + 1) / 4,
                message: 'scanning'
              })
            }
            await new Promise((r) => setTimeout(r, 40))
            c.emit('message', {
              id: msg.id,
              ok: true,
              sync: {
                scanned: 4,
                indexed: 0,
                skipped: 4,
                removed: 0,
                status: {
                  ready: true,
                  modelId: 'hash',
                  fileCount: 4,
                  chunkCount: 0,
                  lastIndexedAt: new Date().toISOString()
                }
              }
            })
          })()
        })
        // Override default syncCode auto-reply by intercepting postMessage.
        const orig = c.postMessage.bind(c)
        c.postMessage = (message: unknown) => {
          c.messages.push(message)
          const msg = message as { id: number; op: string }
          if (msg.op === 'ensure') {
            queueMicrotask(() =>
              c.emit('message', {
                id: msg.id,
                ok: true,
                modelId: 'test-model',
                dimensions: LIGHTON_DENSE_DIM
              })
            )
            return
          }
          if (msg.op === 'syncCode') {
            c.emit('message-request', message)
            return
          }
          if (msg.op === 'cancel') {
            queueMicrotask(() => c.emit('message', { id: msg.id, ok: true }))
            return
          }
          orig(message)
        }
        queueMicrotask(() => c.emit('spawn'))
        child = c
        return c as unknown as UtilityChild
      },
      scriptPath: '/virtual/embedUtility.js',
      timeoutMs: 120,
      syncIdleTimeoutMs: 120
    })

    await client.ensure({ modelDir: '/models/x', modelId: 'test-model' })
    const sync = await client.syncCode({
      workspaceRoot: '/ws',
      dbPath: '/ws/index.sqlite',
      dimensions: 8,
      modelId: 'local-hash-v1',
      embedderKind: 'hash'
    })
    expect(sync.skipped).toBe(4)
    expect(child!.killed).toBe(false)
    await client.shutdown()
  })

  it('kills utility child when syncCode idles past timeout', async () => {
    let child: FakeUtilityChild | null = null
    const client = new EmbedUtilityClient({
      forkImpl: () => {
        const c = new FakeUtilityChild()
        const orig = c.postMessage.bind(c)
        c.postMessage = (message: unknown) => {
          c.messages.push(message)
          const msg = message as { id: number; op: string }
          if (msg.op === 'ensure') {
            queueMicrotask(() =>
              c.emit('message', {
                id: msg.id,
                ok: true,
                modelId: 'test-model',
                dimensions: LIGHTON_DENSE_DIM
              })
            )
            return
          }
          if (msg.op === 'syncCode') {
            // Never reply — simulate a hung ONNX sync.
            return
          }
          if (msg.op === 'cancel') {
            queueMicrotask(() => c.emit('message', { id: msg.id, ok: true }))
            return
          }
          orig(message)
        }
        queueMicrotask(() => c.emit('spawn'))
        child = c
        return c as unknown as UtilityChild
      },
      scriptPath: '/virtual/embedUtility.js',
      timeoutMs: 80,
      syncIdleTimeoutMs: 80
    })

    await client.ensure({ modelDir: '/models/x', modelId: 'test-model' })
    await expect(
      client.syncCode({
        workspaceRoot: '/ws',
        dbPath: '/ws/index.sqlite',
        dimensions: 8,
        modelId: 'local-hash-v1',
        embedderKind: 'hash'
      })
    ).rejects.toThrow(/Embed utility timeout \(syncCode\)/)
    expect(child!.killed).toBe(true)
    await client.shutdown()
  })

  it('kills the child when progress keeps a sync alive past the absolute deadline', async () => {
    let child: FakeUtilityChild | null = null
    const client = new EmbedUtilityClient({
      forkImpl: () => {
        const c = new FakeUtilityChild()
        c.on('message-request', (message: unknown) => {
          const msg = message as { id: number; op: string }
          if (msg.op !== 'syncCode') return
          void (async () => {
            // Heartbeats keep the idle timer alive forever; the absolute
            // deadline must still fail the RPC and kill the wedged child.
            for (let i = 0; i < 8; i++) {
              await new Promise((r) => setTimeout(r, 40))
              c.emit('message', {
                type: 'indexProgress',
                requestId: msg.id,
                indexProgress: {
                  kind: 'code',
                  stage: 'scanning',
                  filesDone: i + 1,
                  filesTotal: 8,
                  indexed: 0,
                  skipped: i + 1,
                  removed: 0,
                  embedChunks: 0,
                  currentPath: `f${i}.ts`
                },
                progress: (i + 1) / 8,
                message: 'scanning'
              })
            }
          })()
        })
        const orig = c.postMessage.bind(c)
        c.postMessage = (message: unknown) => {
          c.messages.push(message)
          const msg = message as { id: number; op: string }
          if (msg.op === 'ensure') {
            queueMicrotask(() =>
              c.emit('message', {
                id: msg.id,
                ok: true,
                modelId: 'test-model',
                dimensions: LIGHTON_DENSE_DIM
              })
            )
            return
          }
          if (msg.op === 'syncCode') {
            c.emit('message-request', message)
            return
          }
          if (msg.op === 'cancel') {
            queueMicrotask(() => c.emit('message', { id: msg.id, ok: true }))
            return
          }
          orig(message)
        }
        queueMicrotask(() => c.emit('spawn'))
        child = c
        return c as unknown as UtilityChild
      },
      scriptPath: '/virtual/embedUtility.js',
      timeoutMs: 5_000,
      syncIdleTimeoutMs: 5_000,
      absoluteTimeoutMs: 100
    })

    await client.ensure({ modelDir: '/models/x', modelId: 'test-model' })
    await expect(
      client.syncCode({
        workspaceRoot: '/ws',
        dbPath: '/ws/index.sqlite',
        dimensions: 8,
        modelId: 'local-hash-v1',
        embedderKind: 'hash'
      })
    ).rejects.toThrow(/exceeded max duration \(syncCode\)/)
    expect(child!.killed).toBe(true)
    await client.shutdown()
  })

  it('does not refresh the idle timeout on non-advancing progress heartbeats', async () => {
    let child: FakeUtilityChild | null = null
    const client = new EmbedUtilityClient({
      forkImpl: () => {
        const c = new FakeUtilityChild()
        c.on('message-request', (message: unknown) => {
          const msg = message as { id: number; op: string }
          if (msg.op !== 'syncCode') return
          void (async () => {
            // Identical counters every heartbeat — the wedge signature.
            for (let i = 0; i < 10; i++) {
              await new Promise((r) => setTimeout(r, 40))
              c.emit('message', {
                type: 'indexProgress',
                requestId: msg.id,
                indexProgress: {
                  kind: 'code',
                  stage: 'scanning',
                  filesDone: 1,
                  filesTotal: 1,
                  indexed: 0,
                  skipped: 1,
                  removed: 0,
                  embedChunks: 0,
                  currentPath: 'same.ts'
                },
                progress: 0.5,
                message: 'scanning'
              })
            }
          })()
        })
        const orig = c.postMessage.bind(c)
        c.postMessage = (message: unknown) => {
          c.messages.push(message)
          const msg = message as { id: number; op: string }
          if (msg.op === 'ensure') {
            queueMicrotask(() =>
              c.emit('message', {
                id: msg.id,
                ok: true,
                modelId: 'test-model',
                dimensions: LIGHTON_DENSE_DIM
              })
            )
            return
          }
          if (msg.op === 'syncCode') {
            c.emit('message-request', message)
            return
          }
          if (msg.op === 'cancel') {
            queueMicrotask(() => c.emit('message', { id: msg.id, ok: true }))
            return
          }
          orig(message)
        }
        queueMicrotask(() => c.emit('spawn'))
        child = c
        return c as unknown as UtilityChild
      },
      scriptPath: '/virtual/embedUtility.js',
      timeoutMs: 120,
      syncIdleTimeoutMs: 120
    })

    await client.ensure({ modelDir: '/models/x', modelId: 'test-model' })
    await expect(
      client.syncCode({
        workspaceRoot: '/ws',
        dbPath: '/ws/index.sqlite',
        dimensions: 8,
        modelId: 'local-hash-v1',
        embedderKind: 'hash'
      })
    ).rejects.toThrow(/Embed utility timeout \(syncCode\)/)
    expect(child!.killed).toBe(true)
    await client.shutdown()
  })

  it('idle-unloads the utility child after idleUnloadMs while keeping lastEnsure', async () => {
    vi.useFakeTimers()
    let child: FakeUtilityChild | null = null
    const client = new EmbedUtilityClient({
      forkImpl: () => {
        const c = new FakeUtilityChild()
        queueMicrotask(() => c.emit('spawn'))
        child = c
        return c as unknown as UtilityChild
      },
      scriptPath: '/virtual/embedUtility.js',
      timeoutMs: 5_000,
      idleUnloadMs: 50
    })

    await client.ensure({ modelDir: '/models/x', modelId: 'test-model' })
    expect(client.getPerfStats().sessionLoaded).toBe(true)
    expect(child).not.toBeNull()

    await vi.advanceTimersByTimeAsync(60)
    // Allow the idleUnload promise microtasks to settle.
    await Promise.resolve()
    await Promise.resolve()

    expect(client.getPerfStats().sessionLoaded).toBe(false)
    expect(child!.killed).toBe(true)

    // Next ensure re-spawns via lastEnsure path on embed/sync ops.
    const session = await client.ensure({ modelDir: '/models/x', modelId: 'test-model' })
    expect(session.modelId).toBe('test-model')
    expect(client.getPerfStats().sessionLoaded).toBe(true)

    await client.shutdown()
    vi.useRealTimers()
  })

  it('idle-unloads even while a stuck health ping is in flight', async () => {
    vi.useFakeTimers()
    let child: FakeUtilityChild | null = null
    const client = new EmbedUtilityClient({
      forkImpl: () => {
        const c = new FakeUtilityChild()
        // A wedged child never answers pings; the probe must not pin it alive.
        c.holdOps.add('ping')
        queueMicrotask(() => c.emit('spawn'))
        child = c
        return c as unknown as UtilityChild
      },
      scriptPath: '/virtual/embedUtility.js',
      timeoutMs: 5_000,
      idleUnloadMs: 50
    })

    await client.ensure({ modelDir: '/models/x', modelId: 'test-model' })
    const stuckPing = client.refreshPerfStats().catch(() => undefined)

    await vi.advanceTimersByTimeAsync(60)
    await Promise.resolve()
    await Promise.resolve()

    expect(child!.killed).toBe(true)
    await stuckPing
    await client.shutdown()
    vi.useRealTimers()
  })

  it('hash searchCode does not re-ensure after a failed ONNX load', async () => {
    let ensureCount = 0
    const client = new EmbedUtilityClient({
      forkImpl: () => {
        const c = new FakeUtilityChild()
        const orig = c.postMessage.bind(c)
        c.postMessage = (message: unknown) => {
          const msg = message as { id: number; op: string }
          if (msg.op === 'ensure') {
            ensureCount++
            c.messages.push(message)
            queueMicrotask(() =>
              c.emit('message', { id: msg.id, ok: false, error: 'ORT failed' })
            )
            return
          }
          orig(message)
        }
        queueMicrotask(() => c.emit('spawn'))
        return c as unknown as UtilityChild
      },
      scriptPath: '/virtual/embedUtility.js',
      timeoutMs: 5000
    })

    await expect(client.ensure({ modelDir: '/models/x', modelId: 'neural' })).rejects.toThrow(
      /ORT failed/
    )
    expect(ensureCount).toBe(1)

    const search = await client.searchCode({
      workspaceRoot: '/ws',
      dbPath: '/ws/index.sqlite',
      dimensions: 8,
      modelId: 'local-hash-v1',
      embedderKind: 'hash',
      query: 'alpha'
    })
    expect(search.hits).toHaveLength(1)
    expect(ensureCount).toBe(1)
    await client.shutdown()
  })

  it('hash searchCode skips re-ensure after a successful ONNX session is lost', async () => {
    let ensureCount = 0
    let child: FakeUtilityChild | null = null
    const client = new EmbedUtilityClient({
      forkImpl: () => {
        const c = new FakeUtilityChild()
        const orig = c.postMessage.bind(c)
        c.postMessage = (message: unknown) => {
          const msg = message as { id: number; op: string }
          if (msg.op === 'ensure') {
            ensureCount++
          }
          orig(message)
        }
        queueMicrotask(() => c.emit('spawn'))
        child = c
        return c as unknown as UtilityChild
      },
      scriptPath: '/virtual/embedUtility.js',
      timeoutMs: 5000
    })

    await client.ensure({ modelDir: '/models/x', modelId: 'neural' })
    expect(ensureCount).toBe(1)
    child!.emit('exit', 1)
    await new Promise((r) => setImmediate(r))

    const search = await client.searchCode({
      workspaceRoot: '/ws',
      dbPath: '/ws/index.sqlite',
      dimensions: 8,
      modelId: 'local-hash-v1',
      embedderKind: 'hash',
      query: 'alpha'
    })
    expect(search.hits).toHaveLength(1)
    expect(ensureCount).toBe(1)
    await client.shutdown()
  })

  it('kills the utility child when searchCode times out even with syncCode in-flight', async () => {
    vi.useFakeTimers()
    let child: FakeUtilityChild | null = null
    const client = new EmbedUtilityClient({
      forkImpl: () => {
        const c = new FakeUtilityChild()
        c.holdOps.add('syncCode')
        c.holdOps.add('searchCode')
        queueMicrotask(() => c.emit('spawn'))
        child = c
        return c as unknown as UtilityChild
      },
      scriptPath: '/virtual/embedUtility.js',
      timeoutMs: 5_000,
      syncIdleTimeoutMs: 600_000,
      idleUnloadMs: 0
    })

    await client.ensure({ modelDir: '/models/x', modelId: 'test-model' })

    const syncP = client.syncCode({
      workspaceRoot: '/ws',
      dbPath: '/ws/index.sqlite',
      dimensions: 8,
      modelId: 'local-hash-v1',
      embedderKind: 'hash'
    })
    const searchP = client.searchCode({
      workspaceRoot: '/ws',
      dbPath: '/ws/index.sqlite',
      dimensions: 8,
      modelId: 'local-hash-v1',
      embedderKind: 'hash',
      query: 'alpha'
    })
    const searchExpect = expect(searchP).rejects.toThrow(/Embed utility timeout \(searchCode\)/)
    const syncExpect = expect(syncP).rejects.toThrow(/Embed utility exited/)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(child!.heldMessages.some((m) => m.op === 'syncCode')).toBe(true)
    expect(child!.heldMessages.some((m) => m.op === 'searchCode')).toBe(true)

    // searchCode uses max(timeoutMs, 180s); sync idle is 600s — only search times out.
    await vi.advanceTimersByTimeAsync(180_000)
    await searchExpect
    // A timed-out RPC means the native session is unusable; kill it so the
    // overlapping sync is rejected and its queue retries on a fresh child.
    expect(child!.killed).toBe(true)
    await syncExpect
    await client.shutdown()
    vi.useRealTimers()
  })

  it('kills utility child when searchCode times out as the only in-flight RPC', async () => {
    // Uniform policy: any timed-out RPC kills the child.
    vi.useFakeTimers()
    let child: FakeUtilityChild | null = null
    const client = new EmbedUtilityClient({
      forkImpl: () => {
        const c = new FakeUtilityChild()
        c.holdOps.add('searchCode')
        queueMicrotask(() => c.emit('spawn'))
        child = c
        return c as unknown as UtilityChild
      },
      scriptPath: '/virtual/embedUtility.js',
      timeoutMs: 5_000,
      idleUnloadMs: 0
    })

    await client.ensure({ modelDir: '/models/x', modelId: 'test-model' })
    const searchP = client.searchCode({
      workspaceRoot: '/ws',
      dbPath: '/ws/index.sqlite',
      dimensions: 8,
      modelId: 'local-hash-v1',
      embedderKind: 'hash',
      query: 'alpha'
    })
    const searchExpect = expect(searchP).rejects.toThrow(/Embed utility timeout \(searchCode\)/)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(child!.heldMessages.some((m) => m.op === 'searchCode')).toBe(true)

    await vi.advanceTimersByTimeAsync(180_000)
    await searchExpect
    expect(child!.killed).toBe(true)
    await client.shutdown()
    vi.useRealTimers()
  })
})

describe('hash embedder abort', () => {
  it('rejects when signal is already aborted', async () => {
    const embedder = createLocalHashEmbedder(8)
    const ac = new AbortController()
    ac.abort()
    await expect(embedder.embed(['a', 'b', 'c'], { signal: ac.signal })).rejects.toMatchObject({
      name: 'AbortError'
    })
  })
})
