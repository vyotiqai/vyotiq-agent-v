import { existsSync } from 'fs'
import { isAbortError } from '../../../shared/errors'
import {
  createLocalHashEmbedder,
  createOllamaEmbedder,
  type Embedder,
  type OllamaEmbedOptions
} from './embed'
import {
  createMDenseOnEmbedder,
  createNeuralOnnxEmbedder,
  clearEmbedderFailCache,
  ensureLightOnBootstrapWeights,
  isEmbedderFailCached,
  rememberEmbedderFail,
  mDenseOnWeightsOnDisk,
  neuralWeightsOnDisk,
  type MDenseOnEnsureOptions
} from './mdenseon'
import { createLfm2LlamaCppEmbedder } from './lfm2LlamaCpp'
import { CodeIndexStore, codeindexDbPath } from './store'
import { instanceWorktreeReuseDbPath } from '../indexStoragePaths'
import { syncCodeIndex, type SyncResult } from './sync'
import type { WalkedFile } from '../tools/walk'
import { clearIndexSyncProgress } from './indexProgress'
import { searchCodeIndex, formatSearchHits } from './search'
import type {
  CodebaseSearchHit,
  CodebaseSearchMode,
  CodeIndexEmbedderId,
  IndexStatus
} from './types'
import {
  DEFAULT_EMBED_DIM,
  DEFAULT_MODEL_ID,
  LFM2_EMBEDDING_MODEL_ID,
  LFM2_OLLAMA_MODEL,
  MDENSEON_MODEL_ID,
  denseModelIdsCompatible,
  isHashEmbedderModelId
} from './types'
import { markCodeIndexEmbedder, setCodeIndexRuntimeStatus } from './modelStatus'
import { logger } from '../../../shared/logger'
import { enqueueIndexJob } from '../indexJobQueue'
// Static imports despite the module cycle (workspaceIndex imports this barrel):
// both sides only touch each other's bindings after module evaluation, so the
// cycle is safe and the rollup dynamic/static chunk warning goes away.
import { ensureSparseGrepSynced, SPARSE_GREP_SCAN_CAP } from '../sparsegrep'
import { warmWorkspaceIndexes, workspaceIndexSearchSignal } from '../workspaceIndex'
import {
  canUseIndexSearchUtility,
  canUseIndexSyncUtility,
  getEmbedUtilityClient
} from './embedUtilityClient'

/** Debounce window (ms). */
export const CODEINDEX_SYNC_DEBOUNCE_MS = 1500

export type { CodeChunk, CodebaseSearchHit, CodebaseSearchMode, IndexStatus } from './types'
export type { CodeIndexEmbedderId, CodeIndexRuntimeStatus } from './types'
export { chunkSource } from './chunk'
export { chunkContentHash, sha256Text } from './hash'
export { clsPoolLastHidden, l2NormalizeInPlace } from './onnxEmbed'
export {
  chunkSourceAst,
  treeSitterReady,
  codeindexWasmCandidateDirs,
  resolveCodeindexWasmFile,
  disposeChunkParsers
} from './chunkAst'
export { reciprocalRankFusion } from './rrf'
export {
  createLocalHashEmbedder,
  createOllamaEmbedder,
  tokenizeForEmbed
} from './embed'
export {
  createMDenseOnEmbedder,
  createNeuralOnnxEmbedder,
  ensureMDenseOnModel,
  neuralWeightsOnDisk,
  clearMDenseOnSession,
  clearMDenseOnSessionForTests,
  clearEmbedderFailCache,
  clearEmbedderFailCacheForTests,
  setEmbedderFailCacheTtlMsForTests,
  isEmbedderFailCached,
  mDenseOnWeightsOnDisk,
  ensureLightOnBootstrapWeights
} from './mdenseon'
export { NEURAL_ARTIFACTS, getNeuralArtifact } from './registry'
export { loadGenericOnnxSession } from './onnxGeneric'
export { createLfm2LlamaCppEmbedder, clearLfm2LlamaCppCache } from './lfm2LlamaCpp'
export type { OnnxEmbedSession, MDenseOnEnsureOptions, MDenseOnEmbedderOptions } from './mdenseon'
export {
  DEFAULT_EMBED_DIM,
  DEFAULT_MODEL_ID,
  LFM2_EMBEDDING_MODEL_ID,
  LFM2_EMBEDDING_DIM,
  MDENSEON_MODEL_ID,
  DENSEON_ONNX_MODEL_ID,
  LIGHTON_DENSE_DIM,
  CODE_INDEX_MAX_FILE_BYTES,
  isHashEmbedderModelId,
  isLightOnDenseModelId,
  isNeuralDenseModelId,
  neuralModelFamily,
  denseModelIdsCompatible,
  shouldPreserveIndexedEmbeddings
} from './types'
export { CodeIndexStore, codeindexRoot, sanitizeFtsQuery, ftsQueryTokens, buildChunkFtsText } from './store'
export { syncCodeIndex, INDEX_SCAN_CAP, CODE_INDEX_EMBED_BATCH, CODE_INDEX_RECONCILE_WALK_CAP, embedLengthBucket } from './sync'
export { clearIndexSyncProgress, publishIndexSyncProgress } from './indexProgress'
export { searchCodeIndex, formatSearchHits, codebaseSearchHitPathsFromResult, collectDocsLexicalHits, insertTopK, streamDenseTopK, storeEmbeddingsMatchEmbedder } from './search'
export {
  buildOrtSessionOptions,
  resolveOrtIntraOpThreads
} from './ortSessionOptions'
export { getCodeIndexRuntimeStatus, onCodeIndexRuntimeStatus } from './modelStatus'
export { codeIndexModelsRoot, setCodeIndexModelsRootOverrideForTests } from './modelPaths'
export {
  downloadModelFiles,
  modelFilesPresent,
  denseOnOnnxFiles,
  mDenseOnOnnxFiles,
  lfm2OnnxFiles
} from './modelDownload'
export {
  canUseIndexSearchUtility,
  canUseIndexSyncUtility,
  getEmbedUtilityClient
} from './embedUtilityClient'

