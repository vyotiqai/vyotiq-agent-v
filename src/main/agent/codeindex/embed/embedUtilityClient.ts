/**
 * Main-process client for the embedding utilityProcess.
 * Do not run ORT / transformers on the Electron main loop.
 */
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { logger } from '../../../../shared/logger'
import { logErrorSummary } from '../../../../shared/utils/logPolicy'

type UtilityOp = 'ensure' | 'embed' | 'dispose' | 'ping'

type UtilityRequest = {
  id: number
  op: UtilityOp
  modelDir?: string
  texts?: string[]
}

type UtilityResponse = {
  id: number
  ok: boolean
  error?: string
  /** base64 Float32LE, one per input text, in input order. */
  vecs?: string[]
}

type Pending = {
  resolve: (msg: UtilityResponse) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type UtilityChild = {
  pid?: number
  postMessage: (message: unknown) => void
  kill: () => void
  on: (event: string, listener: (...args: unknown[]) => void) => void
  once: (event: string, listener: (...args: unknown[]) => void) => void
  stderr?: { on: (event: 'data', listener: (chunk: Buffer | string) => void) => void } | null
}

export type EmbedBackend = {
  ensure: (modelDir: string, signal?: AbortSignal) => Promise<void>
  embed: (texts: string[], signal?: AbortSignal) => Promise<Float32Array[]>
  dispose: () => Promise<void>
}

const DEFAULT_TIMEOUT_MS = 120_000
const SPAWN_TIMEOUT_MS = 15_000
const SPAWN_MAX_ATTEMPTS = 2
/** Free the model's RSS after this idle stretch — no polling, one timer. */
const DEFAULT_IDLE_MS = 120_000

function defaultScriptPath(): string {
  return join(__dirname, 'embedUtility.js')
}

function canUseUtilityProcess(): boolean {
  if (process.env.VITEST === 'true' || process.env.VITEST === '1') return false
  try {
    const electron = require('electron') as { utilityProcess?: { fork: Function } }
    return typeof electron.utilityProcess?.fork === 'function'
  } catch {
    return false
  }
}

function electronFork(script: string): UtilityChild {
  const { utilityProcess } = require('electron') as {
    utilityProcess: {
      fork: (
        modulePath: string,
        args?: string[],
        options?: { serviceName?: string; stdio?: string }
      ) => UtilityChild
    }
  }
  return utilityProcess.fork(script, [], {
    serviceName: 'vyotiq-codeindex-embed',
    stdio: 'pipe'
  })
}

function decodeVec(base64: string): Float32Array {
  const blob = Buffer.from(base64, 'base64')
  const vec = new Float32Array(blob.byteLength / 4)
  for (let i = 0; i < vec.length; i++) vec[i] = blob.readFloatLE(i * 4)
  return vec
}

export class EmbedUtilityClient implements EmbedBackend {
  private child: UtilityChild | null = null
  private spawned = false
  private spawnPromise: Promise<void> | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private generation = 0
  private readonly timeoutMs: number
  private readonly spawnTimeoutMs: number
  private readonly idleMs: number
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private readonly forkImpl: ((script: string) => UtilityChild) | null
  private readonly scriptPath: string

  constructor(opts?: {
    forkImpl?: (script: string) => UtilityChild
    scriptPath?: string
    timeoutMs?: number
    spawnTimeoutMs?: number
    /** 0 disables the idle self-dispose timer. */
    idleMs?: number
  }) {
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.spawnTimeoutMs = opts?.spawnTimeoutMs ?? SPAWN_TIMEOUT_MS
    this.idleMs = opts?.idleMs ?? DEFAULT_IDLE_MS
    this.forkImpl = opts?.forkImpl ?? null
    this.scriptPath = opts?.scriptPath ?? defaultScriptPath()
  }

  get isAvailable(): boolean {
    return this.forkImpl != null || canUseUtilityProcess()
  }

  async ensure(modelDir: string, signal?: AbortSignal): Promise<void> {
    const res = await this.request({ op: 'ensure', modelDir }, this.timeoutMs, signal)
    if (!res.ok) throw new Error(res.error ?? 'Embedding worker failed to load model')
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const res = await this.request({ op: 'embed', texts }, this.timeoutMs, signal)
    if (!res.ok) throw new Error(res.error ?? 'Embedding worker failed')
    const vecs = res.vecs
    if (!Array.isArray(vecs) || vecs.length !== texts.length) {
      throw new Error('Embedding worker returned a vector count mismatch')
    }
    return vecs.map(decodeVec)
  }

  async dispose(): Promise<void> {
    try {
      await this.request({ op: 'dispose' }, 15_000)
    } catch {
      /* ignore */
    }
  }

  async shutdown(): Promise<void> {
    this.clearIdleTimer()
    this.generation++
    this.rejectAll(new Error('Embedding worker shut down'))
    const child = this.child
    this.child = null
    this.spawned = false
    this.spawnPromise = null
    try {
      child?.kill()
    } catch {
      /* ignore */
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer != null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  /** One-shot idle timer: freed RAM after a quiet stretch, no polling loop. */
  private scheduleIdleDispose(): void {
    this.clearIdleTimer()
    if (this.idleMs <= 0 || this.pending.size > 0) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      void this.shutdown()
    }, this.idleMs)
  }

  private rejectAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      this.pending.delete(id)
      p.reject(err)
    }
  }

  private clearChild(child: UtilityChild | null): void {
    if (!child) return
    try {
      child.kill()
    } catch {
      /* ignore */
    }
    if (this.child === child) {
      this.child = null
      this.spawned = false
    }
  }

  private async ensureSpawned(): Promise<UtilityChild> {
    if (this.child && this.spawned) return this.child
    if (this.spawnPromise) {
      await this.spawnPromise
      if (!this.child || !this.spawned) {
        throw new Error('Embedding worker failed to start')
      }
      return this.child
    }

    this.spawnPromise = (async () => {
      const gen = this.generation
      let lastErr: Error | null = null
      for (let attempt = 1; attempt <= SPAWN_MAX_ATTEMPTS; attempt++) {
        if (gen !== this.generation) {
          throw new Error('Embedding worker shut down during spawn')
        }
        try {
          await this.spawnOnce(gen)
          return
        } catch (err) {
          lastErr = err instanceof Error ? err : new Error(String(err))
          this.clearChild(this.child)
          if (attempt < SPAWN_MAX_ATTEMPTS) {
            await new Promise((r) => setTimeout(r, 50))
          }
        }
      }
      throw lastErr ?? new Error('Embedding worker failed to start')
    })()

    try {
      await this.spawnPromise
    } catch (err) {
      this.spawnPromise = null
      this.child = null
      this.spawned = false
      throw err
    }
    if (!this.child || !this.spawned) {
      throw new Error('Embedding worker failed to start')
    }
    return this.child
  }

  private async spawnOnce(gen: number): Promise<void> {
    const script = this.scriptPath
    if (!this.forkImpl && !existsSync(script)) {
      throw new Error(`Embedding worker script missing (${basename(script)})`)
    }
    const fork = this.forkImpl ?? electronFork
    const child = fork(script)
    this.child = child
    this.spawned = false

    try {
      child.stderr?.on('data', (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        const line = text.trim().slice(0, 400)
        if (!line) return
        logger.warn('Embedding utility stderr', {
          scope: 'codeindex',
          reason: logErrorSummary(line)
        })
      })
    } catch {
      /* ignore */
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const settleOk = (): void => {
        if (settled || gen !== this.generation) return
        settled = true
        if (timer) clearTimeout(timer)
        this.spawned = true
        resolve()
      }
      const settleErr = (err: Error): void => {
        if (settled || gen !== this.generation) return
        settled = true
        if (timer) clearTimeout(timer)
        reject(err)
      }
      child.once('spawn', settleOk)
      child.once('error', (err: unknown) => {
        settleErr(err instanceof Error ? err : new Error(String(err)))
      })
      child.once('exit', (code: unknown) => {
        settleErr(new Error(`Embedding worker exited during spawn (code=${String(code)})`))
      })
      timer = setTimeout(() => {
        settleErr(new Error('Embedding worker spawn timeout'))
      }, this.spawnTimeoutMs)
    })

    child.on('message', (msg: unknown) => {
      const res = msg as UtilityResponse
      if (res == null || typeof res.id !== 'number') return
      const pending = this.pending.get(res.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(res.id)
      pending.resolve(res)
      this.scheduleIdleDispose()
    })
    child.on('exit', () => {
      this.rejectAll(new Error('Embedding worker exited'))
      if (this.child === child) {
        this.child = null
        this.spawned = false
        this.spawnPromise = null
      }
    })
  }

  private async request(
    body: Omit<UtilityRequest, 'id'>,
    timeoutMs = this.timeoutMs,
    signal?: AbortSignal
  ): Promise<UtilityResponse> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    this.clearIdleTimer()
    const child = await this.ensureSpawned()
    if (signal?.aborted) {
      await this.shutdown()
      throw new DOMException('Aborted', 'AbortError')
    }
    const id = this.nextId++
    return new Promise<UtilityResponse>((resolve, reject) => {
      const removeAbort = (): void => signal?.removeEventListener('abort', onAbort)
      const timer = setTimeout(() => {
        this.pending.delete(id)
        removeAbort()
        reject(new Error(`Embedding worker timeout (${body.op})`))
      }, timeoutMs)
      const onAbort = (): void => {
        clearTimeout(timer)
        this.pending.delete(id)
        removeAbort()
        reject(new DOMException('Aborted', 'AbortError'))
        // Only tear down the shared worker when no other request is in flight —
        // aborting one embed batch must not orphan other pending requests.
        if (this.pending.size === 0) void this.shutdown()
      }
      this.pending.set(id, {
        resolve: (response) => {
          removeAbort()
          resolve(response)
        },
        reject: (err) => {
          removeAbort()
          reject(err)
        },
        timer
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        child.postMessage({ ...body, id } satisfies UtilityRequest)
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        removeAbort()
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }
}

let shared: EmbedUtilityClient | null = null

export function getEmbedUtilityClient(): EmbedUtilityClient {
  if (!shared) shared = new EmbedUtilityClient()
  return shared
}

export function resetEmbedUtilityClientForTests(): void {
  void shared?.shutdown()
  shared = null
}