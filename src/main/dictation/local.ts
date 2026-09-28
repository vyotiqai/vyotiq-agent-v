import { existsSync, readdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import {
  DEFAULT_SETTINGS,
  MAX_LOCAL_AUDIO_BYTES,
  type DictationLocalModelId,
  type DictationRuntimeStatus,
  type DictationTranscribeRequest,
  type DictationTranscribeResult,
  type Settings
} from '../../shared/ipc'
import { DICTATION_LOCAL_CATALOG, dictationCatalogEntry, DICTATION_LOCAL_MODEL_IDS } from '../../shared/dictation'
import { getSettings, setSettings } from '../settings/settings'
import {
  DICTATION_MOONSHINE_OPTIONAL_FILES,
  DICTATION_MOONSHINE_REQUIRED_FILES,
  DICTATION_WHISPER_OPTIONAL_FILES,
  DICTATION_WHISPER_REQUIRED_FILES,
  recommendedDictationModelId
} from './catalog'
import {
  downloadDictationModelFiles,
  hfResolve,
  modelFilesPresent,
  type DownloadFileSpec
} from './download'
import { dictationModelDir } from './modelPaths'
import { DictationError } from './errors'
import { getDictationRuntimeStatus, setDictationRuntimeStatus } from './modelStatus'
import {
  getDictationUtilityClient,
  shutdownDictationUtilityClients,
  type DictationWhisperBackend,
  type DictationWorkerRole
} from './whisperUtilityClient'

/**
 * Loaded models go after this long without a take: both workers hold a few
 * hundred MB, and someone who dictated once this morning should get it back.
 * Loading again costs a couple of seconds, while the mic opens.
 */
export const DICTATION_IDLE_UNLOAD_MS = 15 * 60_000
let idleTimer: ReturnType<typeof setTimeout> | null = null
let transcribesInFlight = 0

/** How long a call takes on this PC, per model, smoothed — Voice settings shows it. */
const callMsByModel = new Map<DictationLocalModelId, number>()

/** The model a take's words come from, once loaded. */
let loadedModelId: DictationLocalModelId | null = null
/**
 * What each worker holds, least recently used first. The final worker has the
 * chosen model; the draft worker has the faster one live words come from
 * (only when that is a different model). Mirrors each worker's two-slot
 * eviction.
 */
let loadedByRole: Record<DictationWorkerRole, DictationLocalModelId[]> = { final: [], draft: [] }
const MAX_LOADED = 2
let installInFlight: DictationLocalModelId | null = null
let installChain: Promise<void> = Promise.resolve()
let testBackend: DictationWhisperBackend | null = null

export function setDictationWhisperBackendForTests(
  backend: DictationWhisperBackend | null
): void {
  testBackend = backend
}

export function resetDictationLocalStateForTests(): void {
  loadedModelId = null
  loadedByRole = { final: [], draft: [] }
  installInFlight = null
  installChain = Promise.resolve()
  testBackend = null
  clearIdleUnload()
  transcribesInFlight = 0
  callMsByModel.clear()
}

function clearIdleUnload(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
}

/** (Re)start the idle clock; any load or take pushes the unload back. */
function armIdleUnload(): void {
  clearIdleUnload()
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (installInFlight || transcribesInFlight > 0) {
      armIdleUnload()
      return
    }
    if (loadedByRole.final.length === 0 && loadedByRole.draft.length === 0) return
    void unloadIdleDictation()
  }, DICTATION_IDLE_UNLOAD_MS)
  idleTimer.unref?.()
}

async function unloadIdleDictation(): Promise<void> {
  try {
    await unloadDictationModel()
    // The worker processes too: an idle Node runtime with ORT loaded still holds memory.
    if (!testBackend) await shutdownDictationUtilityClients()
  } catch {
    /* the next take loads again either way */
  }
}