type CacheEntry = {
  /** Null when SQLite lives only in utilityProcess (avoid main/utility lock races). */
  store: CodeIndexStore | null
  embedder: Embedder
  workspaceRoot: string
  /** SQLite modelId; may differ from embedder.modelId when hash fallback preserves a neural index. */
  indexModelId: string
}

type ResolvedEmbedder = {
  embedder: Embedder
  usedFallback: boolean
}

const cache = new Map<string, CacheEntry>()

export type CodeIndexOptions = {
  /**
   * Embedder selection. When omitted, uses `codeIndex.embedder` from settings
   * (default mdenseon). Legacy `preferOllama: true` maps to trying ollama only
   * when embedder is unset and forceOllama is set.
   */
  embedderId?: CodeIndexEmbedderId
  /** @deprecated Prefer embedderId / settings.codeIndex.embedder */
  preferOllama?: boolean
  embedder?: Embedder
  dimensions?: number
  /** Optional Ollama client overrides (tests / custom host). */
  ollama?: OllamaEmbedOptions
  /** Skip auto-download of ONNX weights. */
  autoDownload?: boolean
  /** Test inject for mDenseOn ensure. */
  mdenseon?: MDenseOnEnsureOptions
}

function readCodeIndexSettings(): {
  enabled: boolean
  embedder: CodeIndexEmbedderId
  autoDownload: boolean
  ollamaModel: string
  ollamaBaseUrl: string
  lfm2OllamaModel: string
} {
  const inVitest = process.env.VITEST === 'true' || process.env.VITEST === '1'
  try {
    const { getSettings } = require('@main/settings/settings') as typeof import('@main/settings/settings')
    const s = getSettings()
    const ci = s.codeIndex
    return {
      enabled: ci?.enabled !== false,
      embedder: ci?.embedder ?? 'mdenseon',
      // Unit tests must not hit Hugging Face.
      autoDownload: inVitest ? false : ci?.autoDownload !== false,
      ollamaModel: ci?.ollamaModel?.trim() || 'nomic-embed-text',
      ollamaBaseUrl: s.ollamaBaseUrl || 'http://127.0.0.1:11434',
      lfm2OllamaModel: ci?.lfm2OllamaModel?.trim() || LFM2_OLLAMA_MODEL
    }
  } catch {
    return {
      enabled: true,
      embedder: 'mdenseon',
      autoDownload: inVitest ? false : true,
      ollamaModel: 'nomic-embed-text',
      ollamaBaseUrl: 'http://127.0.0.1:11434',
      lfm2OllamaModel: LFM2_OLLAMA_MODEL
    }
  }
}

