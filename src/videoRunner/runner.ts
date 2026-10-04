/**
 * The page that renders and inspects video, inside a sandboxed, network-less
 * window main opens per job (src/main/video/renderHost.ts).
 *
 * It only ever talks to its own origin, `vyotiq-render://<job>/`: the job, the
 * agent's scene script and the input media come in over GET, and progress, the
 * encoded file and decoded frames go back over POST. Nothing here can reach
 * the workspace or the network on its own — main serves exactly the files the
 * tool call named.
 *
 * Every frame of a render is drawn by the scene, encoded with WebCodecs and
 * muxed by mediabunny. The frames handed back to the agent are decoded from
 * the finished file, not copied from the canvas, so they prove the file plays.
 */
import {
  ALL_FORMATS,
  AudioBufferSink,
  AudioBufferSource,
  BufferSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  UrlSource,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  type InputAudioTrack,
  type InputVideoTrack
} from 'mediabunny'

type MediaKind = 'video' | 'image' | 'audio'

type JobMedia = { name: string; kind: MediaKind; url: string }

type RenderJob = {
  mode: 'render'
  width: number
  height: number
  fps: number
  duration: number
  background: string
  media: JobMedia[]
  /** Seconds at which to decode frames back out of the finished file. */
  frameTimes: number[]
  frameWidth: number
}

type ProbeJob = {
  mode: 'probe'
  media: JobMedia[]
  frameTimes: number[]
  frameWidth: number
}

type Job = RenderJob | ProbeJob

type MediaInfo = {
  name: string
  kind: MediaKind
  width?: number
  height?: number
  duration?: number
}

type ProbeMeta = {
  container: string
  duration: number
  video: null | {
    codec: string | null
    width: number
    height: number
    fps: number
    frames: number
    bitrate: number
  }
  audio: null | { codec: string | null; channels: number; sampleRate: number }
}

type SceneFns = {
  setup?: (v: SceneApi) => unknown
  draw?: (ctx: OffscreenCanvasRenderingContext2D, t: number, v: SceneApi) => unknown
  audio?: (actx: OfflineAudioContext, v: SceneApi) => unknown
}

type PlayOptions = { offset?: number; duration?: number; gain?: number; fadeIn?: number; fadeOut?: number; rate?: number }
type ToneOptions = {
  freq: number
  at: number
  dur: number
  type?: OscillatorType
  gain?: number
  attack?: number
  release?: number
  /** Glide to this frequency over the note. */
  to?: number
}

type SceneApi = {
  readonly width: number
  readonly height: number
  readonly fps: number
  readonly duration: number
  frame: number
  t: number
  media: Record<string, MediaInfo>
  image(name: string): ImageBitmap
  frameAt(name: string, time: number): Promise<OffscreenCanvas | HTMLCanvasElement | null>
  sound(name: string): Promise<AudioBuffer | null>
  play(name: string, at: number, opts?: PlayOptions): Promise<void>
  tone(opts: ToneOptions): void
  noise(opts: { at: number; dur: number; gain?: number; highpass?: number; lowpass?: number }): void
  random(seed?: number): () => number
  lerp(a: number, b: number, x: number): number
  clamp(x: number, lo?: number, hi?: number): number
  ease: Record<'linear' | 'inQuad' | 'outQuad' | 'inOut' | 'outBack' | 'outElastic' | 'bounce', (x: number) => number>
  /** 0→1 over [start, end] seconds, clamped. */
  progress(start: number, end: number, t?: number): number
}

const MAX_LOG_CHARS = 200

async function post(path: string, body: BodyInit, type = 'application/octet-stream'): Promise<void> {
  const res = await fetch(path, { method: 'POST', body, headers: { 'content-type': type } })
  if (!res.ok) throw new Error(`Host refused ${path}: ${res.status}`)
}

function postJson(path: string, value: unknown): Promise<void> {
  return post(path, JSON.stringify(value), 'application/json')
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`Host has no ${path}: ${res.status}`)
  return (await res.json()) as T
}

/** An error whose message is already the whole story (no "Error:" prefix). */
class SceneError extends Error {}

function formatError(err: unknown): string {
  if (err instanceof SceneError) return err.message
  if (err instanceof Error) {
    const stack = (err.stack ?? '')
      .split('\n')
      .filter((line) => line.includes('scene.js'))
      .slice(0, 3)
      .map((line) => line.trim())
    return stack.length ? `${err.name}: ${err.message}\n${stack.join('\n')}` : `${err.name}: ${err.message}`
  }
  return String(err).slice(0, MAX_LOG_CHARS * 5)
}

