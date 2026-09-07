/**
 * Qwen3-ASR in-app ONNX Runtime engine (downloadable, like Whisper).
 *
 * The model is NOT loadable by `@huggingface/transformers` (no `qwen3_asr`
 * pipeline), so we run the community ONNX export directly through
 * `onnxruntime-web`. The export contract (see andrewleech/qwen3-asr-0.6b-onnx)
 * is:
 *   - `encoder.onnx`          : log-mel [1,128,T] -> audio features [1,N,hidden]
 *   - `decoder_init.onnx`     : input_ids + audio_features + audio_offset -> logits + KV cache
 *   - `decoder_step.onnx`     : input_embeds + position_ids + past KV -> logits + present KV
 *   - `embed_tokens.bin`      : FP16 token embedding table [vocab, hidden]
 *   - `tokenizer.json`        : Qwen byte-level BPE
 *   - `config.json`           : architecture + mel params + special token ids
 *
 * The orchestration below (`transcribeQwen3AsrOnnxCore`) is intentionally free
 * of any ONNX/tokenizer imports so it can be unit-tested with injected runners.
 */
import { dictationCatalogEntry } from '../../shared/dictation'

export interface Qwen3AsrOnnxConfig {
  encoder: {
    hidden_size: number
    output_dim: number
    num_mel_bins: number
    downsample_factor: number
  }
  decoder: {
    hidden_size: number
    vocab_size: number
    num_layers: number
    num_key_value_heads: number
    head_dim: number
    intermediate_size: number
  }
  mel: {
    sample_rate: number
    n_fft: number
    hop_length: number
    n_mels: number
    fmin: number
    fmax: number
  }
  special_tokens: {
    eos_token_ids: number[]
    pad_token_id: number
    im_start_token_id: number
    im_end_token_id: number
    audio_start_token_id: number
    audio_end_token_id: number
    audio_pad_token_id: number
    asr_text_token_id: number
  }
}

export interface Qwen3AsrRunners {
  /** mel: flat [128, T] (row-major). Returns audio features flat [N, output_dim]. */
  encodeMel(mel: Float32Array): Promise<Float32Array>
  decoderInit(
    inputIds: Int32Array,
    audioFeatures: Float32Array,
    audioOffset: number
  ): Promise<{ logits: Float32Array; pastKeys: unknown; pastValues: unknown }>
  decoderStep(
    inputEmbeds: Float32Array,
    positionId: number,
    pastKeys: unknown,
    pastValues: unknown
  ): Promise<{ logits: Float32Array; pastKeys: unknown; pastValues: unknown }>
  /** FP32 embedding vector [hidden] for a single token id. */
  embed(tokenId: number): Float32Array
  encodeText(text: string): number[]
  decodeTokens(ids: number[]): string
}

export interface Qwen3AsrOnnxResult {
  text: string
  language: string
  raw: string
}

/** Decode base64 little-endian Int16 PCM into a Float32 waveform in [-1, 1]. */
export function pcm16kBase64ToFloat32(base64: string): Float32Array {
  const buf = Buffer.from(base64, 'base64')
  const n = Math.floor(buf.byteLength / 2)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2)
    out[i] = s / 32768
  }
  return out
}

/** Next-token id = argmax over the last vocab row of a flat logits array. */
function argmaxLast(logits: Float32Array, vocabSize: number): number {
  const offset = logits.length - vocabSize
  let best = -Infinity
  let bestId = 0
  for (let i = 0; i < vocabSize; i++) {
    const v = logits[offset + i]!
    if (v > best) {
      best = v
      bestId = i
    }
  }
  return bestId
}

/**
 * Build the Qwen3-ASR chat prompt:
 *   <|im_start|>system<|im_end|><|im_start|>user<|audio_start|>
 *   <|audio_pad|>×N<|audio_end|><|im_end|><|im_start|>assistant
 * N equals the number of encoder audio frames.
 */
