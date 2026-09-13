/**
 * Main-process client for the Whisper ASR utilityProcess.
 * Do not run ORT on the Electron main loop.
 */
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { logger } from '../../shared/logger'
import { logErrorSummary } from '../../shared/utils/logPolicy'

type UtilityOp = 'ensure' | 'transcribe' | 'dispose' | 'ping'

type UtilityRequest = {
  id: number
  op: UtilityOp
  modelDir?: string
  modelId?: string
  /** Base64 Int16 little-endian PCM at 16 kHz (JSON-safe; never a TypedArray). */
  pcm16k?: string
  sampleRate?: number
}

type UtilityResponse = {
  id: number
  ok: boolean
  error?: string
  text?: string
  modelId?: string
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

export type DictationWhisperBackend = {
  ensure: (modelDir: string, modelId: string, signal?: AbortSignal) => Promise<void>
  transcribe: (pcm16k: string, sampleRate: number, signal?: AbortSignal) => Promise<string>
  dispose: () => Promise<void>
}

const DEFAULT_TIMEOUT_MS = 120_000
const SPAWN_TIMEOUT_MS = 15_000
const SPAWN_MAX_ATTEMPTS = 2

function defaultScriptPath(): string {
  return join(__dirname, 'dictationUtility.js')
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
    serviceName: 'vyotiq-dictation-whisper',
    stdio: 'pipe'
  })
}

export class DictationUtilityClient implements DictationWhisperBackend {
  private child: UtilityChild | null = null
  private spawned = false
  private spawnPromise: Promise<void> | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private generation = 0
  private readonly timeoutMs: number
  private readonly spawnTimeoutMs: number
  private readonly forkImpl: ((script: string) => UtilityChild) | null
  private readonly scriptPath: string

  constructor(opts?: {
    forkImpl?: (script: string) => UtilityChild
    scriptPath?: string
    timeoutMs?: number
    spawnTimeoutMs?: number
  }) {
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.spawnTimeoutMs = opts?.spawnTimeoutMs ?? SPAWN_TIMEOUT_MS
    this.forkImpl = opts?.forkImpl ?? null
    this.scriptPath = opts?.scriptPath ?? defaultScriptPath()
  }

  get isAvailable(): boolean {
    return this.forkImpl != null || canUseUtilityProcess()
  }

  async ensure(modelDir: string, modelId: string, signal?: AbortSignal): Promise<void> {
    const res = await this.request({ op: 'ensure', modelDir, modelId }, this.timeoutMs, signal)
    if (!res.ok) throw new Error(res.error ?? 'Dictation worker failed to load Whisper')
  }

  async transcribe(pcm16k: string, sampleRate: number, signal?: AbortSignal): Promise<string> {
    const res = await this.request({ op: 'transcribe', pcm16k, sampleRate }, this.timeoutMs, signal)
    if (!res.ok) throw new Error(res.error ?? 'Dictation worker transcription failed')
    const text = res.text?.trim() ?? ''
    if (!text) throw new Error('Dictation returned empty transcript')
    return text
  }

  async dispose(): Promise<void> {
    try {
      await this.request({ op: 'dispose' }, 15_000)
    } catch {
      /* ignore */
    }
  }

  async shutdown(): Promise<void> {
    this.generation++
    this.rejectAll(new Error('Dictation worker shut down'))
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
        throw new Error('Dictation worker failed to start')
      }
      return this.child
    }

    this.spawnPromise = (async () => {
      const gen = this.generation
      let lastErr: Error | null = null
      for (let attempt = 1; attempt <= SPAWN_MAX_ATTEMPTS; attempt++) {
        if (gen !== this.generation) {
          throw new Error('Dictation worker shut down during spawn')
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
      throw lastErr ?? new Error('Dictation worker failed to start')
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
      throw new Error('Dictation worker failed to start')
    }
    return this.child
  }

  private async spawnOnce(gen: number): Promise<void> {
    const script = this.scriptPath
    if (!this.forkImpl && !existsSync(script)) {
      throw new Error(`Dictation worker script missing (${basename(script)})`)
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
        logger.warn('Dictation utility stderr', {
          scope: 'dictation',
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
        settleErr(new Error(`Dictation worker exited during spawn (code=${String(code)})`))
      })
      timer = setTimeout(() => {
        settleErr(new Error('Dictation worker spawn timeout'))
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
    })
    child.on('exit', () => {
      this.rejectAll(new Error('Dictation worker exited'))
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
        reject(new Error(`Dictation worker timeout (${body.op})`))
      }, timeoutMs)
      const onAbort = (): void => {
        clearTimeout(timer)
        this.pending.delete(id)
        removeAbort()
        reject(new DOMException('Aborted', 'AbortError'))
        // Only tear down the shared worker when no other request is in flight —
        // aborting one transcription must not orphan other pending requests.
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

let shared: DictationUtilityClient | null = null

export function getDictationUtilityClient(): DictationUtilityClient {
  if (!shared) shared = new DictationUtilityClient()
  return shared
}

export function resetDictationUtilityClientForTests(): void {
  void shared?.shutdown()
  shared = null
}
