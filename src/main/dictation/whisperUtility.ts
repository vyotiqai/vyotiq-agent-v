/**
 * Electron utilityProcess entry: Whisper ONNX ASR off the main event loop.
 * Built as `out/main/dictationUtility.js` via electron-vite rollup input.
 *
 * Protocol (parentPort / postMessage):
 *   req:  { id, op: 'ensure'|'transcribe'|'dispose'|'ping', modelDir?, modelId?, pcm16k?, sampleRate? }
 *   res:  { id, ok, error?, text?, modelId?, loaded? }
 *
 * Up to two models stay loaded: the one a take's words come from, and a
 * faster one that drafts live words while you speak. `transcribe` names the
 * model; without one it uses the last one ensured.
 *
 * pcm16k is base64 Int16 LE PCM at 16 kHz. Rebuild Float32Array in this process —
 * do not pass postMessage clones / Buffers / `{ raw }` objects to Whisper.
 */
import { DICTATION_LOCAL_CATALOG, type DictationLocalBackend } from '../../shared/dictation'
import { applyOrtThreadEnvHints, buildOrtSessionOptions, resolveOrtIntraOpThreads } from './ortSessionOptions'
import { invokeAsr, type WhisperAsrFn } from './whisperAudio'

type UtilityOp = 'ensure' | 'transcribe' | 'dispose' | 'ping'

type UtilityRequest = {
  id: number
  op: UtilityOp
  modelDir?: string
  modelId?: string
  /** Base64 Int16 little-endian PCM at 16 kHz. */
  pcm16k?: string
  sampleRate?: number
}

type UtilityResponse = {
  id: number
  ok: boolean
  error?: string
  text?: string
  modelId?: string
  /** Every model loaded after this request, least recently used first. */
  loaded?: string[]
}

/** The chosen model plus a drafter. A third evicts the least recently used. */
const MAX_SESSIONS = 2

type AsrPipeline = WhisperAsrFn & {
  dispose?: () => Promise<void> | void
}

type LoadedSession = {
  modelId: string
  backend: DictationLocalBackend
  asr: AsrPipeline
}

function backendOf(modelId: string): DictationLocalBackend {
  return DICTATION_LOCAL_CATALOG.find((m) => m.id === modelId)?.backend ?? 'whisper'
}

/** Insertion order is recency: a use moves the model to the end. */
const sessions = new Map<string, LoadedSession>()
let lastEnsured: string | null = null
let writeChain: Promise<void> = Promise.resolve()

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

async function disposeOne(current: LoadedSession): Promise<void> {
  try {
    await current.asr.dispose?.()
  } catch {
    /* ignore */
  }
}

async function disposeAll(): Promise<void> {
  const all = [...sessions.values()]
  sessions.clear()
  lastEnsured = null
  for (const s of all) await disposeOne(s)
}

function touch(modelId: string): LoadedSession | null {
  const s = sessions.get(modelId)
  if (!s) return null
  sessions.delete(modelId)
  sessions.set(modelId, s)
  return s
}

function loadedIds(): string[] {
  return [...sessions.keys()]
}

async function loadSession(modelDir: string, modelId: string): Promise<LoadedSession> {
  const intra = resolveOrtIntraOpThreads(undefined, 'utility')
  applyOrtThreadEnvHints(intra)
  const transformers = await import('@huggingface/transformers')
  const { env, pipeline } = transformers
  env.allowLocalModels = true
  env.allowRemoteModels = false
  env.useBrowserCache = false
  ;(env as { cacheDir?: string }).cacheDir = modelDir

  const backend = backendOf(modelId)
  const asr = (await pipeline('automatic-speech-recognition', modelDir, {
    local_files_only: true,
    dtype: backend === 'moonshine' ? { encoder_model: 'fp32', decoder_model_merged: 'q8' } : 'q8',
    session_options: buildOrtSessionOptions(undefined, 'utility')
  })) as AsrPipeline

  return { modelId, backend, asr }
}

async function handle(msg: UtilityRequest): Promise<void> {
  const { id, op } = msg
  try {
    switch (op) {
      case 'ping':
        post({ id, ok: true, modelId: lastEnsured ?? undefined, loaded: loadedIds() })
        return
      case 'dispose':
        await disposeAll()
        post({ id, ok: true, loaded: [] })
        return
      case 'ensure': {
        const modelDir = msg.modelDir?.trim()
        const modelId = msg.modelId?.trim()
        if (!modelDir || !modelId) throw new Error('ensure requires modelDir and modelId')
        if (!touch(modelId)) {
          while (sessions.size >= MAX_SESSIONS) {
            const [oldestId, oldest] = sessions.entries().next().value as [string, LoadedSession]
            sessions.delete(oldestId)
            await disposeOne(oldest)
          }
          sessions.set(modelId, await loadSession(modelDir, modelId))
        }
        lastEnsured = modelId
        post({ id, ok: true, modelId, loaded: loadedIds() })
        return
      }
      case 'transcribe': {
        const wanted = msg.modelId?.trim() || lastEnsured
        const session = wanted ? touch(wanted) : null
        if (!session) throw new Error('Whisper session not loaded — call ensure first')
        if (typeof msg.pcm16k !== 'string' || !msg.pcm16k.trim()) {
          throw new Error('transcribe requires pcm16k')
        }
        const text = await invokeAsr(session.asr, msg.pcm16k, session.backend)
        post({ id, ok: true, text, modelId: session.modelId })
        return
      }
      default: {
        const _exhaustive: never = op
        throw new Error(`Unknown op: ${String(_exhaustive)}`)
      }
    }
  } catch (err) {
    post({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

const parentPort = process.parentPort
if (!parentPort || typeof parentPort.on !== 'function') {
  throw new Error('dictationUtility must run as Electron utilityProcess (missing parentPort)')
}

parentPort.on('message', (event: { data: UtilityRequest }) => {
  const data = event.data
  if (data?.op === 'ping') {
    void handle(data)
    return
  }
  void enqueueWrite(() => handle(data))
})
