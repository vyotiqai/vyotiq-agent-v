/**
 * Electron utilityProcess entry: ONNX embed + index crawl/SQLite off the main event loop.
 * Built as `out/main/embedUtility.js` via electron-vite rollup input.
 *
 * Protocol (MessagePort / postMessage):
 *   req:  { id, op: 'ensure'|'embed'|'dispose'|'ping'|'cancel'|'syncCode'|'syncSparse'|
 *                'searchCode'|'sparseLookup'|'sparseListFiles', ... }
 *   res:  { id, ok, error?, embeddings?, modelId?, dimensions?, sync?, hits?, status?, sparse? }
 *   progress (no completion): { type: 'indexProgress', requestId, indexProgress, progress, message }
 * Embeddings are transferred as ArrayBuffers when possible.
 */
import { applyOrtThreadEnvHints, buildOrtSessionOptions, resolveOrtIntraOpThreads } from './ortSessionOptions'
import { embedBatchedOnnx, type OnnxTensorCtor, type OnnxTokenizer } from './onnxEmbed'
import {
  DEFAULT_EMBED_DIM,
  LIGHTON_DENSE_DIM,
  MDENSEON_MODEL_ID,
  type CodebaseSearchHit,
  type CodebaseSearchMode,
  type IndexStatus
} from './types'
import { createLocalHashEmbedder, createOllamaEmbedder, type Embedder } from './embed'
import { clearLfm2LlamaCppCache, createLfm2LlamaCppEmbedder } from './lfm2LlamaCpp'
import { CodeIndexStore } from './store'
import { syncCodeIndex, type SyncResult } from './sync'
import { searchCodeIndex } from './search'
import { SparseGrepStore } from '../sparsegrep/store'
import { syncSparseGrep, type SparseSyncResult } from '../sparsegrep/sync'
import {
  lookupCandidatesForRegex,
  lookupCandidatesForSubstring,
  type CandidateLookup
} from '../sparsegrep/query'
import { type WalkedFile } from '../tools/walk'
import { disposeChunkParsers, setCodeindexWasmDirOverride } from './chunkAst'
import { createCancelledIdSet } from './utilityCancel'
import { withSqliteBusyRetry } from './sqliteBusyRetry'
import type { IndexProgressUpdate } from './indexProgress'
import type { CodeIndexSyncProgress } from '../../../shared/ipc/schemas/settings'
import { downloadModelFiles, modelFilesPresent } from './modelDownload'
import { codeIndexModelDir } from './modelPaths'
import { NEURAL_ARTIFACTS, getNeuralArtifact } from './registry'
import { loadGenericOnnxSession } from './onnxGeneric'

type Role = 'query' | 'document'

type EmbedderKind = 'session' | 'hash' | 'ollama' | 'llamacpp'

type SparseLookupKind = 'regex' | 'substring'

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
  /** Cancel the in-flight request with this id (not the cancel message's own id). */
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
  /** Main-resolved tree-sitter WASM directory (utility has no electron.app). */
  wasmDir?: string
  /** Page size for paged sparse walks. */
  pageCap?: number
  /** Hash fallback must not rewrite an existing neural index. */
  preserveNeural?: boolean
}

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
  /** Present on ping — child process memory for VYOTIQ_PERF snapshots. */
  rssMb?: number
  heapUsedMb?: number
  sessionLoaded?: boolean
}

type LoadedSession = {
  modelId: string
  dimensions: number
  embed: (texts: string[], role: Role, signal?: AbortSignal) => Promise<Float32Array[]>
  dispose: () => void
}

const READ_OPS = new Set(['searchCode', 'sparseLookup', 'sparseListFiles', 'ping'])

let session: LoadedSession | null = null
/** Serializes mutating / ORT-heavy ops (ensure, embed, dispose, sync*). */
let writeChain: Promise<void> = Promise.resolve()
/** Serializes ORT embed so read-lane search can overlap sync DB work safely. */
let embedChain: Promise<void> = Promise.resolve()
/** AbortController for the currently running write-chain op. */
let activeAbort: AbortController | null = null
let activeRequestId: number | null = null
const cancelledIds = createCancelledIdSet(256)
const activeReadAborts = new Map<number, AbortController>()

type UtilityProgressEvent = {
  type: 'indexProgress'
  requestId: number
  indexProgress: CodeIndexSyncProgress
  progress: number | null
  message: string
}