/** Load the agent's scene as a classic script and collect what it defined. */
function loadScene(): Promise<SceneFns> {
  return new Promise((resolve, reject) => {
    let syntaxError: string | null = null
    const onError = (event: ErrorEvent): void => {
      if (event.filename?.endsWith('scene.js')) {
        syntaxError = `${event.message} (scene.js line ${event.lineno}, column ${event.colno})`
      }
    }
    window.addEventListener('error', onError)
    const script = document.createElement('script')
    script.src = 'scene.js'
    script.onload = () => {
      window.removeEventListener('error', onError)
      if (syntaxError) {
        reject(new SceneError(syntaxError.replace(/^Uncaught /, '')))
        return
      }
      const g = window as unknown as Record<string, unknown>
      const pick = <K extends keyof SceneFns>(key: K): SceneFns[K] =>
        typeof g[key] === 'function' ? (g[key] as SceneFns[K]) : undefined
      resolve({ setup: pick('setup'), draw: pick('draw'), audio: pick('audio') })
    }
    script.onerror = () => {
      window.removeEventListener('error', onError)
      reject(new Error('The scene script could not be loaded'))
    }
    document.head.appendChild(script)
  })
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const clamp = (x: number, lo = 0, hi = 1): number => Math.min(hi, Math.max(lo, x))

const EASE: SceneApi['ease'] = {
  linear: (x) => x,
  inQuad: (x) => x * x,
  outQuad: (x) => 1 - (1 - x) * (1 - x),
  inOut: (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2),
  outBack: (x) => {
    const c1 = 1.70158
    const c3 = c1 + 1
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2)
  },
  outElastic: (x) =>
    x === 0 || x === 1 ? x : Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1,
  bounce: (x) => {
    const n1 = 7.5625
    const d1 = 2.75
    if (x < 1 / d1) return n1 * x * x
    if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75
    if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375
    return n1 * (x -= 2.625 / d1) * x + 0.984375
  }
}

/** Decoders and decoded media for one job, opened on first use. */
class MediaLibrary {
  private readonly inputs = new Map<string, Input>()
  private readonly sinks = new Map<string, CanvasSink>()
  private readonly images = new Map<string, ImageBitmap>()
  private readonly sounds = new Map<string, AudioBuffer | null>()
  readonly info: Record<string, MediaInfo> = {}

  constructor(private readonly media: JobMedia[]) {}

  private entry(name: string): JobMedia {
    const found = this.media.find((m) => m.name === name)
    if (!found) {
      const names = this.media.map((m) => m.name)
      throw new Error(`No media named "${name}"${names.length ? ` (have: ${names.join(', ')})` : ' (none were passed)'}`)
    }
    return found
  }

  private input(name: string): Input {
    let input = this.inputs.get(name)
    if (!input) {
      input = new Input({ source: new UrlSource(this.entry(name).url), formats: ALL_FORMATS })
      this.inputs.set(name, input)
    }
    return input
  }

  async open(): Promise<void> {
    for (const m of this.media) {
      if (m.kind === 'image') {
        const res = await fetch(m.url)
        if (!res.ok) throw new Error(`Image "${m.name}" could not be read`)
        const bitmap = await createImageBitmap(await res.blob())
        this.images.set(m.name, bitmap)
        this.info[m.name] = { name: m.name, kind: 'image', width: bitmap.width, height: bitmap.height }
        continue
      }
      const input = this.input(m.name)
      const video = m.kind === 'video' ? await input.getPrimaryVideoTrack() : null
      if (m.kind === 'video' && !video) throw new Error(`"${m.name}" has no video track`)
      this.info[m.name] = {
        name: m.name,
        kind: m.kind,
        duration: await input.computeDuration(),
        ...(video ? { width: video.displayWidth, height: video.displayHeight } : {})
      }
    }
  }

  image(name: string): ImageBitmap {
    const bitmap = this.images.get(name)
    if (!bitmap) {
      const kind = this.entry(name).kind
      throw new Error(`"${name}" is ${kind === 'video' ? 'a video: use await v.frameAt(name, t)' : `${kind}, not an image`}`)
    }
    return bitmap
  }