export function buildQwen3AsrPrompt(
  runners: Qwen3AsrRunners,
  config: Qwen3AsrOnnxConfig,
  audioFrameCount: number
): { ids: number[]; audioOffset: number } {
  const t = config.special_tokens
  const ids: number[] = []
  const push = (...xs: number[]) => ids.push(...xs)
  const nl = runners.encodeText('\n')
  push(
    t.im_start_token_id,
    ...runners.encodeText('system'),
    ...nl,
    t.im_end_token_id,
    ...nl,
    t.im_start_token_id,
    ...runners.encodeText('user'),
    ...nl,
    t.audio_start_token_id
  )
  const audioOffset = ids.length
  for (let i = 0; i < audioFrameCount; i++) push(t.audio_pad_token_id)
  push(t.audio_end_token_id, t.im_end_token_id, ...nl, t.im_start_token_id, ...runners.encodeText('assistant'), ...nl)
  return { ids, audioOffset }
}

export interface Qwen3AsrOnnxCoreOptions {
  runners: Qwen3AsrRunners
  config: Qwen3AsrOnnxConfig
  pcm16k: string
  maxNewTokens?: number
}

/**
 * Pure transcription orchestration. Inject `runners` (real ORT in production,
 * fakes in tests) so the greedy KV-cache loop is fully verifiable.
 */
export async function transcribeQwen3AsrOnnxCore(
  opts: Qwen3AsrOnnxCoreOptions
): Promise<Qwen3AsrOnnxResult> {
  const { runners, config } = opts
  const wav = pcm16kBase64ToFloat32(opts.pcm16k)
  if (wav.length === 0) {
    throw new Error('Qwen3-ASR received empty audio')
  }
  const mel = computeQwenLogMel(wav, config.mel)
  const audioFeatures = await runners.encodeMel(mel)
  const outputDim = config.encoder.output_dim
  if (audioFeatures.length % outputDim !== 0) {
    throw new Error('Qwen3-ASR encoder output length is not a multiple of output_dim')
  }
  const audioFrameCount = audioFeatures.length / outputDim
  if (audioFrameCount <= 0) {
    throw new Error('Qwen3-ASR encoder produced no audio frames')
  }

  const { ids: promptIds, audioOffset } = buildQwen3AsrPrompt(runners, config, audioFrameCount)
  const initOut = await runners.decoderInit(
    Int32Array.from(promptIds),
    audioFeatures,
    audioOffset
  )

  let pastKeys = initOut.pastKeys
  let pastValues = initOut.pastValues
  let next = argmaxLast(initOut.logits, config.decoder.vocab_size)
  const generated: number[] = [next]
  const stopIds = new Set<number>([...config.special_tokens.eos_token_ids, config.special_tokens.pad_token_id])
  // Generous per-second token budget so verbose / fast / token-dense speech is
  // never truncated. The greedy loop still stops at EOS; this is only a safety
  // ceiling, and `opts.maxNewTokens` can override it for tests.
  const SECONDS = Math.max(1, Math.floor(wav.length / 16000))
  const maxTokens = opts.maxNewTokens ?? Math.min(32768, Math.max(64, SECONDS * 20))
  let pos = promptIds.length
  let guard = 0
  while (guard < maxTokens && !stopIds.has(next)) {
    guard++
    const emb = runners.embed(next)
    const stepOut = await runners.decoderStep(emb, pos, pastKeys, pastValues)
    pastKeys = stepOut.pastKeys
    pastValues = stepOut.pastValues
    next = argmaxLast(stepOut.logits, config.decoder.vocab_size)
    generated.push(next)
    pos += 1
  }

  // Drop a trailing stop id for clean decoding.
  if (generated.length > 0 && stopIds.has(generated[generated.length - 1]!)) {
    generated.pop()
  }

  const raw = runners.decodeTokens(generated)
  const parsed = parseQwen3AsrOutput(raw)
  return { text: parsed.text.trim(), language: parsed.language, raw }
}