async function resolveEmbedder(
  opts: CodeIndexOptions & { signal?: AbortSignal } = {}
): Promise<ResolvedEmbedder> {
  if (opts.embedder) return { embedder: opts.embedder, usedFallback: false }

  const settings = readCodeIndexSettings()
  let embedderId: CodeIndexEmbedderId =
    opts.embedderId ??
    (opts.preferOllama === true ? 'ollama' : settings.embedder)

  // Legacy: preferOllama:false with no explicit id → hash (offline tests).
  if (opts.embedderId == null && opts.preferOllama === false) {
    embedderId = 'hash'
  }

  markCodeIndexEmbedder(embedderId)

  if (embedderId === 'hash') {
    setCodeIndexRuntimeStatus({
      phase: 'fallback_hash',
      embedder: 'hash',
      modelId: DEFAULT_MODEL_ID,
      message: 'Using local-hash embedder',
      error: null
    })
    return {
      embedder: createLocalHashEmbedder(opts.dimensions ?? DEFAULT_EMBED_DIM),
      usedFallback: false
    }
  }

  if (embedderId === 'ollama') {
    if (isEmbedderFailCached('ollama')) {
      logger.warn('Ollama embedder unavailable — falling back to local-hash (lexical, non-semantic) embedder', {
        scope: 'codeindex'
      })
      setCodeIndexRuntimeStatus({
        phase: 'fallback_hash',
        embedder: 'hash',
        modelId: DEFAULT_MODEL_ID,
        message: 'Ollama unreachable — using hash',
        error: null
      })
      return {
        embedder: createLocalHashEmbedder(opts.dimensions ?? DEFAULT_EMBED_DIM),
        usedFallback: true
      }
    }
    try {
      const ollama = createOllamaEmbedder({
        ...opts.ollama,
        model: opts.ollama?.model ?? settings.ollamaModel,
        baseUrl: opts.ollama?.baseUrl ?? settings.ollamaBaseUrl
      })
      await ollama.embed(['probe'])
      clearEmbedderFailCache('ollama')
      setCodeIndexRuntimeStatus({
        phase: 'ready',
        embedder: 'ollama',
        modelId: ollama.modelId,
        message: 'Ollama embeddings ready',
        error: null
      })
      return { embedder: ollama, usedFallback: false }
    } catch (err) {
      if (!isAbortError(err) && !opts.signal?.aborted) {
        rememberEmbedderFail('ollama')
      }
      setCodeIndexRuntimeStatus({
        phase: 'fallback_hash',
        embedder: 'hash',
        modelId: DEFAULT_MODEL_ID,
        message: 'Ollama unreachable — using hash',
        error: null
      })
      return {
        embedder: createLocalHashEmbedder(opts.dimensions ?? DEFAULT_EMBED_DIM),
        usedFallback: true
      }
    }
  }

  // lfm2 — LiquidAI LFM2.5-Embedding-350M (2026, 1024-dim, 11 languages).
  // Resolution order (all fully local): user-exported ONNX → Ollama/llama.cpp
  // GGUF → semantic DenseOn fallback. A missing LFM2 never silently drops to the
  // non-semantic hash embedder.
  if (embedderId === 'lfm2') {
    if (isEmbedderFailCached('lfm2')) {
      const fb = await resolveEmbedder({ ...opts, embedderId: 'mdenseon' })
      return { embedder: fb.embedder, usedFallback: true }
    }
    // 1) Local ONNX export (no external server required).
    if (neuralWeightsOnDisk(LFM2_EMBEDDING_MODEL_ID)) {
      setCodeIndexRuntimeStatus({
        phase: 'ready',
        embedder: 'lfm2',
        modelId: LFM2_EMBEDDING_MODEL_ID,
        message: 'Ready (local ONNX)',
        error: null
      })
      return {
        embedder: createNeuralOnnxEmbedder({
          ...opts.mdenseon,
          targetModelId: LFM2_EMBEDDING_MODEL_ID,
          autoDownload: false,
          signal: opts.mdenseon?.signal ?? opts.signal
        }),
        usedFallback: false
      }
    }
    // 2) Bundled llama.cpp (node-llama-cpp) — pulls the GGUF straight from
    //    Hugging Face, no Ollama server and no manual ONNX export required.
    try {
      const llmCpp = await createLfm2LlamaCppEmbedder({ signal: opts.signal })
      clearEmbedderFailCache('lfm2')
      setCodeIndexRuntimeStatus({
        phase: 'ready',
        embedder: 'lfm2',
        modelId: llmCpp.modelId,
        message: 'Ready (llama.cpp / GGUF)',
        error: null
      })
      return { embedder: llmCpp, usedFallback: false }
    } catch (err) {
      if (isAbortError(err) || opts.signal?.aborted) {
        throw err instanceof DOMException ? err : new DOMException('Aborted', 'AbortError')
      }
      logger.warn('LFM2 local ONNX absent and llama.cpp GGUF unavailable — trying Ollama', {
        scope: 'codeindex',
        error: String(err)
      })
    }
    // 3) Ollama server GGUF (optional — only if a local Ollama is running).
    try {
      const ollama = createOllamaEmbedder({
        ...opts.ollama,
        model: settings.lfm2OllamaModel,
        baseUrl: settings.ollamaBaseUrl
      })
      await ollama.embed(['probe'])
      clearEmbedderFailCache('lfm2')
      setCodeIndexRuntimeStatus({
        phase: 'ready',
        embedder: 'lfm2',
        modelId: ollama.modelId,
        message: 'Ready (Ollama GGUF)',
        error: null
      })
      return { embedder: ollama, usedFallback: false }
    } catch (err) {
      if (isAbortError(err) || opts.signal?.aborted) {
        throw err instanceof DOMException ? err : new DOMException('Aborted', 'AbortError')
      }
      logger.warn('LFM2 Ollama GGUF unavailable — falling back to DenseOn', {
        scope: 'codeindex',
        error: String(err)
      })
    }
    // 4) Semantic fallback so the default never degrades to lexical hash.
    const fb = await resolveEmbedder({ ...opts, embedderId: 'mdenseon' })
    setCodeIndexRuntimeStatus({
      phase: fb.usedFallback ? 'fallback_hash' : 'ready',
      embedder: 'lfm2',
      modelId: fb.embedder.modelId,
      message: fb.usedFallback
        ? 'LFM2 unavailable locally — using local hash'
        : 'LFM2 unavailable locally — using LightOn DenseOn',
      error: null
    })
    return { embedder: fb.embedder, usedFallback: true }
  }

  // mdenseon (default) — settings/Vitest autoDownload wins over opts.mdenseon override
  if (isEmbedderFailCached('mdenseon')) {
    logger.warn('LightOn DenseOn ONNX unavailable — falling back to local-hash (lexical, non-semantic) embedder', {
      scope: 'codeindex'
    })
    setCodeIndexRuntimeStatus({
      phase: 'fallback_hash',
      embedder: 'hash',
      modelId: DEFAULT_MODEL_ID,
      message: 'LightOn dense ONNX unavailable — using hash',
      error: null
    })
    return {
      embedder: createLocalHashEmbedder(opts.dimensions ?? DEFAULT_EMBED_DIM),
      usedFallback: true
    }
  }
  const autoDownload = opts.autoDownload ?? settings.autoDownload
  const canInjectSession =
    opts.mdenseon?.createSession != null
  if (!canInjectSession && !autoDownload && !mDenseOnWeightsOnDisk()) {
    logger.warn('No DenseOn weights on disk and autoDownload disabled — falling back to local-hash (lexical, non-semantic) embedder', {
      scope: 'codeindex'
    })
    setCodeIndexRuntimeStatus({
      phase: 'fallback_hash',
      embedder: 'hash',
      modelId: DEFAULT_MODEL_ID,
      message: 'LightOn dense ONNX unavailable — using hash',
      error: null
    })
    return {
      embedder: createLocalHashEmbedder(opts.dimensions ?? DEFAULT_EMBED_DIM),
      usedFallback: true
    }
  }
  setCodeIndexRuntimeStatus({
    phase: 'ready',
    embedder: 'mdenseon',
    modelId: MDENSEON_MODEL_ID,
    message: 'Ready',
    error: null
  })
  return {
    embedder: createMDenseOnEmbedder({
      ...opts.mdenseon,
      autoDownload,
      signal: opts.mdenseon?.signal ?? opts.signal
    }),
    usedFallback: false
  }
}