function postProgress(requestId: number, update: IndexProgressUpdate): void {
  const indexProgress: CodeIndexSyncProgress = {
    kind: update.kind,
    stage: update.stage,
    filesDone: update.filesDone,
    filesTotal: update.filesTotal,
    indexed: update.indexed,
    skipped: update.skipped,
    removed: update.removed ?? 0,
    embedChunks: update.embedChunks ?? 0,
    currentPath: update.currentPath ?? null
  }
  const progress =
    update.filesTotal > 0
      ? Math.min(0.99, Math.max(0, update.filesDone / update.filesTotal))
      : null
  const counts = `${update.filesDone}/${update.filesTotal} files · ${update.indexed} updated · ${update.skipped} skipped`
  let message = counts
  if (update.stage === 'walking') {
    message =
      update.kind === 'code' ? 'Walking workspace (code index)…' : 'Walking workspace (sparse index)…'
  } else if (update.stage === 'embedding') {
    message = `Embedding ${update.embedChunks ?? 0} chunks · ${counts}${
      update.currentPath ? ` · ${update.currentPath}` : ''
    }`
  } else if (update.stage === 'reconciling') {
    message = `Reconciling removed files · ${counts}`
  } else if (update.stage === 'done') {
    message =
      update.kind === 'code'
        ? `Code index ready · ${update.indexed} updated · ${update.skipped} skipped`
        : `Sparse index ready · ${update.indexed} updated · ${update.skipped} skipped`
  } else {
    message =
      update.kind === 'code'
        ? `Indexing code · ${counts}${update.currentPath ? ` · ${update.currentPath}` : ''}`
        : `Indexing sparse grep · ${counts}${update.currentPath ? ` · ${update.currentPath}` : ''}`
  }
  const evt: UtilityProgressEvent = {
    type: 'indexProgress',
    requestId,
    indexProgress,
    progress,
    message
  }
  process.parentPort.postMessage(evt)
}

function withEmbedLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = embedChain.then(fn, fn)
  embedChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

async function loadSession(modelDir: string, modelId: string): Promise<LoadedSession> {
  const artifact = getNeuralArtifact(modelId)
  const dimensions = artifact?.dimensions ?? LIGHTON_DENSE_DIM
  if (artifact?.loader === 'generic') {
    const session = await loadGenericOnnxSession(modelDir, modelId, dimensions, {
      context: 'utility'
    })
    return {
      modelId: session.modelId,
      dimensions: session.dimensions,
      async embed(texts: string[], role: Role, signal?: AbortSignal): Promise<Float32Array[]> {
        return withEmbedLock(() => session.embed(texts, role, signal))
      },
      dispose: () => session.dispose?.()
    }
  }

  const intra = resolveOrtIntraOpThreads(undefined, 'utility')
  applyOrtThreadEnvHints(intra)
  const transformers = await import('@huggingface/transformers')
  const { env, AutoTokenizer, AutoModel, Tensor } = transformers as typeof transformers & {
    Tensor?: OnnxTensorCtor
  }
  env.allowLocalModels = true
  env.allowRemoteModels = false
  env.useBrowserCache = false
  ;(env as { cacheDir?: string }).cacheDir = modelDir

  const tokenizer = await AutoTokenizer.from_pretrained(modelDir, { local_files_only: true })
  const model = await AutoModel.from_pretrained(modelDir, {
    local_files_only: true,
    dtype: 'q8',
    session_options: buildOrtSessionOptions(undefined, 'utility')
  })

  return {
    modelId,
    dimensions,
    async embed(texts: string[], role: Role, signal?: AbortSignal): Promise<Float32Array[]> {
      return withEmbedLock(async () =>
        embedBatchedOnnx({
          tokenizer: tokenizer as unknown as OnnxTokenizer,
          model: (inputs) => model(inputs),
          texts,
          role,
          signal,
          hiddenSize: dimensions,
          ...(Tensor ? { Tensor } : {})
        })
      )
    },
    dispose: () => {
      try {
        ;(model as { dispose?: () => void }).dispose?.()
      } catch {
        /* ignore */
      }
    }
  }
}

function post(res: UtilityResponse): void {
  process.parentPort.postMessage(res)
}

function enqueueWrite(fn: () => Promise<void>): Promise<void> {
  const next = writeChain.then(fn, fn)
  writeChain = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

async function ensureChildSession(signal?: AbortSignal, allowDownload = true): Promise<LoadedSession> {
  if (session) return session
  for (const art of NEURAL_ARTIFACTS) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const modelDir = codeIndexModelDir(art.artifactId)
    let present = modelFilesPresent(modelDir, art.files)
    // Read lanes must never download weights inside an RPC: that channel has a
    // hard idle timeout and no progress events, so a cold download is always
    // killed mid-flight and every retry restarts from scratch. Weights are
    // acquired by the write chain (sync) before read RPCs are issued.
    if (!present && allowDownload && art.allowAutoDownload) {
      present = await downloadModelFiles(modelDir, art.files, { signal, hardError: false })
    }
    if (!present) continue
    session = await loadSession(modelDir, art.modelId)
    return session
  }
  throw new Error('ONNX session not loaded — call ensure first')
}