/**
 * Qwen3-ASR emits `language <lang><asr_text><transcript>`; strip the lang tag.
 */
export function parseQwen3AsrOutput(raw: string): { language: string; text: string } {
  const marker = '<asr_text>'
  if (raw.includes('language ') && raw.includes(marker)) {
    const [langPart, textPart] = raw.split(marker, 2)
    const language = langPart.startsWith('language ') ? langPart.slice('language '.length).trim() : ''
    return { language, text: textPart ?? '' }
  }
  return { language: '', text: raw }
}

// ---------------------------------------------------------------------------
// Log-mel spectrogram front-end (librosa-equivalent, Whisper-style).
// NOTE: exact dB scaling / normalization must match the export's
// `preprocessor_config.json`. This implementation follows the standard
// librosa `melspectrogram(power=2.0)` + `power_to_db(top_db=80)` convention.
// ---------------------------------------------------------------------------

function nextPow2(n: number): number {
  let p = 1
  while (p < n) p <<= 1
  return p
}

/** In-place iterative radix-2 FFT (re/im), length must be a power of two. */
function fftRadix2(re: Float32Array, im: Float32Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]!
      re[i] = re[j]!
      re[j] = tr
      const ti = im[i]!
      im[i] = im[j]!
      im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wRe = Math.cos(ang)
    const wIm = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let curRe = 1
      let curIm = 0
      for (let k = 0; k < len / 2; k++) {
        const aRe = re[i + k]!
        const aIm = im[i + k]!
        const bRe = re[i + k + len / 2]!
        const bIm = im[i + k + len / 2]!
        const prodRe = bRe * curRe - bIm * curIm
        const prodIm = bRe * curIm + bIm * curRe
        re[i + k] = aRe + prodRe
        im[i + k] = aIm + prodIm
        re[i + k + len / 2] = aRe - prodRe
        im[i + k + len / 2] = aIm - prodIm
        const nCurRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nCurRe
      }
    }
  }
}

function hzToMel(hz: number): number {
  return 1127 * Math.log(1 + hz / 700)
}

function melToHz(mel: number): number {
  return 700 * (Math.exp(mel / 1127) - 1)
}

/** Build a [n_mels, fft_bins] mel filterbank (slaney-style, area-normalized). */
function melFilterbank(nFft: number, nMels: number, sampleRate: number, fmin: number, fmax: number): Float32Array {
  const fftBins = Math.floor(nFft / 2) + 1
  const melMin = hzToMel(fmin)
  const melMax = hzToMel(fmax)
  const melPts = new Float32Array(nMels + 2)
  for (let i = 0; i < nMels + 2; i++) {
    melPts[i] = melMin + ((melMax - melMin) * i) / (nMels + 1)
  }
  const hzPts = new Float32Array(nMels + 2)
  for (let i = 0; i < nMels + 2; i++) hzPts[i] = melToHz(melPts[i]!)
  const binPts = new Float32Array(nMels + 2)
  for (let i = 0; i < nMels + 2; i++) binPts[i] = Math.floor(((nFft + 1) * hzPts[i]!) / sampleRate)

  const fb = new Float32Array(nMels * fftBins)
  for (let m = 1; m <= nMels; m++) {
    const fLeft = binPts[m - 1]!
    const fCenter = binPts[m]!
    const fRight = binPts[m + 1]!
    for (let k = Math.floor(fLeft); k < Math.floor(fRight); k++) {
      let w = 0
      if (k < fCenter && fCenter > fLeft) {
        w = (k - fLeft) / (fCenter - fLeft)
      } else if (k >= fCenter && fRight > fCenter) {
        w = (fRight - k) / (fRight - fCenter)
      }
      if (k >= 0 && k < fftBins) {
        fb[(m - 1) * fftBins + k] = w
      }
    }
  }
  return fb
}

export interface QwenMelParams {
  sample_rate: number
  n_fft: number
  hop_length: number
  n_mels: number
  fmin: number
  fmax: number
}