/** @internal */
export function resolveEmbedderForTests(
  opts: CodeIndexOptions & { signal?: AbortSignal } = {}
): Promise<ResolvedEmbedder> {
  return resolveEmbedder(opts)
}

export function workspaceKey(workspaceRoot: string): string {
  return process.platform === 'win32' ? workspaceRoot.toLowerCase() : workspaceRoot
}

function cacheKey(workspaceRoot: string, modelId: string): string {
  return `${workspaceKey(workspaceRoot)}::${modelId}`
}

const locks = new Map<string, Promise<void>>()

/**
 * Interactive callers must not queue behind a wedged sync indefinitely.
 *
 * The lock is a promise-chain mutex, so a warm job whose `syncCode` RPC sits at
 * the client's 30-minute absolute ceiling holds the slot for that long and an
 * interactive `codebase_search` behind it looks like a hang. Bounding only the
 * *acquire* keeps long-but-honest syncs working (they still hold the lock as
 * long as they need) while a genuinely wedged holder degrades to a clear error.
 */
const INTERACTIVE_LOCK_WAIT_MS = 30_000

export class WorkspaceLockBusyError extends Error {
  readonly workspaceRoot: string
  constructor(workspaceRoot: string, waitedMs: number) {
    super(
      `Codebase index is busy for this workspace (waited ${Math.round(waitedMs / 1000)}s for the current index operation). Retry shortly.`
    )
    this.name = 'WorkspaceLockBusyError'
    this.workspaceRoot = workspaceRoot
  }
}

async function withWorkspaceLock<T>(
  workspaceRoot: string,
  fn: () => Promise<T>,
  opts: { waitTimeoutMs?: number } = {}
): Promise<T> {
  const key = workspaceKey(workspaceRoot)
  const prev = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  locks.set(key, prev.then(() => gate))
  const waitTimeoutMs = opts.waitTimeoutMs ?? 0
  if (waitTimeoutMs > 0) {
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new WorkspaceLockBusyError(workspaceRoot, waitTimeoutMs)),
          waitTimeoutMs
        )
        const onPrev = (): void => {
          clearTimeout(timer)
          resolve()
        }
        void prev.then(onPrev, onPrev)
      })
    } catch (err) {
      // Never acquired, but this slot is already chained into the queue —
      // resolving it is what lets the next waiter proceed at all.
      release()
      throw err
    }
  } else {
    await prev
  }
  try {
    return await fn()
  } finally {
    release()
  }
}