async function resolveSyncEmbedder(msg: UtilityRequest): Promise<Embedder> {
  const kind = msg.embedderKind ?? 'session'
  if (kind === 'llamacpp') {
    // Child-side llama.cpp: keeps the native model (and its VRAM) out of the
    // main process. In-process fallback lives in index.ts for tests / when
    // the utility is unavailable.
    return createLfm2LlamaCppEmbedder()
  }
  if (kind === 'hash') {
    return createLocalHashEmbedder(msg.dimensions ?? DEFAULT_EMBED_DIM, msg.modelId)
  }
  if (kind === 'ollama') {
    return createOllamaEmbedder({
      baseUrl: msg.ollama?.baseUrl,
      model: msg.ollama?.model,
      dimensions: msg.ollama?.dimensions ?? msg.dimensions
    })
  }
  return {
    get modelId() {
      return session?.modelId ?? msg.modelId ?? MDENSEON_MODEL_ID
    },
    dimensions: session?.dimensions ?? msg.dimensions ?? LIGHTON_DENSE_DIM,
    async embed(texts, opts) {
      // searchCode is a read lane: fail fast when weights are absent so main
      // can serve lexical hits instead of blocking on a doomed download.
      const s = session ?? (await ensureChildSession(opts?.signal, msg.op !== 'searchCode'))
      return s.embed(texts, opts?.role ?? 'document', opts?.signal)
    }
  }
}

