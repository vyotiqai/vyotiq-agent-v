/**
 * Main-process client for the long-lived ONNX + index-sync utilityProcess.
 * Prefer utilityProcess; on spawn failure retry once, then surface the error.
 * In-process only when VYOTIQ_INDEX_SYNC_IN_PROCESS / VYOTIQ_EMBED_IN_PROCESS / Vitest.
 */
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { logger } from '../../../shared/logger'
import { logErrorSummary } from '../../../shared/utils/logPolicy'
import { LIGHTON_DENSE_DIM, type CodebaseSearchHit, type CodebaseSearchMode, type IndexStatus } from './types'
import type { SyncResult } from './sync'
import type { SparseSyncResult } from '../sparsegrep/sync'
import type { CandidateLookup } from '../sparsegrep/query'
import type { WalkedFile } from '../tools/walk'
import { publishIndexSyncProgress } from './indexProgress'
import type { CodeIndexSyncProgress } from '../../../shared/ipc/schemas/settings'

type Role = 'query' | 'document'
type EmbedderKind = 'session' | 'hash' | 'ollama' | 'llamacpp'
type SparseLookupKind = 'regex' | 'substring'

export type SparseUtilityResult =
  | {
      kind: 'lookup'
      lookup: CandidateLookup
      fileCount: number
      syncComplete: boolean
    }
  | {
      kind: 'list'
      ready: boolean
      paths: string[]
      fileCount: number
      syncComplete: boolean
    }

type UtilityRequest = {
  id: number
  op:
    | 'ensure'
    | 'embed'
    | 'dispose'
    | 'ping'
    | 'cancel'
    | 'syncCode'
    | 'syncSparse'
    | 'searchCode'
    | 'sparseLookup'
    | 'sparseListFiles'
  modelDir?: string
  modelId?: string
  texts?: string[]
  role?: Role
  targetId?: number
  workspaceRoot?: string
  dbPath?: string
  /** Read-only parent index to reuse embeddings from (instance worktrees). */
  reuseDbPath?: string
  dimensions?: number
  embedderKind?: EmbedderKind
  ollama?: { baseUrl?: string; model?: string; dimensions?: number }
  files?: WalkedFile[]
  query?: string
  limit?: number
  mode?: CodebaseSearchMode
  sparseKind?: SparseLookupKind
  caseSensitive?: boolean
  wasmDir?: string
  /** Page size for paged sparse walks. */
  pageCap?: number
  /** Hash fallback must not rewrite an existing neural index. */
  preserveNeural?: boolean
}

type UtilityResponse = {
  id: number
  ok: boolean
  error?: string
  embeddings?: ArrayBuffer[]
  modelId?: string
  dimensions?: number
  sync?: SyncResult | SparseSyncResult
  hits?: CodebaseSearchHit[]
  status?: IndexStatus
  sparse?: SparseUtilityResult
  rssMb?: number
  heapUsedMb?: number
  sessionLoaded?: boolean
}

type Pending = {
  resolve: (msg: UtilityResponse) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  waitMs: number
  op: UtilityRequest['op']
  /** Abort listener registered for this RPC — needed so timeout refresh can detach it. */
  signal?: AbortSignal
  onAbort?: () => void
}

const DEFAULT_TIMEOUT_MS = 120_000
/** Idle timeout for long syncs — refreshed whenever the child posts progress. */
const SYNC_IDLE_TIMEOUT_MS = 600_000
const SPAWN_TIMEOUT_MS = 15_000
const SPAWN_MAX_ATTEMPTS = 2
/** After this much idle time, dispose ONNX and kill the utility child to free RSS. */
const DEFAULT_IDLE_UNLOAD_MS = 5 * 60_000

function resolveIdleUnloadMs(): number {
  const raw = process.env.VYOTIQ_EMBED_IDLE_UNLOAD_MS
  if (raw == null || raw === '') return DEFAULT_IDLE_UNLOAD_MS
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_IDLE_UNLOAD_MS
  return Math.floor(n)
}

function isLongRunningOp(op: UtilityRequest['op']): boolean {
  return op === 'syncCode' || op === 'syncSparse' || op === 'searchCode'
}

export type EmbedUtilityPerfStats = {
  pid: number | null
  sessionLoaded: boolean
  rssMb: number | null
  heapUsedMb: number | null
  idleUnloadMs: number
  lastActivityAt: number | null
}