export async function getOrOpenCodeIndex(
  workspaceRoot: string,
  opts: CodeIndexOptions & { signal?: AbortSignal; reuseDbPath?: string } = {}
): Promise<CacheEntry & { store: CodeIndexStore }> {
  const { embedder } = await resolveEmbedder(opts)
  const key = cacheKey(workspaceRoot, embedder.modelId)
  const existing = cache.get(key)
  if (existing?.store) {
    return existing as CacheEntry & { store: CodeIndexStore }
  }
  const wk = workspaceKey(workspaceRoot)
  for (const [k, v] of cache) {
    if (k.startsWith(`${wk}::`)) {
      v.store?.close()
      cache.delete(k)
    }
  }
  const store = CodeIndexStore.open(workspaceRoot, embedder.dimensions, {
    reuseDbPath: opts.reuseDbPath
  })
  const entry: CacheEntry & { store: CodeIndexStore } = {
    store,
    embedder,
    workspaceRoot,
    indexModelId: store.getMeta('modelId') ?? embedder.modelId
  }
  cache.set(key, entry)
  return entry
}

export function closeCodeIndex(workspaceRoot?: string): void {
  const prefix = workspaceRoot == null ? null : `${workspaceKey(workspaceRoot)}::`
  for (const [k, v] of cache) {
    if (prefix == null || k.startsWith(prefix)) {
      v.store?.close()
      cache.delete(k)
    }
  }
}

function embedderKindFor(embedder: Embedder): 'session' | 'hash' | 'ollama' | 'llamacpp' {
  if (isHashEmbedderModelId(embedder.modelId)) {
    return 'hash'
  }
  if (embedder.modelId.startsWith('ollama:')) return 'ollama'
  if (embedder.modelId.startsWith('llmcpp:')) return 'llamacpp'
  return 'session'
}

function ollamaOptsForUtility(
  embedder: Embedder,
  ollama?: OllamaEmbedOptions
): { baseUrl: string; model: string; dimensions: number } | undefined {
  if (embedderKindFor(embedder) !== 'ollama') return undefined
  const settings = readCodeIndexSettings()
  const modelFromId = embedder.modelId.startsWith('ollama:')
    ? embedder.modelId.slice('ollama:'.length)
    : settings.ollamaModel
  return {
    baseUrl: ollama?.baseUrl ?? settings.ollamaBaseUrl,
    model: ollama?.model ?? modelFromId,
    dimensions: ollama?.dimensions ?? embedder.dimensions
  }
}

/** @internal */
export function buildOllamaUtilityOptsForTests(
  embedder: Embedder,
  ollama?: OllamaEmbedOptions
): { baseUrl: string; model: string; dimensions: number } | undefined {
  return ollamaOptsForUtility(embedder, ollama)
}

async function runCodeIndexSync(
  workspaceRoot: string,
  embedder: Embedder,
  signal?: AbortSignal,
  ollama?: OllamaEmbedOptions,
  files?: WalkedFile[],
  preserveNeural?: boolean
): Promise<SyncResult> {
  // All embedder kinds route through the utility child (llamacpp included —
  // the child loads its own llama.cpp context, keeping the native model and
  // VRAM out of main). In-process path = tests / utility unavailable.
  if (canUseIndexSyncUtility()) {
    closeCodeIndex(workspaceRoot)
    const client = getEmbedUtilityClient()
    const kind = embedderKindFor(embedder)
    const reuseDbPath = instanceWorktreeReuseDbPath(workspaceRoot)
    return await client.syncCode({
      workspaceRoot,
      dbPath: codeindexDbPath(workspaceRoot),
      dimensions: embedder.dimensions,
      modelId: embedder.modelId,
      embedderKind: kind,
      ollama: ollamaOptsForUtility(embedder, ollama),
      files,
      preserveNeural,
      reuseDbPath: reuseDbPath ?? undefined,
      signal
    })
  }
  const entry = await getOrOpenCodeIndex(workspaceRoot, {
    embedder,
    signal,
    reuseDbPath: instanceWorktreeReuseDbPath(workspaceRoot) ?? undefined
  })
  if (!entry.store) throw new Error('Code index store unavailable')
  return syncCodeIndex(workspaceRoot, entry.store, entry.embedder, {
    signal,
    files,
    preserveNeural
  })
}

async function runCodeIndexSearch(
  workspaceRoot: string,
  entry: CacheEntry,
  query: string,
  opts: {
    limit?: number
    mode?: CodebaseSearchMode
    signal?: AbortSignal
    ollama?: OllamaEmbedOptions
  }
): Promise<{ hits: CodebaseSearchHit[]; status: IndexStatus }> {
  if (canUseIndexSearchUtility()) {
    closeCodeIndex(workspaceRoot)
    const kind = embedderKindFor(entry.embedder)
    return await getEmbedUtilityClient().searchCode({
      workspaceRoot,
      dbPath: codeindexDbPath(workspaceRoot),
      dimensions: entry.embedder.dimensions,
      modelId: entry.embedder.modelId,
      embedderKind: kind,
      query,
      limit: opts.limit,
      mode: opts.mode,
      ollama: ollamaOptsForUtility(entry.embedder, opts.ollama),
      signal: opts.signal
    })
  }
  const store =
    entry.store ??
    (await getOrOpenCodeIndex(workspaceRoot, { embedder: entry.embedder, signal: opts.signal }))
      .store
  if (!store) throw new Error('Code index store unavailable')
  const hits = await searchCodeIndex(workspaceRoot, store, entry.embedder, query, {
    limit: opts.limit,
    mode: opts.mode,
    signal: opts.signal
  })
  return { hits, status: store.getStatus() }
}

