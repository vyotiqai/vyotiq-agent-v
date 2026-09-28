/**
 * Rebuild Whisper-ready Float32 PCM inside the utility process.
 * Electron postMessage / structured clone often turns TypedArrays into
 * Buffer JSON `{ type: 'Buffer', data }`, plain objects, or Node Buffers.
 * Transformers.js WhisperFeatureExtractor requires a real Float32Array.
 */

export type WhisperAsrFn = (
  audio: Float32Array,
  options?: Record<string, unknown>
) => Promise<{ text?: string } | Array<{ text?: string }>>

/**
 * Whisper's positional window is 30 s. Without chunking, transformers.js
 * silently keeps only the first 30 s of audio. Always chunk with a 5 s stride
 * so arbitrarily long dictation is transcribed in full.
 */
export const WHISPER_ASR_OPTIONS = {
  chunk_length_s: 30,
  stride_length_s: 5
} as const

function isBufferJson(value: unknown): value is { type: 'Buffer'; data: number[] } {
  if (value == null || typeof value !== 'object') return false
  const rec = value as { type?: unknown; data?: unknown }
  return rec.type === 'Buffer' && Array.isArray(rec.data)
}

function base64ToBytes(b64: string): Uint8Array {
  const trimmed = b64.trim()
  if (!trimmed) throw new Error('transcribe requires pcm16k')
  const buf = Buffer.from(trimmed, 'base64')
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

function int16LeBytesToFloat32(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength === 0) {
    throw new Error('Dictation audio is empty')
  }
  if (bytes.byteLength % 2 !== 0) {
    throw new Error('Invalid dictation PCM length')
  }
  const samples = bytes.byteLength / 2
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Float32Array(samples)
  for (let i = 0; i < samples; i++) {
    out[i] = view.getInt16(i * 2, true) / 32768
  }
  return out
}

function int16SamplesToFloat32(samples: ArrayLike<number>): Float32Array {
  const n = samples.length
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    out[i] = (samples[i] ?? 0) / 32768
  }
  return out
}

/**
 * Convert Int16 PCM (16 kHz LE) to a freshly allocated Float32Array.
 * Always copies — never returns the input object / Buffer / Int16Array.
 */
export function pcmPayloadToFloat32(pcm: unknown): Float32Array {
  if (typeof pcm === 'string') {
    return int16LeBytesToFloat32(base64ToBytes(pcm))
  }
  if (pcm instanceof Int16Array) {
    return int16SamplesToFloat32(pcm)
  }
  if (pcm instanceof ArrayBuffer) {
    return int16LeBytesToFloat32(new Uint8Array(pcm))
  }
  if (pcm instanceof Uint8Array) {
    return int16LeBytesToFloat32(pcm)
  }
  if (Array.isArray(pcm) && pcm.every((n) => typeof n === 'number')) {
    return int16SamplesToFloat32(pcm)
  }
  if (isBufferJson(pcm)) {
    return int16LeBytesToFloat32(Uint8Array.from(pcm.data))
  }
  throw new Error('transcribe requires pcm16k')
}

export function transcriptText(raw: { text?: string } | Array<{ text?: string }>): string {
  if (Array.isArray(raw)) {
    return raw
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join(' ')
      .trim()
  }
  return typeof raw.text === 'string' ? raw.text.trim() : ''
}

/**
 * sampling_rate is 16 kHz (Whisper). Do not pass a `{ raw }` object to the pipeline.
 * No words is an answer (`''`), not a failure: a take sends pauses and breaths
 * too, and the caller decides what an empty piece means.
 */
export async function invokeWhisperAsr(asr: WhisperAsrFn, pcm: unknown): Promise<string> {
  const audio = pcmPayloadToFloat32(pcm)
  const raw = await asr(audio, { ...WHISPER_ASR_OPTIONS, ...whisperDecodeLimits(audio.length / 16000) })
  return transcriptText(raw)
}

/** Moonshine was trained on clips up to 30 s and has no chunking of its own. */
export const MOONSHINE_MAX_WINDOW_S = 30

/**
 * Moonshine's pipeline allows `floor(seconds) * 6` new tokens by default —
 * none at all under a second. Give it room for fast speech and a little
 * over, and the same n-gram block Whisper gets.
 */
export function moonshineDecodeLimits(seconds: number): { no_repeat_ngram_size: number; max_new_tokens: number } {
  return {
    no_repeat_ngram_size: WHISPER_NO_REPEAT_NGRAM,
    max_new_tokens: Math.ceil(Math.max(seconds, 0) * 6.5) + 6
  }
}

export async function invokeMoonshineAsr(asr: WhisperAsrFn, pcm: unknown): Promise<string> {
  const audio = pcmPayloadToFloat32(pcm)
  const window = MOONSHINE_MAX_WINDOW_S * 16000
  const parts: string[] = []
  // A take's phrases are 12 s at most; a longer clip is cut into windows.
  for (let from = 0; from < audio.length; from += window) {
    const piece = audio.subarray(from, Math.min(audio.length, from + window))
    const raw = await asr(piece, moonshineDecodeLimits(piece.length / 16000))
    const text = transcriptText(raw)
    if (text) parts.push(text)
  }
  return parts.join(' ')
}

export function invokeAsr(asr: WhisperAsrFn, pcm: unknown, backend: 'whisper' | 'moonshine'): Promise<string> {
  return backend === 'moonshine' ? invokeMoonshineAsr(asr, pcm) : invokeWhisperAsr(asr, pcm)
}

/**
 * Whisper Tiny on a clip cut mid-word can loop ("small small small…") until
 * it runs out of tokens. Transformers.js has none of Whisper's own guards
 * (compression-ratio and log-prob fallbacks), but it does have n-gram
 * blocking and a token cap: no 4-token run twice, and no more tokens than
 * fast speech could need. Dictation repeats a four-token phrase within one
 * segment about never; a loop does it at once.
 */
export const WHISPER_NO_REPEAT_NGRAM = 4
/** Fast speech runs ~5 tokens a second with punctuation; this is well past it. */
const TOKENS_PER_SECOND = 8
const TOKEN_FLOOR = 24
/** Whisper's decoder holds 448 positions, a few of them its start tokens. */
const TOKEN_CEILING = 440

export function whisperDecodeLimits(seconds: number): { no_repeat_ngram_size: number; max_new_tokens: number } {
  const perChunk = Math.min(Math.max(seconds, 0), WHISPER_ASR_OPTIONS.chunk_length_s)
  return {
    no_repeat_ngram_size: WHISPER_NO_REPEAT_NGRAM,
    max_new_tokens: Math.min(TOKEN_CEILING, Math.ceil(perChunk * TOKENS_PER_SECOND) + TOKEN_FLOOR)
  }
}
