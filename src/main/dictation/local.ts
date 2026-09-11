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
import { dictationCatalogEntry, DICTATION_LOCAL_MODEL_IDS } from '../../shared/dictation'
import { getSettings, setSettings } from '../settings/settings'
import {
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
import { getDictationRuntimeStatus, setDictationRuntimeStatus } from './modelStatus'
import {
  getDictationUtilityClient,
  type DictationWhisperBackend
} from './whisperUtilityClient'

let loadedModelId: DictationLocalModelId | null = null
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
  installInFlight = null
  installChain = Promise.resolve()
  testBackend = null
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

function whisperFiles(hubRepo: string): DownloadFileSpec[] {
  return [
    ...DICTATION_WHISPER_REQUIRED_FILES.map((relativePath) => ({
      relativePath,
      url: hfResolve(hubRepo, relativePath)
    })),
    ...DICTATION_WHISPER_OPTIONAL_FILES.map((relativePath) => ({
      relativePath,
      url: hfResolve(hubRepo, relativePath),
      optional: true
    }))
  ]
}

/** Curated download specs for any local dictation model. */
function curatedFiles(modelId: DictationLocalModelId): DownloadFileSpec[] {
  return whisperFiles(dictationCatalogEntry(modelId).hubRepo)
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

export function listInstalledDictationModels(): DictationRuntimeStatus['installed'] {
  const out: DictationRuntimeStatus['installed'] = []
  for (const id of DICTATION_LOCAL_MODEL_IDS) {
    const dir = dictationModelDir(id)
    const files = curatedFiles(id)
    if (!modelFilesPresent(dir, files)) continue
    out.push({
      id,
      bytesOnDisk: dirSizeBytes(dir),
      loaded: loadedModelId === id
    })
  }
  return out
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

async function resolveBackend(): Promise<DictationWhisperBackend> {
  if (testBackend) return testBackend
  const client = getDictationUtilityClient()
  if (!client.isAvailable) {
    throw new Error('Local dictation worker is unavailable')
  }
  return client
}

async function ensureLoaded(modelId: DictationLocalModelId, signal?: AbortSignal): Promise<void> {
  const dir = dictationModelDir(modelId)
  const files = curatedFiles(modelId)
  if (!modelFilesPresent(dir, files)) {
    throw new Error('Install a local Whisper model in Settings → Voice to use dictation')
  }
  // Always re-establish the worker session: the utility process can die
  // between utterances (abort teardown, crash), and a stale `loadedModelId`
  // must not skip the ensure handshake — transcribe would then reach a fresh
  // worker with no session ("call ensure first"). `ensure` is idempotent when
  // the same model is already loaded, so the repeated call is cheap.
  if (loadedModelId !== modelId) {
    publishStatus({
      phase: 'loading',
      progress: null,
      error: null,
      message: `Loading ${modelId}`,
      activeModelId: modelId
    })
  }
  try {
    const backend = await resolveBackend()
    if (loadedModelId && loadedModelId !== modelId) {
      try {
        await backend.dispose()
      } catch {
        /* ignore */
      }
      loadedModelId = null
    }
    if (signal) await backend.ensure(dir, modelId, signal)
    else await backend.ensure(dir, modelId)
    loadedModelId = modelId
    publishStatus({
      phase: 'ready',
      progress: 1,
      error: null,
      message: 'Ready',
      activeModelId: null
    })
  } catch (err) {
    if (signal?.aborted) {
      loadedModelId = null
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

function resolveLocalModelId(): DictationLocalModelId {
  const installed = listInstalledDictationModels()
  if (installed.length === 0) {
    throw new Error('Install a local Whisper model in Settings → Voice to use dictation')
  }
  const wanted = safeGetSettings().dictation?.localModelId
  if (wanted && installed.some((m) => m.id === wanted)) return wanted
  const rec = recommendedDictationModelId()
  if (installed.some((m) => m.id === rec)) return rec
  return installed[0]!.id
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

export async function transcribeLocalDictation(
  request: DictationTranscribeRequest,
  signal?: AbortSignal
): Promise<DictationTranscribeResult> {
  const pcmB64 = request.pcm16k?.trim()
  if (!pcmB64) {
    throw new Error(
      'Local dictation needs 16 kHz PCM from the microphone. Try again, or switch engine in Settings → Voice.'
    )
  }
  assertPcm16kBase64(pcmB64)
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const modelId = resolveLocalModelId()
  await ensureLoaded(modelId, signal)
  const backend = await resolveBackend()
  const text = (await (signal
    ? backend.transcribe(pcmB64, 16000, signal)
    : backend.transcribe(pcmB64, 16000))).trim()
  if (!text) throw new Error('Dictation returned empty transcript')
  return { text }
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
  const backend = testBackend ?? (getDictationUtilityClient().isAvailable ? getDictationUtilityClient() : null)
  if (backend) {
    try {
      await backend.dispose()
    } catch {
      /* ignore */
    }
  }
  loadedModelId = null
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
  if (loadedModelId === modelId) {
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