function makeCacheEntry(
  workspaceRoot: string,
  embedder: Embedder,
  store: CodeIndexStore | null,
  indexModelId: string
): CacheEntry {
  return { store, embedder, workspaceRoot, indexModelId }
}

async function ensureCodeIndexSyncedUnlocked(
  workspaceRoot: string,
  opts: CodeIndexOptions & {
    signal?: AbortSignal
    force?: boolean
    files?: WalkedFile[]
    keepIndexingStatus?: boolean
  } = {}
): Promise<{ entry: CacheEntry | null; sync: SyncResult | null; disabled?: boolean }> {
  const settings = readCodeIndexSettings()
  if (!settings.enabled && opts.embedder == null && opts.embedderId == null && opts.preferOllama == null) {
    setCodeIndexRuntimeStatus({
      phase: 'idle',
      message: 'Codebase index disabled',
      error: null,
      indexProgress: null,
      progress: null
    })
    return { entry: null, sync: null, disabled: true }
  }
  const { embedder, usedFallback } = await resolveEmbedder(opts)
  const useUtility = canUseIndexSyncUtility()

  // Weights are acquired here — on the write chain (sync lane) with progress
  // events and a refreshable timeout — never inside a read-lane searchCode
  // RPC (that channel has a hard idle timeout and no progress events).
  // Soft-fail: sync proceeds with the resolved embedder; a hash fallback
  // preserves any existing neural index via preserveNeural. Never for an
  // explicitly selected hash embedder — those users opted out of dense.
  if (!usedFallback && settings.autoDownload && !isHashEmbedderModelId(embedder.modelId)) {
    await ensureLightOnBootstrapWeights({ signal: opts.signal })
  }

  setCodeIndexRuntimeStatus({
    phase: 'indexing',
    message: opts.force ? 'Syncing codebase index' : 'Incremental sync',
    error: null,
    indexProgress: null
  })

  const sync = await runCodeIndexSync(
    workspaceRoot,
    embedder,
    opts.signal,
    opts.ollama,
    opts.files,
    usedFallback
  )
  const indexModelId = sync.status.modelId || embedder.modelId
  const keptNeural =
    usedFallback && Boolean(indexModelId) && !isHashEmbedderModelId(indexModelId)
  if (keptNeural) {
    logger.warn('Keeping existing neural code index; embedder fell back to hash', {
      scope: 'codeindex',
      storeModelId: indexModelId,
      queryModelId: embedder.modelId
    })
  }
  // Keep the DB off main when utilityProcess handles sync/search.
  const entry = useUtility
    ? makeCacheEntry(workspaceRoot, embedder, null, indexModelId)
    : await getOrOpenCodeIndex(workspaceRoot, { ...opts, embedder })
  entry.indexModelId = indexModelId
  if (useUtility) closeCodeIndex(workspaceRoot)
  if (opts.keepIndexingStatus) {
    setCodeIndexRuntimeStatus({
      phase: keptNeural || isHashEmbedderModelId(entry.embedder.modelId) ? 'fallback_hash' : 'indexing',
      modelId: entry.indexModelId,
      message: keptNeural
        ? `Neural embedder unavailable — kept existing index — sparse next…`
        : sync
          ? `Code index synced · ${sync.indexed} updated · ${sync.skipped} skipped — sparse next…`
          : 'Code index synced — sparse next…',
      error: null,
      progress: sync && sync.scanned > 0 ? Math.min(0.7, sync.scanned > 0 ? 0.7 : 0) : 0.7,
      indexProgress: sync
        ? {
            kind: 'code',
            stage: 'done',
            filesDone: sync.scanned,
            filesTotal: sync.scanned,
            indexed: sync.indexed,
            skipped: sync.skipped,
            removed: sync.removed,
            embedChunks: 0,
            currentPath: null
          }
        : null
    })
  } else {
    clearIndexSyncProgress()
    setCodeIndexRuntimeStatus({
      phase: keptNeural || isHashEmbedderModelId(entry.embedder.modelId) ? 'fallback_hash' : 'ready',
      modelId: entry.indexModelId,
      message: keptNeural
        ? `Neural embedder unavailable — kept ${indexModelId} (lexical search)`
        : sync
          ? `Index ready · ${sync.indexed} updated · ${sync.skipped} skipped`
          : 'Index ready',
      error: null,
      progress: 1,
      indexProgress: sync
        ? {
            kind: 'code',
            stage: 'done',
            filesDone: sync.scanned,
            filesTotal: sync.scanned,
            indexed: sync.indexed,
            skipped: sync.skipped,
            removed: sync.removed,
            embedChunks: 0,
            currentPath: null
          }
        : null
    })
  }
  return { entry, sync }
}