type UtilityChild = {
  pid?: number
  postMessage: (message: unknown, transfer?: ArrayBuffer[]) => void
  kill: () => void
  on: (event: string, listener: (...args: unknown[]) => void) => void
  once: (event: string, listener: (...args: unknown[]) => void) => void
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void
  stderr?: { on: (event: 'data', listener: (chunk: Buffer | string) => void) => void } | null
}

export type UtilityOnnxSession = {
  readonly modelId: string
  readonly dimensions: number
  embed(
    texts: string[],
    role: 'query' | 'document',
    signal?: AbortSignal
  ): Promise<Float32Array[]>
  dispose?: () => void
}

export type EmbedUtilityClientOptions = {
  /** Injected child for tests (no real Electron utilityProcess). */
  forkImpl?: (script: string) => UtilityChild
  scriptPath?: string
  timeoutMs?: number
  /** Idle timeout for syncCode/syncSparse (refreshed on progress). */
  syncIdleTimeoutMs?: number
  /**
   * After this many ms with no embed/sync/search traffic, dispose the ONNX
   * session and kill the utility child. `0` disables. Default 5 minutes
   * (`VYOTIQ_EMBED_IDLE_UNLOAD_MS` overrides when unset here).
   */
  idleUnloadMs?: number
}

function defaultScriptPath(): string {
  return join(__dirname, 'embedUtility.js')
}

function canUseUtilityProcess(): boolean {
  if (process.env.VITEST === 'true' || process.env.VITEST === '1') return false
  if (process.env.VYOTIQ_EMBED_IN_PROCESS === '1') return false
  try {
    const electron = require('electron') as { utilityProcess?: { fork: Function } }
    return typeof electron.utilityProcess?.fork === 'function'
  } catch {
    return false
  }
}

/** Whether crawl/SQLite sync + search/grep may use utilityProcess. */
export function canUseIndexSyncUtility(): boolean {
  if (process.env.VYOTIQ_INDEX_SYNC_IN_PROCESS === '1') return false
  return canUseUtilityProcess()
}

export const canUseIndexSearchUtility = canUseIndexSyncUtility

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

function abortMessage(errMsg: string): boolean {
  return errMsg === 'Aborted' || /abort/i.test(errMsg)
}

function assertUtilityOk(res: UtilityResponse, fallback: string): void {
  if (res.ok) return
  const errMsg = res.error ?? fallback
  if (abortMessage(errMsg)) throw new DOMException('Aborted', 'AbortError')
  throw new Error(errMsg)
}

/** Main-side hook when the utility child dies so ONNX cache can drop its proxy. */
let onUtilitySessionLost: (() => void) | null = null

export function setEmbedUtilitySessionLostHandler(fn: (() => void) | null): void {
  onUtilitySessionLost = fn
}

function resolveCodeindexWasmDir(): string | undefined {
  try {
    const electron = require('electron') as {
      app?: { isPackaged?: boolean; getAppPath?: () => string }
    }
    const app = electron.app
    if (app?.isPackaged && typeof process.resourcesPath === 'string' && process.resourcesPath) {
      return join(process.resourcesPath, 'codeindex', 'wasm')
    }
    if (app?.getAppPath) {
      return join(app.getAppPath(), 'resources', 'codeindex', 'wasm')
    }
  } catch {
    /* optional */
  }
  if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
    return join(process.resourcesPath, 'codeindex', 'wasm')
  }
  return undefined
}

export class EmbedUtilityClient {
  private child: UtilityChild | null = null
  private spawned = false
  private spawnPromise: Promise<void> | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly timeoutMs: number
  private readonly syncIdleTimeoutMs: number
  private readonly idleUnloadMs: number
  private readonly forkImpl: ((script: string) => UtilityChild) | null
  private readonly scriptPath: string
  private modelId: string | null = null
  private dimensions = LIGHTON_DENSE_DIM
  private generation = 0
  /** Last successful ensure — used to re-ensure after child exit/re-spawn. */
  private lastEnsure: { modelDir: string; modelId: string } | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private lastActivityAt: number | null = null
  private cachedRssMb: number | null = null
  private cachedHeapUsedMb: number | null = null
  private idleUnloadInFlight = false