async function handle(msg: UtilityRequest): Promise<void> {
  const { id, op } = msg

  if (op === 'cancel') {
    if (msg.targetId != null) {
      cancelledIds.remember(msg.targetId)
      if (activeRequestId === msg.targetId) {
        activeAbort?.abort()
      }
      activeReadAborts.get(msg.targetId)?.abort()
    }
    post({ id, ok: true })
    return
  }

  if (cancelledIds.consume(id)) {
    post({ id, ok: false, error: 'Aborted' })
    return
  }

  const ac = new AbortController()
  const isRead = READ_OPS.has(op)
  if (isRead) {
    activeReadAborts.set(id, ac)
  } else {
    activeAbort = ac
    activeRequestId = id
  }
  const signal = ac.signal

  try {
    if (msg.wasmDir?.trim()) {
      setCodeindexWasmDirOverride(msg.wasmDir.trim())
    }
    if (op === 'ping') {
      const mem = process.memoryUsage()
      post({
        id,
        ok: true,
        rssMb: Math.round(mem.rss / 1024 / 1024),
        heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
        sessionLoaded: session != null
      })
      return
    }
    if (op === 'dispose') {
      session?.dispose()
      session = null
      clearLfm2LlamaCppCache()
      disposeChunkParsers()
      post({ id, ok: true })
      return
    }
    if (op === 'ensure') {
      const modelDir = msg.modelDir?.trim()
      const modelId = msg.modelId?.trim()
      if (!modelDir || !modelId) throw new Error('ensure requires modelDir and modelId')
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      if (session?.modelId === modelId) {
        post({ id, ok: true, modelId: session.modelId, dimensions: session.dimensions })
        return
      }
      session?.dispose()
      session = null
      session = await loadSession(modelDir, modelId)
      if (signal.aborted) {
        session.dispose()
        session = null
        throw new DOMException('Aborted', 'AbortError')
      }
      post({ id, ok: true, modelId: session.modelId, dimensions: session.dimensions })
      return
    }
    if (op === 'embed') {
      const s = await ensureChildSession(signal)
      const texts = msg.texts ?? []
      const role: Role = msg.role === 'query' ? 'query' : 'document'
      const vectors = await s.embed(texts, role, signal)
      const embeddings: ArrayBuffer[] = vectors.map((v) => {
        const copy = new ArrayBuffer(v.byteLength)
        new Float32Array(copy).set(v)
        return copy
      })
      post({
        id,
        ok: true,
        embeddings,
        modelId: s.modelId,
        dimensions: s.dimensions
      })
      return
    }
    if (op === 'syncCode') {
      const workspaceRoot = msg.workspaceRoot?.trim()
      const dbPath = msg.dbPath?.trim()
      const dimensions = msg.dimensions
      if (!workspaceRoot || !dbPath || dimensions == null) {
        throw new Error('syncCode requires workspaceRoot, dbPath, dimensions')
      }
      const embedder = await resolveSyncEmbedder(msg)
      const store = CodeIndexStore.openDbPath(dbPath, dimensions, {
        reuseDbPath: msg.reuseDbPath
      })
      try {
        const sync = await syncCodeIndex(workspaceRoot, store, embedder, {
          signal,
          files: msg.files,
          preserveNeural: msg.preserveNeural === true,
          onProgress: (update) => {
            postProgress(id, update)
          }
        })
        post({ id, ok: true, sync })
      } finally {
        store.close()
      }
      return
    }
    if (op === 'syncSparse') {
      const workspaceRoot = msg.workspaceRoot?.trim()
      const dbPath = msg.dbPath?.trim()
      if (!workspaceRoot || !dbPath) {
        throw new Error('syncSparse requires workspaceRoot and dbPath')
      }
      const store = SparseGrepStore.openDbPath(dbPath)
      try {
        const sync = await syncSparseGrep(workspaceRoot, store, {
          signal,
          files: msg.files,
          pageCap: msg.pageCap,
          onProgress: (update) => postProgress(id, update)
        })
        post({ id, ok: true, sync })
      } finally {
        store.close()
      }
      return
    }
    if (op === 'searchCode') {
      const workspaceRoot = msg.workspaceRoot?.trim()
      const dbPath = msg.dbPath?.trim()
      const dimensions = msg.dimensions
      const query = msg.query ?? ''
      if (!workspaceRoot || !dbPath || dimensions == null) {
        throw new Error('searchCode requires workspaceRoot, dbPath, dimensions')
      }
      const embedder = await resolveSyncEmbedder(msg)
      const { hits, status } = await withSqliteBusyRetry(async () => {
        const store = CodeIndexStore.openDbPath(dbPath, dimensions)
        try {
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
          const hits = await searchCodeIndex(workspaceRoot, store, embedder, query, {
            limit: msg.limit,
            mode: msg.mode,
            signal
          })
          return { hits, status: store.getStatus() }
        } finally {
          store.close()
        }
      }, { signal })
      post({ id, ok: true, hits, status })
      return
    }
    if (op === 'sparseLookup') {
      const dbPath = msg.dbPath?.trim()
      const query = msg.query ?? ''
      const sparseKind = msg.sparseKind ?? 'substring'
      if (!dbPath) throw new Error('sparseLookup requires dbPath')
      const store = SparseGrepStore.openDbPath(dbPath)
      try {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
        const lookup =
          sparseKind === 'regex'
            ? lookupCandidatesForRegex(store, query, msg.caseSensitive === true)
            : lookupCandidatesForSubstring(store, query)
        const status = store.getStatus()
        post({
          id,
          ok: true,
          sparse: {
            kind: 'lookup',
            lookup,
            fileCount: status.fileCount,
            syncComplete: store.getMeta('syncComplete') === 'true'
          }
        })
      } finally {
        store.close()
      }
      return
    }
    if (op === 'sparseListFiles') {
      const dbPath = msg.dbPath?.trim()
      if (!dbPath) throw new Error('sparseListFiles requires dbPath')
      const store = SparseGrepStore.openDbPath(dbPath)
      try {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
        const status = store.getStatus()
        const syncComplete = store.getMeta('syncComplete') === 'true'
        post({
          id,
          ok: true,
          sparse: {
            kind: 'list',
            ready: status.ready,
            paths: status.ready ? store.listFilePaths() : [],
            fileCount: status.fileCount,
            syncComplete
          }
        })
      } finally {
        store.close()
      }
      return
    }
    throw new Error(`Unknown op: ${String(op)}`)
  } catch (err) {
    post({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    })
  } finally {
    cancelledIds.consume(id)
    if (isRead) {
      activeReadAborts.delete(id)
    } else if (activeRequestId === id) {
      activeRequestId = null
      activeAbort = null
    }
  }
}

const parentPort = process.parentPort
if (!parentPort || typeof parentPort.on !== 'function') {
  throw new Error('embedUtility must run as Electron utilityProcess (missing parentPort)')
}

parentPort.on('message', (event: { data: UtilityRequest }) => {
  const data = event.data
  // Cancel must not wait behind the active job — apply immediately.
  if (data?.op === 'cancel') {
    void handle(data)
    return
  }
  // Read-only ops run off the write chain so grep/search are not blocked by cold sync.
  if (data?.op && READ_OPS.has(data.op)) {
    void handle(data)
    return
  }
  void enqueueWrite(() => handle(data))
})