export async function ensureCodeIndexSynced(
  workspaceRoot: string,
  opts: CodeIndexOptions & {
    signal?: AbortSignal
    force?: boolean
    files?: WalkedFile[]
    keepIndexingStatus?: boolean
  } = {}
): Promise<{ entry: CacheEntry | null; sync: SyncResult | null; disabled?: boolean }> {
  return withWorkspaceLock(workspaceRoot, () => ensureCodeIndexSyncedUnlocked(workspaceRoot, opts))
}

function schedulePostSearchWarm(workspaceRoot: string): void {
  // Full code+sparse warm after search returns (queued or ready-utility fast path).
  try {
    warmWorkspaceIndexes(workspaceRoot)
  } catch {
    // Same swallow as the previous promise chain — search must never fail on warm.
  }
}

type CodebaseSearchResult = {
  hits: CodebaseSearchHit[]
  status: IndexStatus
  formatted: string
  queryModelId: string
}

/**
 * True when the indexed model cannot serve the query embedder's space: the
 * store holds non-neural (hash) vectors, or holds a *different* neural family.
 * Same-family and same-id stores are compatible and never self-heal.
 */
function indexModelMismatch(statusModelId: string, embedder: Embedder): boolean {
  const stored = statusModelId.trim()
  if (!stored || isHashEmbedderModelId(embedder.modelId)) return false
  return !denseModelIdsCompatible(stored, embedder.modelId)
}

/**
 * Query embedder was explicitly selected (never a silent hash fallback), so a
 * mismatched index can be re-embedded under it: one forced sync, retry once.
 * A fallback embedder must never trigger a destructive re-sync (keptNeural).
 */
function shouldSelfHealIndex(
  usedFallback: boolean,
  status: IndexStatus,
  embedder: Embedder
): boolean {
  return (
    !usedFallback &&
    status.ready &&
    status.chunkCount > 0 &&
    indexModelMismatch(status.modelId, embedder)
  )
}

function formatCodebaseSearchResult(
  hits: CodebaseSearchHit[],
  status: IndexStatus,
  queryModelId: string
): CodebaseSearchResult {
  const formatted =
    hits.length > 0
      ? formatSearchHits(hits)
      : status.ready
        ? formatSearchHits(hits)
        : [
            formatSearchHits(hits),
            'Codebase index is still warming — results may be incomplete. Retry shortly or pass refresh:true.'
          ]
            .filter(Boolean)
            .join('\n')
  return { hits, status, formatted, queryModelId }
}

