/**
 * Electron utilityProcess entry: Whisper ONNX ASR off the main event loop.
 * Built as `out/main/dictationUtility.js` via electron-vite rollup input.
 *
 * Protocol (parentPort / postMessage):
 *   req:  { id, op: 'ensure'|'transcribe'|'dispose'|'ping', modelDir?, modelId?, pcm16k?, sampleRate? }
 *   res:  { id, ok, error?, text?, modelId? }
 *
 * pcm16k is base64 Int16 LE PCM at 16 kHz. Rebuild Float32Array in this process —
 * do not pass postMessage clones / Buffers / `{ raw }` objects to Whisper.
 */
import { applyOrtThreadEnvHints, buildOrtSessionOptions, resolveOrtIntraOpThreads } from './ortSessionOptions'
import { invokeWhisperAsr, type WhisperAsrFn } from './whisperAudio'

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
}

type AsrPipeline = WhisperAsrFn & {
  dispose?: () => Promise<void> | void
}

type LoadedSession = {
  modelId: string
  asr: AsrPipeline
}

let session: LoadedSession | null = null
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

async function disposeSession(): Promise<void> {
  const current = session
  session = null
  if (!current) return
  try {
    await current.asr.dispose?.()
  } catch {
    /* ignore */
  }
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

  const asr = (await pipeline('automatic-speech-recognition', modelDir, {
    local_files_only: true,
    dtype: 'q8',
    session_options: buildOrtSessionOptions(undefined, 'utility')
  })) as AsrPipeline

  return { modelId, asr }
}

async function handle(msg: UtilityRequest): Promise<void> {
  const { id, op } = msg
  try {
    switch (op) {
      case 'ping':
        post({ id, ok: true, modelId: session?.modelId })
        return
      case 'dispose':
        await disposeSession()
        post({ id, ok: true })
        return
      case 'ensure': {
        const modelDir = msg.modelDir?.trim()
        const modelId = msg.modelId?.trim()
        if (!modelDir || !modelId) throw new Error('ensure requires modelDir and modelId')
        if (session?.modelId === modelId) {
          post({ id, ok: true, modelId: session.modelId })
          return
        }
        await disposeSession()
        session = await loadSession(modelDir, modelId)
        post({ id, ok: true, modelId: session.modelId })
        return
      }
      case 'transcribe': {
        if (!session) throw new Error('Whisper session not loaded — call ensure first')
        if (typeof msg.pcm16k !== 'string' || !msg.pcm16k.trim()) {
          throw new Error('transcribe requires pcm16k')
        }
        const text = await invokeWhisperAsr(session.asr, msg.pcm16k)
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