function safeGetSettings(): Settings {
  try {
    return getSettings()
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

function patchDictationLocalModelId(localModelId: Settings['dictation']['localModelId']): void {
  const current = getSettings().dictation
  if (current.localModelId === localModelId) return
  setSettings({ dictation: { ...current, localModelId } })
}

function specs(
  hubRepo: string,
  required: readonly string[],
  optional: readonly string[]
): DownloadFileSpec[] {
  return [
    ...required.map((relativePath) => ({ relativePath, url: hfResolve(hubRepo, relativePath) })),
    ...optional.map((relativePath) => ({ relativePath, url: hfResolve(hubRepo, relativePath), optional: true }))
  ]
}

function whisperFiles(hubRepo: string): DownloadFileSpec[] {
  return specs(hubRepo, DICTATION_WHISPER_REQUIRED_FILES, DICTATION_WHISPER_OPTIONAL_FILES)
}

/** Curated download specs for any local dictation model. */
function curatedFiles(modelId: DictationLocalModelId): DownloadFileSpec[] {
  const entry = dictationCatalogEntry(modelId)
  return entry.backend === 'moonshine'
    ? specs(entry.hubRepo, DICTATION_MOONSHINE_REQUIRED_FILES, DICTATION_MOONSHINE_OPTIONAL_FILES)
    : whisperFiles(entry.hubRepo)
}

function normalizeHubRelativePath(raw: string): string {
  return raw.replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

/** Skip timestamped Whisper ONNX (q8 is broken) and full-precision weights. */
export function isSkippedDictationHubFile(relativePath: string): boolean {
  const p = normalizeHubRelativePath(relativePath).toLowerCase()
  if (!p) return true
  if (p.includes('..') || p.startsWith('/') || /^[a-z]:\//.test(p)) return true
  if (p.includes('timestamped')) return true
  if (p.endsWith('.onnx') && !/(quantized|_q8|_int8|_uint8)/i.test(p)) return true
  return false
}

/**
 * Curated q8 files are always required. Registry extras are optional so a 404
 * cannot fail install; timestamped / fp32 ONNX are dropped.
 */
export function selectDictationDownloadFiles(
  hubRepo: string,
  registryPaths?: readonly string[] | null
): DownloadFileSpec[] {
  const curated = whisperFiles(hubRepo)
  if (!registryPaths || registryPaths.length === 0) return curated
  const byPath = new Map(curated.map((f) => [f.relativePath, f]))
  for (const raw of registryPaths) {
    const relativePath = normalizeHubRelativePath(raw)
    if (!relativePath || isSkippedDictationHubFile(relativePath)) continue
    if (byPath.has(relativePath)) continue
    byPath.set(relativePath, {
      relativePath,
      url: hfResolve(hubRepo, relativePath),
      optional: true
    })
  }
  return [...byPath.values()]
}

async function resolveWhisperFiles(modelId: DictationLocalModelId): Promise<DownloadFileSpec[]> {
  const entry = dictationCatalogEntry(modelId)
  // The registry lists every dtype of Moonshine's files; the curated set is the one it runs.
  if (entry.backend === 'moonshine') return curatedFiles(modelId)
  if (process.env.VITEST === 'true' || process.env.VITEST === '1') {
    return selectDictationDownloadFiles(entry.hubRepo)
  }
  try {
    const { ModelRegistry } = await import('@huggingface/transformers')
    const listed = await ModelRegistry.get_pipeline_files(
      'automatic-speech-recognition',
      entry.hubRepo,
      { dtype: 'q8' }
    )
    if (Array.isArray(listed) && listed.length > 0) {
      const paths = listed.filter((p): p is string => typeof p === 'string' && p.length > 0)
      if (paths.length > 0) {
        return selectDictationDownloadFiles(entry.hubRepo, paths)
      }
    }
  } catch {
    /* fallback to the curated q8 file list */
  }
  return selectDictationDownloadFiles(entry.hubRepo)
}

function dirSizeBytes(dir: string): number {
  if (!existsSync(dir)) return 0
  let total = 0
  const walk = (p: string): void => {
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>
    try {
      entries = readdirSync(p, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(p, e.name)
      if (e.isDirectory()) {
        walk(full)
      } else if (e.isFile() && !e.name.endsWith('.partial')) {
        try {
          total += statSync(full).size
        } catch {
          /* ignore */
        }
      }
    }
  }
  walk(dir)
  return total
}

function markLoaded(role: DictationWorkerRole, id: DictationLocalModelId): void {
  const list = [...loadedByRole[role].filter((m) => m !== id), id]
  while (list.length > MAX_LOADED) list.shift()
  loadedByRole = { ...loadedByRole, [role]: list }
  if (loadedModelId && !loadedByRole.final.includes(loadedModelId)) loadedModelId = null
}

function isLoaded(id: DictationLocalModelId): boolean {
  return loadedByRole.final.includes(id) || loadedByRole.draft.includes(id)
}

/** Models with every file on disk — no sizes, so it is cheap enough for every request. */
function installedModelIds(): DictationLocalModelId[] {
  return DICTATION_LOCAL_MODEL_IDS.filter((id) => modelFilesPresent(dictationModelDir(id), curatedFiles(id)))
}

export function listInstalledDictationModels(): DictationRuntimeStatus['installed'] {
  return installedModelIds().map((id) => ({
    id,
    bytesOnDisk: dirSizeBytes(dictationModelDir(id)),
    loaded: isLoaded(id),
    callMs: callMsByModel.has(id) ? Math.round(callMsByModel.get(id)!) : null
  }))
}

function publishStatus(
  partial: Parameters<typeof setDictationRuntimeStatus>[0] = {}
): DictationRuntimeStatus {
  setDictationRuntimeStatus({
    ...partial,
    installed: listInstalledDictationModels(),
    recommendedModelId: recommendedDictationModelId(),
    engine: safeGetSettings().dictation?.engine ?? 'openai',
    loadedModelId
  })
  return getDictationRuntimeStatus()
}

export function readDictationRuntimeStatus(): DictationRuntimeStatus {
  return publishStatus()
}

async function resolveBackend(role: DictationWorkerRole = 'final'): Promise<DictationWhisperBackend> {
  if (testBackend) return testBackend
  const client = getDictationUtilityClient(role)
  if (!client.isAvailable) {
    throw new DictationError('engine_failed', 'Whisper could not start on this PC')
  }
  return client
}

/**
 * `draft`: the model only drafts live words for a take. It loads without
 * showing in Voice settings — "Loading Whisper Tiny" there would read as the
 * chosen model changing.
 */
async function ensureLoaded(
  modelId: DictationLocalModelId,
  signal?: AbortSignal,
  opts: { draft?: boolean } = {}
): Promise<void> {
  const dir = dictationModelDir(modelId)
  const files = curatedFiles(modelId)
  if (!modelFilesPresent(dir, files)) {
    throw new DictationError('model_missing', 'Install a Whisper model to dictate on this PC')
  }
  // Always re-establish the worker session: the utility process can die
  // between utterances (abort teardown, crash), and a stale `loadedByRole` must
  // not skip the ensure handshake — transcribe would then reach a fresh
  // worker with no session ("call ensure first"). `ensure` is idempotent when
  // the model is already loaded, so the repeated call is cheap. Status is
  // only published when something changes: a take sends a request every
  // second or so, and each publish walks the model folders and messages
  // every window.
  const role: DictationWorkerRole = opts.draft ? 'draft' : 'final'
  const wasLoaded = loadedByRole[role].includes(modelId) && (opts.draft || loadedModelId === modelId)
  if (!wasLoaded && !opts.draft) {
    publishStatus({
      phase: 'loading',
      progress: null,
      error: null,
      message: `Loading ${modelId}`,
      activeModelId: modelId
    })
  }
  try {
    const backend = await resolveBackend(role)
    if (signal) await backend.ensure(dir, modelId, signal)
    else await backend.ensure(dir, modelId)
    markLoaded(role, modelId)
    if (!opts.draft) loadedModelId = modelId
    armIdleUnload()
    if (!wasLoaded && !opts.draft) {
      publishStatus({
        phase: 'ready',
        progress: 1,
        error: null,
        message: 'Ready',
        activeModelId: null
      })
    } else if (!wasLoaded) {
      // The drafter holds memory too: Voice settings marks it loaded (and
      // offers Unload) without a loading phase for it.
      publishStatus()
    }
  } catch (err) {
    if (opts.draft) throw err
    if (signal?.aborted) {
      loadedModelId = null
      loadedByRole = { ...loadedByRole, final: [] }
      const installed = listInstalledDictationModels()
      publishStatus({
        phase: installed.length > 0 ? 'ready' : 'idle',
        progress: null,
        error: null,
        message: installed.length > 0 ? 'Ready · on disk' : 'Idle',
        activeModelId: null
      })
      throw err
    }
    const msg = err instanceof Error ? err.message : String(err)
    publishStatus({
      phase: 'error',
      error: msg,
      message: `Failed: ${modelId}`,
      activeModelId: modelId
    })
    throw err
  }
}

function resolveLocalModelId(installed: DictationLocalModelId[] = installedModelIds()): DictationLocalModelId {
  if (installed.length === 0) {
    throw new DictationError('model_missing', 'Install a Whisper model to dictate on this PC')
  }
  const wanted = safeGetSettings().dictation?.localModelId
  if (wanted && installed.includes(wanted)) return wanted
  const rec = recommendedDictationModelId()
  if (installed.includes(rec)) return rec
  return installed[0]!
}

/** The model a take's final words come from, or null with none on disk. */
export function dictationFinalModelId(): DictationLocalModelId | null {
  try {
    return resolveLocalModelId()
  } catch {
    return null
  }
}

/**
 * The model that drafts live words: the fast one when it is on disk, since
 * Whisper pads every call to 30 s of audio — Small takes ~2 s a call on a
 * laptop CPU whatever the length, Tiny ~0.5 s. Without it, the chosen model
 * drafts too, just less often.
 */
export function draftDictationModelId(
  finalId: DictationLocalModelId,
  installed: DictationLocalModelId[] = installedModelIds()
): DictationLocalModelId {
  const fast = DICTATION_LOCAL_CATALOG.find((m) => m.role === 'fast' && installed.includes(m.id))
  return fast?.id ?? finalId
}

/**
 * Load what a take on this PC will use before its first words arrive: the
 * chosen model and the drafter. Called as the mic opens, so the load overlaps
 * it instead of delaying the first words.
 */
export async function prepareLocalDictation(): Promise<void> {
  const installed = installedModelIds()
  if (installed.length === 0) return
  const finalId = resolveLocalModelId(installed)
  const draftId = draftDictationModelId(finalId, installed)
  await ensureLoaded(finalId)
  if (draftId !== finalId) await ensureLoaded(draftId, undefined, { draft: true })
}

/**
 * Whisper names what it hears when there are no words — `[BLANK_AUDIO]`,
 * `(wind blowing)` — and those must not land in a brief as text.
 */
export function cleanWhisperText(raw: string): string {
  return raw
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/^\s*\([^)]*\)\s*$/, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function assertPcm16kBase64(b64: string): void {
  let bytes: Buffer
  try {
    bytes = Buffer.from(b64, 'base64')
  } catch {
    throw new Error('Invalid dictation PCM encoding')
  }
  if (bytes.byteLength === 0) {
    throw new Error('Dictation audio is empty')
  }
  if (bytes.byteLength > MAX_LOCAL_AUDIO_BYTES) {
    throw new Error(`Dictation audio exceeds ${MAX_LOCAL_AUDIO_BYTES} bytes`)
  }
  if (bytes.byteLength % 2 !== 0) {
    throw new Error('Invalid dictation PCM length')
  }
}

/**
 * Whisper pads every call to 30 s of audio, so one call costs about the same
 * whatever was said: a smoothed time per call is what a phrase costs here.
 * Status goes out on the first timing only — after that Settings reads it
 * when it opens.
 */
function noteCallMs(modelId: DictationLocalModelId, ms: number): void {
  const prev = callMsByModel.get(modelId)
  callMsByModel.set(modelId, prev == null ? ms : prev * 0.7 + ms * 0.3)
  if (prev == null) publishStatus()
}

export async function transcribeLocalDictation(
  request: DictationTranscribeRequest,
  signal?: AbortSignal
): Promise<DictationTranscribeResult> {
  const pcmB64 = request.pcm16k?.trim()
  if (!pcmB64) {
    throw new DictationError('engine_failed', 'Whisper on this PC needs audio from the microphone, not a file')
  }
  assertPcm16kBase64(pcmB64)
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const installed = installedModelIds()
  const finalId = resolveLocalModelId(installed)
  const modelId = request.draft ? draftDictationModelId(finalId, installed) : finalId
  const provisional = modelId !== finalId
  let raw: string
  transcribesInFlight++
  try {
    await ensureLoaded(modelId, signal, { draft: provisional })
    const backend = await resolveBackend(provisional ? 'draft' : 'final')
    const startedAt = Date.now()
    try {
      raw = await backend.transcribe(pcmB64, 16000, signal, modelId)
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) throw err
      const msg = err instanceof Error ? err.message : String(err)
      throw new DictationError('engine_failed', `Whisper stopped: ${msg}`)
    }
    noteCallMs(modelId, Date.now() - startedAt)
  } finally {
    transcribesInFlight--
    armIdleUnload()
  }
  const text = cleanWhisperText(raw)
  if (!text && request.allowEmpty !== true) {
    throw new DictationError('engine_failed', 'Nothing was heard in that take')
  }
  return provisional ? { text, provisional: true } : { text }
}

export async function installDictationModel(
  modelId: DictationLocalModelId,
  opts: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {}
): Promise<DictationRuntimeStatus> {
  const run = installChain.then(async () => {
    if (installInFlight) {
      throw new Error('A dictation model is already downloading')
    }
    installInFlight = modelId
    try {
      const dir = dictationModelDir(modelId)
      const files = await resolveWhisperFiles(modelId)
      publishStatus({
        phase: 'downloading',
        progress: 0,
        error: null,
        message: `Installing ${modelId}`,
        activeModelId: modelId
      })
      const ok = await downloadDictationModelFiles(dir, files, {
        fetchImpl: opts.fetchImpl,
        signal: opts.signal,
        activeModelId: modelId
      })
      if (!ok) {
        throw new Error(
          getDictationRuntimeStatus().error ?? `Failed to install ${modelId}`
        )
      }
      await ensureLoaded(modelId)
      try {
        patchDictationLocalModelId(modelId)
      } catch {
        /* tests without electron settings */
      }
      return publishStatus({
        phase: 'ready',
        progress: 1,
        error: null,
        message: 'Ready',
        activeModelId: null
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      publishStatus({
        phase: 'error',
        error: msg,
        message: `Failed: ${modelId}`,
        activeModelId: modelId
      })
      throw err
    } finally {
      installInFlight = null
    }
  })
  installChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

export async function unloadDictationModel(): Promise<DictationRuntimeStatus> {
  const backends: DictationWhisperBackend[] = testBackend
    ? [testBackend]
    : (['final', 'draft'] as const)
        .map((role) => getDictationUtilityClient(role))
        .filter((c) => c.isAvailable)
  for (const backend of backends) {
    try {
      await backend.dispose()
    } catch {
      /* ignore */
    }
  }
  loadedModelId = null
  loadedByRole = { final: [], draft: [] }
  clearIdleUnload()
  const installed = listInstalledDictationModels()
  return publishStatus({
    phase: installed.length > 0 ? 'ready' : 'idle',
    progress: null,
    error: null,
    message: installed.length > 0 ? 'Ready · on disk' : 'Idle',
    activeModelId: null
  })
}

export async function deleteDictationModelCache(
  modelId: DictationLocalModelId
): Promise<DictationRuntimeStatus> {
  if (installInFlight === modelId) {
    throw new Error('Cannot delete a model while it is downloading')
  }
  if (isLoaded(modelId)) {
    await unloadDictationModel()
  }
  const dir = dictationModelDir(modelId)
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
  }
  try {
    if (getSettings().dictation.localModelId === modelId) {
      patchDictationLocalModelId('')
    }
  } catch {
    /* tests without electron settings */
  }
  const installed = listInstalledDictationModels()
  return publishStatus({
    phase: installed.length > 0 ? 'ready' : 'idle',
    progress: null,
    error: null,
    message: installed.length > 0 ? 'Ready' : 'Idle',
    activeModelId: null
  })
}