export async function runCodebaseSearch(
  workspaceRoot: string,
  query: string,
  opts: {
    limit?: number
    mode?: CodebaseSearchMode
    signal?: AbortSignal
    preferOllama?: boolean
    embedderId?: CodeIndexEmbedderId
    refresh?: boolean
  } = {}
): Promise<CodebaseSearchResult> {
  const searchSignal = workspaceIndexSearchSignal(workspaceRoot, opts.signal)
  let skipWarm = false

  const runQueuedInteractiveSearch = (runOpts: { forceResync?: boolean } = {}): Promise<CodebaseSearchResult> =>
    enqueueIndexJob({
      priority: 'interactive',
      signal: searchSignal,
      run: () =>
        withWorkspaceLock(
          workspaceRoot,
          async () => {
          const disabledResult: CodebaseSearchResult = {
            hits: [],
            status: {
              ready: false,
              modelId: '',
              fileCount: 0,
              chunkCount: 0,
              lastIndexedAt: null
            },
            formatted: 'Codebase index is disabled (Settings → Indexing).',
            queryModelId: ''
          }
          // refresh=true forces a sync in this slot. Otherwise serve whatever is
          // already indexed and enqueue a warm sync after we release the queue —
          // a cold full sync inside interactive would starve every later search.
          // forceResync (self-heal from the fast path) takes the same slot.
          if (opts.refresh === true || runOpts.forceResync === true) {
            const { entry, disabled } = await ensureCodeIndexSyncedUnlocked(workspaceRoot, {
              signal: searchSignal,
              preferOllama: opts.preferOllama,
              embedderId: opts.embedderId,
              force: true
            })
            if (disabled || !entry) {
              skipWarm = true
              return disabledResult
            }
            const { hits, status } = await runCodeIndexSearch(workspaceRoot, entry, query, {
              limit: opts.limit,
              mode: opts.mode,
              signal: searchSignal
            })
            return {
              hits,
              status,
              formatted: formatSearchHits(hits),
              queryModelId: entry.embedder.modelId
            }
          }

          const settings = readCodeIndexSettings()
          if (!settings.enabled && opts.preferOllama == null && opts.embedderId == null) {
            skipWarm = true
            return disabledResult
          }

          const { embedder, usedFallback } = await resolveEmbedder({
            preferOllama: opts.preferOllama,
            embedderId: opts.embedderId
          })
          const useUtility = canUseIndexSyncUtility()
          const entry = useUtility
            ? makeCacheEntry(workspaceRoot, embedder, null, embedder.modelId)
            : await getOrOpenCodeIndex(workspaceRoot, {
                embedder,
                signal: searchSignal,
                preferOllama: opts.preferOllama,
                embedderId: opts.embedderId
              })
          if (useUtility) closeCodeIndex(workspaceRoot)

          const { hits, status } = await runCodeIndexSearch(workspaceRoot, entry, query, {
            limit: opts.limit,
            mode: opts.mode,
            signal: searchSignal
          })
          if (!status.ready && status.chunkCount === 0) {
            const { sync, entry: syncedEntry } = await ensureCodeIndexSyncedUnlocked(workspaceRoot, {
              signal: searchSignal,
              preferOllama: opts.preferOllama,
              embedderId: opts.embedderId,
              force: true
            })
            if (sync) {
              const searchEntry = syncedEntry ?? entry
              const retried = await runCodeIndexSearch(workspaceRoot, searchEntry, query, {
                limit: opts.limit,
                mode: opts.mode,
                signal: searchSignal
              })
              return {
                hits: retried.hits,
                status: retried.status,
                formatted: formatSearchHits(retried.hits),
                queryModelId: searchEntry.embedder.modelId
              }
            }
          }

          // Self-heal: ready store indexed under a different non-fallback embedder.
          // Inline (we already hold the workspace lock) — never re-enqueue from
          // inside a running job.
          if (shouldSelfHealIndex(usedFallback, status, embedder)) {
            const { entry: healedEntry } = await ensureCodeIndexSyncedUnlocked(workspaceRoot, {
              signal: searchSignal,
              preferOllama: opts.preferOllama,
              embedderId: opts.embedderId,
              force: true
            })
            const searchEntry = healedEntry ?? entry
            const retried = await runCodeIndexSearch(workspaceRoot, searchEntry, query, {
              limit: opts.limit,
              mode: opts.mode,
              signal: searchSignal
            })
            return {
              hits: retried.hits,
              status: retried.status,
              formatted: formatSearchHits(retried.hits),
              queryModelId: searchEntry.embedder.modelId
            }
          }

          return formatCodebaseSearchResult(hits, status, entry.embedder.modelId)
          },
          { waitTimeoutMs: INTERACTIVE_LOCK_WAIT_MS }
        )
    })

  const indexingOn =
    readCodeIndexSettings().enabled || opts.preferOllama != null || opts.embedderId != null
  // Ready utility search is a READ_OPS handle off the write chain; skip the
  // global concurrency-1 slot so parallel codebase_search calls can overlap.
  // refresh / disabled / missing DB / empty cold store stay queued.
  if (
    opts.refresh !== true &&
    indexingOn &&
    canUseIndexSearchUtility() &&
    existsSync(codeindexDbPath(workspaceRoot))
  ) {
    try {
      const { embedder, usedFallback } = await resolveEmbedder({
        preferOllama: opts.preferOllama,
        embedderId: opts.embedderId
      })
      const entry = makeCacheEntry(workspaceRoot, embedder, null, embedder.modelId)
      closeCodeIndex(workspaceRoot)
      const { hits, status } = await runCodeIndexSearch(workspaceRoot, entry, query, {
        limit: opts.limit,
        mode: opts.mode,
        signal: searchSignal
      })
      if (status.ready || status.chunkCount !== 0) {
        // Self-heal: the ready store was indexed under a different (non-fallback)
        // embedder — re-embed once in this slot, then retry the search. Cold or
        // fallback cases keep their existing paths below.
        if (shouldSelfHealIndex(usedFallback, status, embedder)) {
          const healed = await runQueuedInteractiveSearch({ forceResync: true })
          if (!skipWarm) {
            schedulePostSearchWarm(workspaceRoot)
          }
          return healed
        }
        const result = formatCodebaseSearchResult(hits, status, entry.embedder.modelId)
        if (!skipWarm) {
          schedulePostSearchWarm(workspaceRoot)
        }
        return result
      }
      // !ready && chunkCount === 0: cold sync stays inside enqueueIndexJob.
    } catch (err) {
      if (isAbortError(err) || searchSignal.aborted) throw err
      // busy/locked/missing store — same queued path as today, no extra retry.
    }
  }

  const result = await runQueuedInteractiveSearch()
  if (!skipWarm) {
    schedulePostSearchWarm(workspaceRoot)
  }
  return result
}

export function disposeCodeIndexWorkspace(workspaceRoot: string): void {
  closeCodeIndex(workspaceRoot)
}

/** Force reindex for active settings (settings UI). */
export async function reindexCodeIndex(
  workspaceRoot: string,
  opts: { signal?: AbortSignal; embedderId?: CodeIndexEmbedderId } = {}
): Promise<SyncResult | null> {
  const key = workspaceKey(workspaceRoot)
  return enqueueIndexJob({
    priority: 'reindex',
    coalesceKey: `reindex:${key}`,
    signal: opts.signal,
    run: async () => {
      clearEmbedderFailCache()
      const { sync } = await ensureCodeIndexSynced(workspaceRoot, {
        force: true,
        signal: opts.signal,
        embedderId: opts.embedderId
      })
      await ensureSparseGrepSynced(workspaceRoot, {
        force: true,
        signal: opts.signal,
        pageCap: SPARSE_GREP_SCAN_CAP
      })
      return sync
    }
  })
}