  async frameAt(name: string, time: number): Promise<OffscreenCanvas | HTMLCanvasElement | null> {
    let sink = this.sinks.get(name)
    if (!sink) {
      if (this.entry(name).kind !== 'video') throw new Error(`"${name}" is not a video`)
      const track = await this.input(name).getPrimaryVideoTrack()
      if (!track) throw new Error(`"${name}" has no video track`)
      sink = new CanvasSink(track, { poolSize: 2 })
      this.sinks.set(name, sink)
    }
    const duration = this.info[name]?.duration ?? 0
    const wrapped = await sink.getCanvas(clamp(time, 0, Math.max(0, duration - 1e-3)))
    return wrapped?.canvas ?? null
  }

  async sound(name: string, actx: BaseAudioContext): Promise<AudioBuffer | null> {
    if (this.sounds.has(name)) return this.sounds.get(name) ?? null
    const kind = this.entry(name).kind
    if (kind === 'image') throw new Error(`"${name}" is an image and has no sound`)
    const track = await this.input(name).getPrimaryAudioTrack()
    const buffer = track ? await decodeTrack(track, actx) : null
    this.sounds.set(name, buffer)
    return buffer
  }
}

/** Decode a whole audio track into one AudioBuffer at the context's rate. */
async function decodeTrack(track: InputAudioTrack, actx: BaseAudioContext): Promise<AudioBuffer> {
  const sink = new AudioBufferSink(track)
  const pieces: Array<{ buffer: AudioBuffer; timestamp: number }> = []
  for await (const wrapped of sink.buffers()) pieces.push(wrapped)
  const channels = Math.max(1, Math.min(2, track.numberOfChannels))
  const end = pieces.reduce((max, p) => Math.max(max, p.timestamp + p.buffer.duration), 0)
  // Resample through an offline context so every buffer matches the mix rate.
  const length = Math.max(1, Math.ceil(end * actx.sampleRate))
  const mix = new OfflineAudioContext(channels, length, actx.sampleRate)
  for (const piece of pieces) {
    const src = mix.createBufferSource()
    src.buffer = piece.buffer
    src.connect(mix.destination)
    src.start(Math.max(0, piece.timestamp))
  }
  return mix.startRendering()
}

function makeApi(
  job: { width: number; height: number; fps: number; duration: number },
  library: MediaLibrary,
  getActx: () => OfflineAudioContext | null
): SceneApi {
  const needActx = (what: string): OfflineAudioContext => {
    const actx = getActx()
    if (!actx) throw new Error(`v.${what}() only works inside audio(actx, v)`)
    return actx
  }
  return {
    width: job.width,
    height: job.height,
    fps: job.fps,
    duration: job.duration,
    frame: 0,
    t: 0,
    media: library.info,
    image: (name) => library.image(name),
    frameAt: (name, time) => library.frameAt(name, time),
    sound: (name) => library.sound(name, needActx('sound')),
    async play(name, at, opts = {}) {
      const actx = needActx('play')
      const buffer = await library.sound(name, actx)
      if (!buffer) throw new Error(`"${name}" has no audio track`)
      const src = actx.createBufferSource()
      src.buffer = buffer
      if (opts.rate) src.playbackRate.value = opts.rate
      const gain = actx.createGain()
      const level = opts.gain ?? 1
      const offset = Math.max(0, opts.offset ?? 0)
      const length = Math.max(0, Math.min(opts.duration ?? buffer.duration - offset, buffer.duration - offset))
      gain.gain.setValueAtTime(opts.fadeIn ? 0 : level, at)
      if (opts.fadeIn) gain.gain.linearRampToValueAtTime(level, at + opts.fadeIn)
      if (opts.fadeOut) {
        gain.gain.setValueAtTime(level, Math.max(at, at + length - opts.fadeOut))
        gain.gain.linearRampToValueAtTime(0, at + length)
      }
      src.connect(gain).connect(actx.destination)
      src.start(Math.max(0, at), offset, length)
    },
    tone({ freq, at, dur, type = 'sine', gain = 0.2, attack = 0.01, release = 0.08, to }) {
      const actx = needActx('tone')
      const osc = actx.createOscillator()
      osc.type = type
      osc.frequency.setValueAtTime(freq, at)
      if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), at + dur)
      const env = actx.createGain()
      env.gain.setValueAtTime(0, at)
      env.gain.linearRampToValueAtTime(gain, at + attack)
      env.gain.setValueAtTime(gain, Math.max(at + attack, at + dur - release))
      env.gain.linearRampToValueAtTime(0, at + dur)
      osc.connect(env).connect(actx.destination)
      osc.start(at)
      osc.stop(at + dur + 0.01)
    },
    noise({ at, dur, gain = 0.2, highpass, lowpass }) {
      const actx = needActx('noise')
      const length = Math.max(1, Math.ceil(dur * actx.sampleRate))
      const buffer = actx.createBuffer(1, length, actx.sampleRate)
      const data = buffer.getChannelData(0)
      const rand = mulberry32(Math.floor(at * 1000) + length)
      for (let i = 0; i < length; i++) data[i] = (rand() * 2 - 1) * (1 - i / length)
      const src = actx.createBufferSource()
      src.buffer = buffer
      let node: AudioNode = src
      if (highpass) {
        const f = actx.createBiquadFilter()
        f.type = 'highpass'
        f.frequency.value = highpass
        node = node.connect(f)
      }
      if (lowpass) {
        const f = actx.createBiquadFilter()
        f.type = 'lowpass'
        f.frequency.value = lowpass
        node = node.connect(f)
      }
      const env = actx.createGain()
      env.gain.value = gain
      node.connect(env).connect(actx.destination)
      src.start(at)
    },
    random: (seed = 1) => mulberry32(seed),
    lerp: (a, b, x) => a + (b - a) * x,
    clamp,
    ease: EASE,
    progress(start, end, t) {
      const now = t ?? this.t
      return end <= start ? (now >= end ? 1 : 0) : clamp((now - start) / (end - start))
    }
  }
}

