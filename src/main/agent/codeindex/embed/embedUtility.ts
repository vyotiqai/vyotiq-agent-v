/**
 * Electron utilityProcess entry: MiniLM feature-extraction embeddings off the
 * main event loop. Built as `out/main/embedUtility.js` via electron-vite rollup
 * input (see electron.vite.config.ts).
 *
 * Protocol (parentPort / postMessage, JSON-safe):
 *   req:  { id, op: 'ensure'|'embed'|'dispose'|'ping', modelDir?, texts? }
 *   res:  { id, ok, error?, vecs? }
 *
 * vecs is an array of base64 Float32LE buffers, one per input text, in input
 * order. Mean pooling + L2 normalization, so cosine similarity == dot product.
 */
import { loadEmbedPipeline, type EmbedPipeline } from './pipeline'

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
  vecs?: string[]
}

/** Hard cap per input so a pathological chunk cannot blow the ONNX context. */
const MAX_INPUT_CHARS = 8000

type LoadedSession = {
  modelDir: string
  asr: EmbedPipeline
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
  session = null
}

async function loadSession(modelDir: string): Promise<LoadedSession> {
  return { modelDir, asr: await loadEmbedPipeline(modelDir) }
}

function float32ToBase64(data: Float32Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64')
}

async function handle(msg: UtilityRequest): Promise<void> {
  const { id, op } = msg
  try {
    switch (op) {
      case 'ping':
        post({ id, ok: true })
        return
      case 'dispose':
        await disposeSession()
        post({ id, ok: true })
        return
      case 'ensure': {
        const modelDir = msg.modelDir?.trim()
        if (!modelDir) throw new Error('ensure requires modelDir')
        if (session?.modelDir === modelDir) {
          post({ id, ok: true })
          return
        }
        await disposeSession()
        session = await loadSession(modelDir)
        post({ id, ok: true })
        return
      }
      case 'embed': {
        if (!session) throw new Error('Embedding session not loaded — call ensure first')
        if (!Array.isArray(msg.texts) || msg.texts.length === 0) {
          throw new Error('embed requires a non-empty texts array')
        }
        const vecs: string[] = []
        for (const raw of msg.texts) {
          const text = typeof raw === 'string' ? raw.slice(0, MAX_INPUT_CHARS) : ''
          if (!text.trim()) throw new Error('embed requires non-empty text inputs')
          // Sequential by design: writeChain already serializes ops; keep each
          // pipeline call single-input so output shape stays unambiguous.
          const out = await session.asr(text, { pooling: 'mean', normalize: true })
          if (!(out.data instanceof Float32Array)) {
            throw new Error('Unexpected embedding output type from transformers.js')
          }
          vecs.push(float32ToBase64(out.data))
        }
        post({ id, ok: true, vecs })
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
  throw new Error('embedUtility must run as Electron utilityProcess (missing parentPort)')
}

parentPort.on('message', (event: { data: UtilityRequest }) => {
  const data = event.data
  if (data?.op === 'ping') {
    void handle(data)
    return
  }
  void enqueueWrite(() => handle(data))
})