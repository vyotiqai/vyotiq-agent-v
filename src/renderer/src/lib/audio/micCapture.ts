/**
 * The microphone as a stream of 16 kHz mono Int16 samples — the one format
 * every dictation engine takes (Whisper directly, the cloud APIs as a WAV).
 *
 * Capturing PCM rather than a MediaRecorder blob is what lets a take be cut
 * into segments while it runs, show live words, and be replayed for Retry:
 * a webm stream can't be split mid-way, since only its first chunk carries
 * the header.
 *
 * The tap is a ScriptProcessorNode. An AudioWorklet would have to load its
 * module from a URL, and the packaged renderer runs from file://, where
 * module fetches are refused; at 16 kHz a 2048-frame callback every 128 ms is
 * light work on the renderer thread.
 */

export const PCM_SAMPLE_RATE = 16000
const TAP_FRAMES = 2048

export type MicCaptureFailure =
  /** The OS or the user refused the microphone. */
  | 'blocked'
  /** No input device, or the chosen one is gone. */
  | 'no_device'
  /** Another app holds the device. */
  | 'busy'
  /** No getUserMedia / Web Audio here (tests, a stripped environment). */
  | 'unsupported'
  | 'failed'

export class MicCaptureError extends Error {
  readonly kind: MicCaptureFailure
  constructor(kind: MicCaptureFailure, message: string) {
    super(message)
    this.name = 'MicCaptureError'
    this.kind = kind
  }
}

export type MicCapture = {
  /** What the OS calls the device ("Microphone Array (Realtek)"); empty if it won't say. */
  readonly deviceLabel: string
  /** The device actually opened — may differ from the one asked for when that one is gone. */
  readonly deviceId: string
  stop: () => void
}

export type OpenMicCapture = (opts: {
  deviceId?: string
  onSamples: (pcm: Int16Array) => void
  /** The device went away mid-take (unplugged, taken by the OS). */
  onEnded?: () => void
}) => Promise<MicCapture>

function classify(err: unknown): MicCaptureError {
  const name = err instanceof Error || err instanceof DOMException ? err.name : ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError':
      return new MicCaptureError('blocked', 'The microphone is blocked')
    case 'NotFoundError':
    case 'OverconstrainedError':
    case 'DevicesNotFoundError':
      return new MicCaptureError('no_device', 'No microphone was found')
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return new MicCaptureError('busy', 'Another app is using the microphone')
    default:
      return new MicCaptureError('failed', err instanceof Error && err.message ? err.message : 'The microphone could not start')
  }
}

/** Streaming linear resampler to 16 kHz, for a context that would not open at 16 kHz. */
function makeResampler(fromRate: number): (input: Float32Array) => Float32Array {
  if (fromRate === PCM_SAMPLE_RATE) return (input) => input
  const step = fromRate / PCM_SAMPLE_RATE
  // `pos` is measured from the start of the current chunk; -1 is the last
  // sample of the previous one, so interpolation runs across chunk edges.
  let pos = 0
  let prev = 0
  return (input) => {
    const out: number[] = []
    while (pos < input.length - 1) {
      const i = Math.floor(pos)
      const frac = pos - i
      const a = i < 0 ? prev : input[i]!
      const b = input[i + 1]!
      out.push(a + (b - a) * frac)
      pos += step
    }
    pos -= input.length
    prev = input[input.length - 1] ?? prev
    return Float32Array.from(out)
  }
}

function toInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]!))
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff)
  }
  return out
}

async function getStream(deviceId: string | undefined): Promise<MediaStream> {
  const base: MediaTrackConstraints = {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  }
  if (deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: deviceId } } })
    } catch (err) {
      const kind = classify(err).kind
      // The chosen device is gone: fall back to the OS default rather than fail the take.
      if (kind !== 'no_device') throw err
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio: base })
}

export const openMicCapture: OpenMicCapture = async ({ deviceId, onSamples, onEnded }) => {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new MicCaptureError('unsupported', 'There is no microphone access here')
  }
  if (typeof AudioContext === 'undefined') {
    throw new MicCaptureError('unsupported', 'There is no audio processing here')
  }
  let stream: MediaStream
  try {
    stream = await getStream(deviceId)
  } catch (err) {
    throw classify(err)
  }
  const track = stream.getAudioTracks()[0]
  let ctx: AudioContext
  try {
    ctx = new AudioContext({ sampleRate: PCM_SAMPLE_RATE })
  } catch {
    ctx = new AudioContext()
  }
  if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined)
  const source = ctx.createMediaStreamSource(stream)
  const tap = ctx.createScriptProcessor(TAP_FRAMES, 1, 1)
  const resample = makeResampler(ctx.sampleRate)
  let stopped = false
  tap.onaudioprocess = (e) => {
    if (stopped) return
    const pcm = toInt16(resample(e.inputBuffer.getChannelData(0)))
    if (pcm.length > 0) onSamples(pcm)
  }
  // The tap only runs while connected to the destination; it writes no
  // output, so nothing is heard.
  source.connect(tap)
  tap.connect(ctx.destination)
  const onTrackEnded = (): void => {
    if (!stopped) onEnded?.()
  }
  track?.addEventListener('ended', onTrackEnded)

  return {
    deviceLabel: track?.label ?? '',
    deviceId: track?.getSettings?.().deviceId ?? deviceId ?? '',
    stop: () => {
      if (stopped) return
      stopped = true
      track?.removeEventListener('ended', onTrackEnded)
      tap.onaudioprocess = null
      try {
        source.disconnect()
        tap.disconnect()
      } catch {
        // already disconnected
      }
      for (const t of stream.getTracks()) t.stop()
      void ctx.close().catch(() => undefined)
    }
  }
}

/** The audio inputs, for the device picker. Labels are empty until the mic has been allowed once. */
export async function listMicDevices(): Promise<Array<{ deviceId: string; label: string }>> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return []
  try {
    const all = await navigator.mediaDevices.enumerateDevices()
    return all
      .filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'communications')
      .map((d, i) => ({
        deviceId: d.deviceId === 'default' ? '' : d.deviceId,
        label: d.deviceId === 'default' ? 'System default' : d.label || `Microphone ${i + 1}`
      }))
  } catch {
    return []
  }
}

/** Int16 samples as base64 — the IPC wire format for `pcm16k`. */
export function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