/**
 * Scenes sum their voices straight into the destination, so a loud mix clips
 * (measured: a kick, snare and bass line peaked at 0.0 dBFS). Scale the whole
 * track down to -1 dBFS when it would, and leave a quieter one untouched.
 */
function normalizePeak(buffer: AudioBuffer): AudioBuffer {
  const ceiling = 0.891 // -1 dBFS
  let peak = 0
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < data.length; i++) {
      const s = Math.abs(data[i]!)
      if (s > peak) peak = s
    }
  }
  if (peak <= ceiling || peak === 0) return buffer
  const scale = ceiling / peak
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < data.length; i++) data[i] = data[i]! * scale
  }
  return buffer
}

async function jpegOf(source: CanvasImageSource & { width: number; height: number }, maxWidth: number): Promise<Blob> {
  const scale = Math.min(1, maxWidth / source.width)
  const w = Math.max(2, Math.round(source.width * scale))
  const h = Math.max(2, Math.round(source.height * scale))
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No 2D context')
  ctx.drawImage(source, 0, 0, w, h)
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.86 })
}

/** Facts about a file, measured by demuxing it — not what a provider claimed. */
async function probe(input: Input): Promise<{ meta: ProbeMeta; video: InputVideoTrack | null }> {
  const format = await input.getFormat()
  const duration = await input.computeDuration()
  const video = await input.getPrimaryVideoTrack()
  const audio = await input.getPrimaryAudioTrack()
  let videoMeta: ProbeMeta['video'] = null
  if (video) {
    const stats = await video.computePacketStats()
    videoMeta = {
      codec: await video.getCodec(),
      width: video.displayWidth,
      height: video.displayHeight,
      fps: Math.round(stats.averagePacketRate * 100) / 100,
      frames: stats.packetCount,
      bitrate: Math.round(stats.averageBitrate)
    }
  }
  return {
    meta: {
      container: format.name,
      duration: Math.round(duration * 1000) / 1000,
      video: videoMeta,
      audio: audio
        ? { codec: await audio.getCodec(), channels: audio.numberOfChannels, sampleRate: audio.sampleRate }
        : null
    },
    video
  }
}

/** Decode frames at the requested times and hand each back as a JPEG. */
async function postFrames(video: InputVideoTrack | null, duration: number, times: number[], maxWidth: number): Promise<number[]> {
  if (!video || times.length === 0) return []
  const sink = new CanvasSink(video, { poolSize: 1 })
  const clamped = times.map((t) => clamp(t, 0, Math.max(0, duration - 1e-3))).sort((a, b) => a - b)
  const sent: number[] = []
  let i = 0
  for await (const wrapped of sink.canvasesAtTimestamps(clamped)) {
    const at = clamped[i]!
    i += 1
    if (!wrapped) continue
    await post(`frame/${sent.length}?t=${at.toFixed(3)}`, await jpegOf(wrapped.canvas, maxWidth), 'image/jpeg')
    sent.push(Math.round(at * 1000) / 1000)
  }
  return sent
}

