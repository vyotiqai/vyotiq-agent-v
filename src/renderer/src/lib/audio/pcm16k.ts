/**
 * Recording blob → 16 kHz mono Int16 PCM (base64) for the local dictation
 * engine (`local` Whisper), which takes raw samples rather than container
 * audio. Used by composer push-to-talk dictation.
 */
import { MAX_LOCAL_AUDIO_BYTES } from '@shared/ipc'

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(new Error('Failed to read recording'))
    reader.readAsDataURL(blob)
  })
}

function mixToMono(buffer: AudioBuffer): Float32Array {
  const { numberOfChannels, length } = buffer
  if (numberOfChannels === 1) {
    const src = buffer.getChannelData(0)
    const out = new Float32Array(length)
    out.set(src)
    return out
  }
  const out = new Float32Array(length)
  for (let c = 0; c < numberOfChannels; c++) {
    const ch = buffer.getChannelData(c)
    for (let i = 0; i < length; i++) out[i]! += ch[i]!
  }
  const inv = 1 / numberOfChannels
  for (let i = 0; i < length; i++) out[i]! *= inv
  return out
}

function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input
  if (fromRate <= 0 || toRate <= 0) return input
  const ratio = fromRate / toRate
  const outLen = Math.max(1, Math.round(input.length / ratio))
  const out = new Float32Array(outLen)
  const last = Math.max(0, input.length - 1)
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio
    const i0 = Math.min(Math.floor(src), last)
    const i1 = Math.min(i0 + 1, last)
    const frac = src - Math.floor(src)
    out[i] = input[i0]! * (1 - frac) + input[i1]! * frac
  }
  return out
}

function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]!))
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff)
  }
  return out
}

async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (result instanceof ArrayBuffer) {
        resolve(result)
        return
      }
      reject(new Error('Failed to read recording bytes'))
    }
    reader.onerror = () => reject(new Error('Failed to read recording'))
    reader.readAsArrayBuffer(blob)
  })
}

/** Decode a recording and encode it as base64 16 kHz mono Int16 PCM. */
export async function blobToPcm16kBase64(blob: Blob): Promise<string> {
  if (typeof AudioContext === 'undefined') {
    throw new Error('Web Audio is not available for local dictation')
  }
  const ctx = new AudioContext()
  try {
    const buf = await blobToArrayBuffer(blob)
    const decoded = await ctx.decodeAudioData(buf.slice(0))
    const mono = mixToMono(decoded)
    const resampled = resampleLinear(mono, decoded.sampleRate, 16000)
    const int16 = floatToInt16(resampled)
    if (int16.byteLength > MAX_LOCAL_AUDIO_BYTES) {
      throw new Error('Recording is too large to transcribe (local limit reached)')
    }
    const copy = new Int16Array(int16)
    return blobToBase64(new Blob([copy.buffer], { type: 'application/octet-stream' }))
  } finally {
    await ctx.close().catch(() => undefined)
  }
}