  constructor(opts: EmbedUtilityClientOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.syncIdleTimeoutMs = opts.syncIdleTimeoutMs ?? SYNC_IDLE_TIMEOUT_MS
    this.idleUnloadMs = opts.idleUnloadMs ?? resolveIdleUnloadMs()
    this.forkImpl = opts.forkImpl ?? null
    this.scriptPath = opts.scriptPath ?? defaultScriptPath()
  }

  get isAvailable(): boolean {
    return this.forkImpl != null || canUseUtilityProcess()
  }

  getPerfStats(): EmbedUtilityPerfStats {
    return {
      pid: typeof this.child?.pid === 'number' ? this.child.pid : null,
      sessionLoaded: this.modelId != null,
      rssMb: this.cachedRssMb,
      heapUsedMb: this.cachedHeapUsedMb,
      idleUnloadMs: this.idleUnloadMs,
      lastActivityAt: this.lastActivityAt
    }
  }

  /** Best-effort ping so PERF snapshots can include utility RSS. */
  async refreshPerfStats(signal?: AbortSignal): Promise<EmbedUtilityPerfStats> {
    if (!this.child || !this.spawned) return this.getPerfStats()
    try {
      const res = await this.request({ op: 'ping' }, signal, 5_000)
      if (res.ok) {
        if (typeof res.rssMb === 'number') this.cachedRssMb = res.rssMb
        if (typeof res.heapUsedMb === 'number') this.cachedHeapUsedMb = res.heapUsedMb
      }
    } catch {
      /* ignore — snapshot still has pid / sessionLoaded */
    }
    return this.getPerfStats()
  }

  private noteActivity(): void {
    this.lastActivityAt = Date.now()
    this.armIdleUnload()
  }