async function render(job: RenderJob, logs: string[]): Promise<unknown> {
  const library = new MediaLibrary(job.media)
  await library.open()
  const scene = await loadScene()
  if (!scene.draw) throw new Error('The scene must define function draw(ctx, t, v)')

  let actx: OfflineAudioContext | null = null
  const api = makeApi(job, library, () => actx)
  if (scene.setup) await scene.setup(api)

  const totalFrames = Math.max(1, Math.round(job.duration * job.fps))
  const canvas = new OffscreenCanvas(job.width, job.height)
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('No 2D context')

  const videoCodec = await getFirstEncodableVideoCodec(['avc', 'vp9', 'av1'], {
    width: job.width,
    height: job.height
  })
  if (!videoCodec) throw new Error(`This machine cannot encode ${job.width}x${job.height} video (no H.264, VP9 or AV1 encoder)`)

  // Audio first: an OfflineAudioContext renders the whole track at once.
  let soundtrack: AudioBuffer | null = null
  if (scene.audio) {
    const sampleRate = 48_000
    actx = new OfflineAudioContext(2, Math.ceil(job.duration * sampleRate), sampleRate)
    await scene.audio(actx, api)
    soundtrack = normalizePeak(await actx.startRendering())
    actx = null
  }
  const audioCodec = soundtrack ? await getFirstEncodableAudioCodec(['aac', 'opus']) : null
  if (soundtrack && !audioCodec) logs.push('[host] no AAC or Opus encoder here: the video was made without sound')

  const target = new BufferTarget()
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target })
  const videoSource = new CanvasSource(canvas, { codec: videoCodec, quality: QUALITY_HIGH, keyFrameInterval: 1 })
  output.addVideoTrack(videoSource, { frameRate: job.fps })
  const audioSource = soundtrack && audioCodec ? new AudioBufferSource({ codec: audioCodec, quality: QUALITY_HIGH }) : null
  if (audioSource) output.addAudioTrack(audioSource)
  await output.start()
  if (audioSource && soundtrack) await audioSource.add(soundtrack)

  let lastReport = 0
  for (let frame = 0; frame < totalFrames; frame++) {
    const t = frame / job.fps
    api.frame = frame
    api.t = t
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    ctx.filter = 'none'
    ctx.fillStyle = job.background
    ctx.fillRect(0, 0, job.width, job.height)
    ctx.save()
    try {
      await scene.draw(ctx, t, api)
    } catch (err) {
      throw new Error(`draw() failed at t=${t.toFixed(3)}s (frame ${frame}): ${formatError(err)}`)
    } finally {
      ctx.restore()
    }
    await videoSource.add(t, 1 / job.fps)
    const now = performance.now()
    if (now - lastReport > 500 || frame === totalFrames - 1) {
      lastReport = now
      await postJson('progress', { stage: 'encode', done: frame + 1, total: totalFrames })
    }
  }
  await output.finalize()
  const bytes = target.buffer
  if (!bytes) throw new Error('The encoder produced no file')
  await postJson('progress', { stage: 'verify', done: 0, total: 1 })
  // Read the file we just wrote back in, as any player would.
  const input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS })
  const { meta, video } = await probe(input)
  const frames = await postFrames(video, meta.duration, job.frameTimes, job.frameWidth)
  await post('output', bytes, 'video/mp4')
  return { meta, frames, mime: output.format.mimeType, videoCodec, audioCodec }
}

async function inspect(job: ProbeJob): Promise<unknown> {
  const media = job.media[0]
  if (!media) throw new Error('Nothing to inspect')
  const input = new Input({ source: new UrlSource(media.url), formats: ALL_FORMATS })
  const { meta, video } = await probe(input)
  const frames = await postFrames(video, meta.duration, job.frameTimes, job.frameWidth)
  return { meta, frames }
}

function captureLogs(logs: string[]): void {
  const keep = (level: string, args: unknown[]): void => {
    if (logs.length >= 40) return
    const text = args
      .map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a) } catch { return String(a) } })()))
      .join(' ')
    logs.push(`[${level}] ${text.slice(0, MAX_LOG_CHARS)}`)
  }
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      keep(level, args)
      original(...args)
    }
  }
}

async function run(): Promise<void> {
  const logs: string[] = []
  captureLogs(logs)
  try {
    const job = await getJson<Job>('job.json')
    const result = job.mode === 'render' ? await render(job, logs) : await inspect(job)
    await postJson('done', { ok: true, result, logs })
  } catch (err) {
    await postJson('done', { ok: false, error: formatError(err), logs }).catch(() => undefined)
  }
}

void run()