/**
 * Compute a log-mel spectrogram from a mono Float32 waveform.
 * Returns flat [n_mels, T] row-major. `n_fft` is zero-padded to the next power
 * of two for the FFT (standard practice; matches librosa's window handling
 * closely enough for an offline ASR front-end).
 */
export function computeQwenLogMel(wav: Float32Array, mel: QwenMelParams): Float32Array {
  const { sample_rate: sr, n_fft, hop_length: hop, n_mels, fmin, fmax } = mel
  const fftSize = nextPow2(n_fft)
  const fftBins = Math.floor(n_fft / 2) + 1
  const window = new Float32Array(n_fft)
  for (let i = 0; i < n_fft; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n_fft - 1)) // Hann
  }
  const fb = melFilterbank(n_fft, n_mels, sr, fmin, fmax)

  const numFrames = Math.max(1, Math.floor((wav.length - n_fft) / hop) + 1)
  const mels = new Float32Array(n_mels * numFrames)
  const re = new Float32Array(fftSize)
  const im = new Float32Array(fftSize)

  for (let f = 0; f < numFrames; f++) {
    const start = f * hop
    re.fill(0)
    im.fill(0)
    for (let i = 0; i < n_fft; i++) {
      const s = start + i < wav.length ? wav[start + i]! : 0
      re[i] = s * window[i]!
    }
    fftRadix2(re, im)
    // power spectrum over the first fftBins
    const power = new Float32Array(fftBins)
    for (let k = 0; k < fftBins; k++) {
      const r = re[k]!
      const ii = im[k]!
      power[k] = (r * r + ii * ii) / n_fft
    }
    // mel dot product
    let maxDb = -Infinity
    for (let m = 0; m < n_mels; m++) {
      let sum = 0
      for (let k = 0; k < fftBins; k++) {
        sum += fb[m * fftBins + k]! * power[k]!
      }
      sum = Math.max(sum, 1e-10)
      const db = 10 * Math.log10(sum)
      mels[m * numFrames + f] = db
      if (db > maxDb) maxDb = db
    }
    // power_to_db with top_db=80
    for (let m = 0; m < n_mels; m++) {
      let v = mels[m * numFrames + f]!
      if (v < maxDb - 80) v = maxDb - 80
      mels[m * numFrames + f] = v
    }
  }
  return mels
}

/** Build the production ORT runners for a downloaded Qwen3-ASR ONNX model dir. */
export async function createQwen3AsrOnnxRunners(modelDir: string): Promise<Qwen3AsrRunners> {
  return createQwen3AsrOnnxRunnersFromOrt(modelDir)
}

import { dictationModelDir } from './modelPaths'
import {
  createQwen3AsrOnnxRunnersFromOrt,
  readQwen3AsrConfig
} from './qwen3AsrOrtLoader'

/**
 * Transcribe a 16 kHz PCM recording using the downloaded on-device Qwen3-ASR
 * ONNX model. Sessions are cached per model dir by the loader.
 */
export async function transcribeQwen3AsrOnnxModel(
  modelId: import('../../shared/ipc').DictationLocalModelId,
  request: import('../../shared/ipc').DictationTranscribeRequest
): Promise<import('../../shared/ipc').DictationTranscribeResult> {
  const pcm = request.pcm16k?.trim()
  if (!pcm) {
    throw new Error(
      'On-device Qwen3-ASR needs 16 kHz PCM from the microphone. Try again, or switch engine in Settings → Voice.'
    )
  }
  const dir = dictationModelDir(modelId)
  const config = readQwen3AsrConfig(dir)
  if (!config) {
    throw new Error('Qwen3-ASR (on-device) model files are missing — install the model in Settings → Voice.')
  }
  const runners = await createQwen3AsrOnnxRunners(dir)
  const result = await transcribeQwen3AsrOnnxCore({ runners, config, pcm16k: pcm })
  if (!result.text.trim()) throw new Error('Dictation returned empty transcript')
  return { text: result.text }
}