  private clearIdleUnload(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private armIdleUnload(): void {
    this.clearIdleUnload()
    if (this.idleUnloadMs <= 0) return
    if (!this.child || !this.spawned) return
    this.idleTimer = setTimeout(() => {
      void this.idleUnload()
    }, this.idleUnloadMs)
    // Do not keep the event loop alive solely for idle unload.
    if (typeof this.idleTimer === 'object' && this.idleTimer !== null && 'unref' in this.idleTimer) {
      ;(this.idleTimer as NodeJS.Timeout).unref?.()
    }
  }

  /**
   * Dispose ONNX in the child and kill the process so native ORT heaps are
   * released. Keeps `lastEnsure` so the next op can re-spawn + re-ensure.
   */
  async idleUnload(): Promise<void> {
    if (this.idleUnloadInFlight) return
    if (this.pending.size > 0) {
      this.armIdleUnload()
      return
    }
    if (!this.child || !this.spawned) return
    this.idleUnloadInFlight = true
    this.clearIdleUnload()
    const keepEnsure = this.lastEnsure
    try {
      try {
        await this.request({ op: 'dispose' }, undefined, 15_000)
      } catch {
        /* kill below still frees the process */
      }
      // Requests may have arrived during the dispose await — defer unload rather
      // than killing the child out from under them.
      if (this.pending.size > 0) {
        this.armIdleUnload()
        return
      }
      this.modelId = null
      this.cachedRssMb = null
      this.cachedHeapUsedMb = null
      this.lastEnsure = keepEnsure
      this.markSessionLost()
      this.spawnPromise = null
      this.clearChild(this.child)
      logger.info('Embed utility idle-unloaded', {
        scope: 'embedUtility',
        reason: `idle>${this.idleUnloadMs}ms`
      })
    } finally {
      this.idleUnloadInFlight = false
      this.lastEnsure = keepEnsure
    }
  }

  sessionProxy(): UtilityOnnxSession {
    const self = this
    return {
      get modelId() {
        return self.modelId ?? 'pending'
      },
      get dimensions() {
        return self.dimensions
      },
      embed: (texts, role, signal) => self.embed(texts, role, signal),
      dispose: () => {
        void self.disposeSession()
      }
    }
  }

  async ensure(opts: {
    modelDir: string
    modelId: string
    signal?: AbortSignal
  }): Promise<UtilityOnnxSession> {
    try {
      const res = await this.request(
        { op: 'ensure', modelDir: opts.modelDir, modelId: opts.modelId },
        opts.signal
      )
      assertUtilityOk(res, 'embed utility ensure failed')
      this.lastEnsure = { modelDir: opts.modelDir, modelId: opts.modelId }
      this.modelId = res.modelId ?? opts.modelId
      this.dimensions = res.dimensions ?? LIGHTON_DENSE_DIM
      return this.sessionProxy()
    } catch (err) {
      this.lastEnsure = null
      throw err
    }
  }

  async embed(
    texts: string[],
    role: Role = 'document',
    signal?: AbortSignal
  ): Promise<Float32Array[]> {
    const res = await this.request({ op: 'embed', texts, role }, signal)
    assertUtilityOk(res, 'embed utility embed failed')
    const out: Float32Array[] = []
    for (const buf of res.embeddings ?? []) {
      out.push(new Float32Array(buf))
    }
    return out
  }

  async syncCode(opts: {
    workspaceRoot: string
    dbPath: string
    dimensions: number
    modelId: string
    embedderKind: EmbedderKind
    ollama?: { baseUrl?: string; model?: string; dimensions?: number }
    files?: WalkedFile[]
    preserveNeural?: boolean
    reuseDbPath?: string
    signal?: AbortSignal
  }): Promise<SyncResult> {
    const res = await this.request(
      {
        op: 'syncCode',
        workspaceRoot: opts.workspaceRoot,
        dbPath: opts.dbPath,
        dimensions: opts.dimensions,
        modelId: opts.modelId,
        embedderKind: opts.embedderKind,
        ollama: opts.ollama,
        files: opts.files,
        preserveNeural: opts.preserveNeural,
        reuseDbPath: opts.reuseDbPath,
        wasmDir: resolveCodeindexWasmDir()
      },
      opts.signal,
      Math.max(this.timeoutMs, this.syncIdleTimeoutMs)
    )
    assertUtilityOk(res, 'embed utility syncCode failed')
    return res.sync as SyncResult
  }

  async syncSparse(opts: {
    workspaceRoot: string
    dbPath: string
    files?: WalkedFile[]
    pageCap?: number
    signal?: AbortSignal
  }): Promise<SparseSyncResult> {
    const res = await this.request(
      {
        op: 'syncSparse',
        workspaceRoot: opts.workspaceRoot,
        dbPath: opts.dbPath,
        files: opts.files,
        pageCap: opts.pageCap
      },
      opts.signal,
      Math.max(this.timeoutMs, this.syncIdleTimeoutMs)
    )
    assertUtilityOk(res, 'embed utility syncSparse failed')
    return res.sync as SparseSyncResult
  }

  async searchCode(opts: {
    workspaceRoot: string
    dbPath: string
    dimensions: number
    modelId: string
    embedderKind: EmbedderKind
    query: string
    limit?: number
    mode?: CodebaseSearchMode
    ollama?: { baseUrl?: string; model?: string; dimensions?: number }
    signal?: AbortSignal
  }): Promise<{ hits: CodebaseSearchHit[]; status: IndexStatus }> {
    const res = await this.request(
      {
        op: 'searchCode',
        workspaceRoot: opts.workspaceRoot,
        dbPath: opts.dbPath,
        dimensions: opts.dimensions,
        modelId: opts.modelId,
        embedderKind: opts.embedderKind,
        ollama: opts.ollama,
        query: opts.query,
        limit: opts.limit,
        mode: opts.mode
      },
      opts.signal,
      Math.max(this.timeoutMs, 180_000)
    )
    assertUtilityOk(res, 'embed utility searchCode failed')
    return {
      hits: res.hits ?? [],
      status: res.status ?? {
        ready: false,
        modelId: opts.modelId,
        fileCount: 0,
        chunkCount: 0,
        lastIndexedAt: null
      }
    }
  }

  async sparseLookup(opts: {
    dbPath: string
    query: string
    kind: SparseLookupKind
    caseSensitive?: boolean
    signal?: AbortSignal
  }): Promise<Extract<SparseUtilityResult, { kind: 'lookup' }>> {
    const res = await this.request(
      {
        op: 'sparseLookup',
        dbPath: opts.dbPath,
        query: opts.query,
        sparseKind: opts.kind,
        caseSensitive: opts.caseSensitive
      },
      opts.signal
    )
    assertUtilityOk(res, 'embed utility sparseLookup failed')
    const sparse = res.sparse
    if (!sparse || sparse.kind !== 'lookup') {
      throw new Error('embed utility sparseLookup returned no lookup payload')
    }
    return sparse
  }

  async sparseListFiles(opts: {
    dbPath: string
    signal?: AbortSignal
  }): Promise<Extract<SparseUtilityResult, { kind: 'list' }>> {
    const res = await this.request(
      {
        op: 'sparseListFiles',
        dbPath: opts.dbPath
      },
      opts.signal
    )
    assertUtilityOk(res, 'embed utility sparseListFiles failed')
    const sparse = res.sparse
    if (!sparse || sparse.kind !== 'list') {
      throw new Error('embed utility sparseListFiles returned no list payload')
    }
    return sparse
  }

  async disposeSession(signal?: AbortSignal): Promise<void> {
    this.clearIdleUnload()
    this.modelId = null
    this.lastEnsure = null
    this.cachedRssMb = null
    this.cachedHeapUsedMb = null
    try {
      await this.request({ op: 'dispose' }, signal)
    } catch {
      /* ignore */
    }
  }

  async shutdown(): Promise<void> {
    this.clearIdleUnload()
    this.generation++
    this.rejectAll(new Error('Embed utility shut down'))
    const child = this.child
    this.child = null
    this.spawned = false
    this.spawnPromise = null
    this.modelId = null
    this.lastEnsure = null
    this.cachedRssMb = null
    this.cachedHeapUsedMb = null
    try {
      child?.kill()
    } catch {
      /* ignore */
    }
  }

  private markSessionLost(): void {
    this.modelId = null
    try {
      onUtilitySessionLost?.()
    } catch {
      /* ignore */
    }
  }

  private async maybeReensureAfterSpawn(
    body: Omit<UtilityRequest, 'id'>,
    signal?: AbortSignal
  ): Promise<void> {
    const op = body.op
    // Hash/Ollama sync+search and sparse ops do not need the ONNX session.
    if (
      op === 'ensure' ||
      op === 'dispose' ||
      op === 'ping' ||
      op === 'cancel' ||
      op === 'sparseLookup' ||
      op === 'sparseListFiles' ||
      op === 'syncSparse' ||
      op === 'syncCode' ||
      body.embedderKind === 'hash' ||
      body.embedderKind === 'llamacpp' ||
      body.embedderKind === 'ollama'
    ) {
      return
    }
    if (this.modelId) return
    if (!this.lastEnsure) return
    const res = await this.request(
      {
        op: 'ensure',
        modelDir: this.lastEnsure.modelDir,
        modelId: this.lastEnsure.modelId
      },
      signal,
      // Search during a multi-minute sync must wait longer than the default 120s.
      isLongRunningOp(op) || op === 'searchCode' || op === 'embed' ? this.syncIdleTimeoutMs : undefined
    )
    assertUtilityOk(res, 'embed utility re-ensure failed')
    this.modelId = res.modelId ?? this.lastEnsure.modelId
    this.dimensions = res.dimensions ?? LIGHTON_DENSE_DIM
  }

  private rejectAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      this.pending.delete(id)
      p.reject(err)
    }
  }

  private sendCancel(targetId: number): void {
    const child = this.child
    if (!child || !this.spawned) return
    try {
      const id = this.nextId++
      child.postMessage({ id, op: 'cancel', targetId } satisfies UtilityRequest)
    } catch {
      /* ignore */
    }
  }

  /**
   * Hung sync may kill the child (write chain). searchCode only kills when it
   * is the sole in-flight RPC — otherwise an overlapping sync would be aborted
   * via child `exit` → rejectAll. Counts others excluding `requestId` while
   * that entry is still in `pending`.
   */
  private shouldKillChildOnTimeout(op: UtilityRequest['op'], requestId: number): boolean {
    if (op === 'syncCode' || op === 'syncSparse') return true
    if (op !== 'searchCode') return false
    for (const id of this.pending.keys()) {
      if (id !== requestId) return false
    }
    return true
  }

  /** Reset idle timer when the child is still making progress. */
  private refreshPendingTimeout(requestId: number): void {
    const pending = this.pending.get(requestId)
    if (!pending || !isLongRunningOp(pending.op)) return
    clearTimeout(pending.timer)
    pending.timer = setTimeout(() => {
      this.failPending(requestId, new Error(`Embed utility timeout (${pending.op})`), {
        killChild: this.shouldKillChildOnTimeout(pending.op, requestId),
        signal: pending.signal,
        onAbort: pending.onAbort
      })
    }, pending.waitMs)
  }

  /**
   * Fail one pending RPC. Hung sync timeouts kill the child so the write chain
   * cannot stay blocked after a soft cancel that ONNX never sees. searchCode
   * timeouts only kill when no other RPC is in flight.
   */
  private failPending(
    requestId: number,
    err: Error,
    opts?: { killChild?: boolean; signal?: AbortSignal; onAbort?: () => void }
  ): void {
    const pending = this.pending.get(requestId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(requestId)
    if (opts?.signal && opts.onAbort) {
      opts.signal.removeEventListener('abort', opts.onAbort)
    }
    this.sendCancel(requestId)
    pending.reject(err)
    if (opts?.killChild) {
      this.modelId = null
      this.spawnPromise = null
      this.markSessionLost()
      this.clearChild(this.child)
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

  private async spawnOnce(gen: number): Promise<UtilityChild> {
    const script = this.scriptPath
    if (!this.forkImpl && !existsSync(script)) {
      throw new Error(`Embed utility script missing (${basename(script)})`)
    }
    const fork = this.forkImpl ?? electronFork
    const child = fork(script)
    this.child = child
    this.spawned = false

    // Surface child boot crashes (otherwise only a redacted Error name reaches warm logs).
    try {
      child.stderr?.on('data', (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        const line = text.trim().slice(0, 400)
        if (!line) return
        logger.warn('Embed utility stderr', {
          scope: 'embedUtility',
          reason: logErrorSummary(line)
        })
      })
    } catch {
      /* ignore */
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const settleOk = (): void => {
        if (settled || gen !== this.generation) return
        settled = true
        this.spawned = true
        resolve()
      }
      const settleErr = (err: Error): void => {
        if (settled || gen !== this.generation) return
        settled = true
        reject(err)
      }

      child.once('spawn', settleOk)
      child.once('error', (err: unknown) => {
        settleErr(err instanceof Error ? err : new Error(String(err)))
      })
      child.once('exit', (code: unknown) => {
        settleErr(new Error(`Embed utility exited during spawn (code=${String(code)})`))
      })
      setTimeout(() => {
        if (!settled) settleErr(new Error('Embed utility spawn timeout'))
      }, SPAWN_TIMEOUT_MS)
    })

    child.on('message', (msg: unknown) => {
      if (
        msg != null &&
        typeof msg === 'object' &&
        (msg as { type?: string }).type === 'indexProgress'
      ) {
        const evt = msg as {
          type: 'indexProgress'
          requestId?: number
          indexProgress: CodeIndexSyncProgress
          progress: number | null
          message: string
        }
        if (typeof evt.requestId === 'number') {
          this.refreshPendingTimeout(evt.requestId)
        }
        const ip = evt.indexProgress
        publishIndexSyncProgress(
          {
            kind: ip.kind,
            stage: ip.stage,
            filesDone: ip.filesDone,
            filesTotal: ip.filesTotal,
            indexed: ip.indexed,
            skipped: ip.skipped,
            removed: ip.removed,
            embedChunks: ip.embedChunks,
            currentPath: ip.currentPath
          },
          { force: ip.stage !== 'scanning' }
        )
        return
      }
      const res = msg as UtilityResponse
      if (res == null || typeof res.id !== 'number') return
      const pending = this.pending.get(res.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(res.id)
      pending.resolve(res)
    })
    child.on('exit', () => {
      this.rejectAll(new Error('Embed utility exited'))
      if (this.child === child) {
        this.child = null
        this.spawned = false
        this.spawnPromise = null
        this.markSessionLost()
      }
    })
    child.on('error', (err: unknown) => {
      this.rejectAll(err instanceof Error ? err : new Error(String(err)))
    })

    return child
  }

  private async ensureSpawned(): Promise<void> {
    if (this.child && this.spawned) return
    if (this.spawnPromise) return this.spawnPromise

    this.spawnPromise = (async () => {
      const gen = this.generation
      let lastErr: Error | null = null
      for (let attempt = 1; attempt <= SPAWN_MAX_ATTEMPTS; attempt++) {
        if (gen !== this.generation) {
          throw new Error('Embed utility shut down during spawn')
        }
        try {
          await this.spawnOnce(gen)
          return
        } catch (err) {
          lastErr = err instanceof Error ? err : new Error(String(err))
          this.clearChild(this.child)
          if (attempt < SPAWN_MAX_ATTEMPTS) {
            await new Promise((r) => setTimeout(r, 50))
            continue
          }
        }
      }
      throw lastErr ?? new Error('Embed utility spawn failed')
    })()

    try {
      await this.spawnPromise
    } catch (err) {
      this.spawnPromise = null
      this.child = null
      this.spawned = false
      throw err
    }
  }

  private request(
    body: Omit<UtilityRequest, 'id'>,
    signal?: AbortSignal,
    timeoutMs?: number
  ): Promise<UtilityResponse> {
    if (signal?.aborted) {
      return Promise.reject(new DOMException('Aborted', 'AbortError'))
    }

    const waitMs = timeoutMs ?? this.timeoutMs
    const tracksActivity = body.op !== 'ping' && body.op !== 'dispose' && body.op !== 'cancel'

    return (async () => {
      if (tracksActivity) this.noteActivity()
      await this.ensureSpawned()
      if (body.op !== 'ensure') {
        await this.maybeReensureAfterSpawn(body, signal)
      }
      const child = this.child
      if (!child || !this.spawned) throw new Error('Embed utility not spawned')

      const id = this.nextId++
      return await new Promise<UtilityResponse>((resolve, reject) => {
        const onAbort = (): void => {
          this.failPending(id, new DOMException('Aborted', 'AbortError'), {
            signal,
            onAbort
          })
        }

        const armTimeout = (): ReturnType<typeof setTimeout> =>
          setTimeout(() => {
            this.failPending(id, new Error(`Embed utility timeout (${body.op})`), {
              killChild: this.shouldKillChildOnTimeout(body.op, id),
              signal,
              onAbort
            })
          }, waitMs)

        if (signal) {
          signal.addEventListener('abort', onAbort, { once: true })
        }

        this.pending.set(id, {
          resolve: (msg) => {
            if (signal) signal.removeEventListener('abort', onAbort)
            if (tracksActivity) this.noteActivity()
            if (typeof msg.rssMb === 'number') this.cachedRssMb = msg.rssMb
            if (typeof msg.heapUsedMb === 'number') this.cachedHeapUsedMb = msg.heapUsedMb
            resolve(msg)
          },
          reject: (err) => {
            if (signal) signal.removeEventListener('abort', onAbort)
            if (tracksActivity) this.noteActivity()
            reject(err)
          },
          timer: armTimeout(),
          waitMs,
          op: body.op,
          signal,
          onAbort
        })

        try {
          child.postMessage({ ...body, id } satisfies UtilityRequest)
        } catch (err) {
          const pending = this.pending.get(id)
          if (pending) {
            clearTimeout(pending.timer)
            this.pending.delete(id)
          }
          if (signal) signal.removeEventListener('abort', onAbort)
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    })()
  }
}

let shared: EmbedUtilityClient | null = null

export function getEmbedUtilityClient(opts?: EmbedUtilityClientOptions): EmbedUtilityClient {
  if (opts?.forkImpl || opts?.scriptPath) {
    return new EmbedUtilityClient(opts)
  }
  if (!shared) shared = new EmbedUtilityClient(opts)
  return shared
}

export function getEmbedUtilityPerfStats(): EmbedUtilityPerfStats {
  if (!shared) {
    return {
      pid: null,
      sessionLoaded: false,
      rssMb: null,
      heapUsedMb: null,
      idleUnloadMs: resolveIdleUnloadMs(),
      lastActivityAt: null
    }
  }
  return shared.getPerfStats()
}

/** Fire-and-forget ping so the next load snapshot can include utility RSS. */
export function refreshEmbedUtilityPerfStatsBestEffort(): void {
  if (!shared) return
  void shared.refreshPerfStats().catch(() => undefined)
}

export function resetEmbedUtilityClientForTests(): void {
  void shared?.shutdown()
  shared = null
}

export { canUseUtilityProcess }
