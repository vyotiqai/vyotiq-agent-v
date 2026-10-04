import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { basename, dirname, extname, relative } from 'path'
import { resolveInsideWorkspace } from '../workspace/safePath'
import { runRenderJob, type HostFrame, type HostMedia, type HostProgress } from './renderHost'
import { RUNNER_SOURCE } from './runnerSource'
import { mediaKindForPath, mediaMimeForPath } from './serveFile'

/** What a demuxer measured in a file (runner.ts `probe`). */
export type VideoMeta = {
  container: string
  duration: number
  video: null | { codec: string | null; width: number; height: number; fps: number; frames: number; bitrate: number }
  audio: null | { codec: string | null; channels: number; sampleRate: number }
}

export type VideoFrame = { t: number; jpeg: Buffer }

export const RENDER_LIMITS = {
  maxEdge: 3840,
  minEdge: 16,
  maxFps: 60,
  maxDuration: 180,
  maxFrames: 180 * 60,
  maxMedia: 16,
  maxSceneChars: 200_000,
  maxKeyframes: 8
} as const

export type RenderVideoArgs = {
  path: string
  scene: string
  width: number
  height: number
  fps: number
  duration: number
  background?: string
  media?: Record<string, string>
  keyframes?: number
}

export type VideoJobContext = {
  signal: AbortSignal
  onProgress?: (line: string) => void
}

export type RenderVideoResult = {
  relPath: string
  absPath: string
  bytes: number
  meta: VideoMeta
  frames: VideoFrame[]
  logs: string[]
  elapsedMs: number
}

const MEDIA_NAME_RE = /^[A-Za-z_][\w-]{0,39}$/

function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

/** Workspace-relative display path of an absolute path inside it. */
export function displayPath(workspace: string, absPath: string): string {
  const rel = toPosix(relative(workspace, absPath))
  return rel && !rel.startsWith('..') ? rel : toPosix(absPath)
}

/** Resolve where a new video goes: inside the workspace, ending in .mp4. */
export function resolveVideoOutput(workspace: string, path: string): string {
  const trimmed = path.trim()
  if (!trimmed) throw new Error('path is required (e.g. videos/puppy-dance.mp4)')
  if (extname(trimmed).toLowerCase() !== '.mp4') {
    throw new Error(`path must end in .mp4 (videos are written as MP4): ${trimmed}`)
  }
  return resolveInsideWorkspace(workspace, trimmed)
}

/** Resolve an existing media file the agent named. */
export function resolveVideoInput(workspace: string, path: string): { absPath: string; kind: 'video' | 'audio' | 'image'; mime: string } {
  const absPath = resolveInsideWorkspace(workspace, path.trim())
  if (!existsSync(absPath) || !statSync(absPath).isFile()) throw new Error(`No such file: ${path}`)
  const kind = mediaKindForPath(absPath)
  const mime = mediaMimeForPath(absPath)
  if (!kind || !mime) {
    throw new Error(`${path} is not a media file this pipeline reads (video: mp4/mov/webm/mkv, audio: mp3/m4a/aac/wav/ogg/flac, image: png/jpg/webp/gif/avif/bmp)`)
  }
  return { absPath, kind, mime }
}

/** Write bytes beside the target first, so a cancelled or failed write never leaves half a file. */
export function writeFileAtomic(absPath: string, bytes: Buffer): void {
  mkdirSync(dirname(absPath), { recursive: true })
  const temp = `${absPath}.partial-${process.pid}-${Date.now()}`
  try {
    writeFileSync(temp, bytes)
    renameSync(temp, absPath)
  } catch (err) {
    rmSync(temp, { force: true })
    throw err
  }
}

/** Evenly spaced sample times, away from the very first and last frame. */
export function keyframeTimes(duration: number, count: number): number[] {
  const n = Math.max(0, Math.min(RENDER_LIMITS.maxKeyframes, Math.floor(count)))
  if (n === 0 || !(duration > 0)) return []
  return Array.from({ length: n }, (_, i) => Math.round(((i + 0.5) / n) * duration * 1000) / 1000)
}

function progressLine(p: HostProgress): string {
  if (p.stage === 'encode') return `Rendering frame ${p.done}/${p.total}`
  if (p.stage === 'verify') return 'Reading the finished file back to check it'
  return p.stage
}

function validateRenderArgs(args: RenderVideoArgs): void {
  const { width, height, fps, duration } = args
  for (const [name, value] of [['width', width], ['height', height]] as const) {
    if (!Number.isInteger(value) || value < RENDER_LIMITS.minEdge || value > RENDER_LIMITS.maxEdge) {
      throw new Error(`${name} must be a whole number from ${RENDER_LIMITS.minEdge} to ${RENDER_LIMITS.maxEdge}`)
    }
    if (value % 2 !== 0) throw new Error(`${name} must be even (H.264 needs even dimensions): ${value}`)
  }
  if (!(fps >= 1 && fps <= RENDER_LIMITS.maxFps)) throw new Error(`fps must be 1–${RENDER_LIMITS.maxFps}`)
  if (!(duration > 0 && duration <= RENDER_LIMITS.maxDuration)) {
    throw new Error(`duration must be more than 0 and at most ${RENDER_LIMITS.maxDuration} seconds`)
  }
  if (Math.round(duration * fps) > RENDER_LIMITS.maxFrames) throw new Error('Too many frames: lower fps or duration')
  if (!args.scene.trim()) throw new Error('scene is required: a script defining function draw(ctx, t, v)')
  if (args.scene.length > RENDER_LIMITS.maxSceneChars) throw new Error('scene is too long')
}

function hostMedia(workspace: string, media: Record<string, string> | undefined): HostMedia[] {
  const entries = Object.entries(media ?? {})
  if (entries.length > RENDER_LIMITS.maxMedia) throw new Error(`At most ${RENDER_LIMITS.maxMedia} media inputs`)
  return entries.map(([name, path]) => {
    if (!MEDIA_NAME_RE.test(name)) throw new Error(`Media name "${name}" must be an identifier (letters, digits, _ or -)`)
    const input = resolveVideoInput(workspace, path)
    return { name, kind: input.kind, path: input.absPath, mime: input.mime }
  })
}

function framesOf(frames: HostFrame[]): VideoFrame[] {
  return frames.map((f) => ({ t: f.t, jpeg: f.jpeg }))
}

/** Draw, encode, write and re-read one video made by the agent's scene script. */
export async function renderVideo(workspace: string, args: RenderVideoArgs, ctx: VideoJobContext): Promise<RenderVideoResult> {
  validateRenderArgs(args)
  const absPath = resolveVideoOutput(workspace, args.path)
  const media = hostMedia(workspace, args.media)
  const started = Date.now()
  let lastLine = ''
  const result = await runRenderJob(
    {
      spec: {
        mode: 'render',
        width: args.width,
        height: args.height,
        fps: args.fps,
        duration: args.duration,
        background: args.background?.trim() || '#000000',
        frameTimes: keyframeTimes(args.duration, args.keyframes ?? 4),
        frameWidth: Math.min(640, args.width)
      },
      scene: args.scene,
      media
    },
    {
      runnerSource: RUNNER_SOURCE,
      signal: ctx.signal,
      onProgress: (p) => {
        const line = progressLine(p)
        if (line !== lastLine) {
          lastLine = line
          ctx.onProgress?.(line)
        }
      }
    }
  )
  if (!result.ok) throw new VideoJobError(result.error, result.logs)
  if (!result.output || result.output.length === 0) throw new VideoJobError('The render produced no file', result.logs)
  if (ctx.signal.aborted) throw new DOMException('Aborted', 'AbortError')
  writeFileAtomic(absPath, result.output)
  return {
    relPath: displayPath(workspace, absPath),
    absPath,
    bytes: result.output.length,
    meta: result.result.meta as VideoMeta,
    frames: framesOf(result.frames),
    logs: result.logs,
    elapsedMs: Date.now() - started
  }
}

export type InspectResult = { meta: VideoMeta; frames: VideoFrame[] }

/** Demux a file and decode frames from it — facts measured from the bytes on disk. */
export async function inspectMediaFile(
  absPath: string,
  opts: { times?: number[]; count?: number; frameWidth?: number; signal: AbortSignal }
): Promise<InspectResult> {
  const kind = mediaKindForPath(absPath)
  const mime = mediaMimeForPath(absPath)
  if (!kind || !mime || kind === 'image') throw new Error(`${basename(absPath)} is not a video or audio file`)
  // A first pass learns the duration when frames are wanted evenly spaced.
  const explicit = opts.times?.length ? opts.times.slice(0, RENDER_LIMITS.maxKeyframes) : null
  const run = (frameTimes: number[]) =>
    runRenderJob(
      {
        spec: { mode: 'probe', frameTimes, frameWidth: opts.frameWidth ?? 640 },
        media: [{ name: 'input', kind, path: absPath, mime }]
      },
      { runnerSource: RUNNER_SOURCE, signal: opts.signal, timeoutMs: 5 * 60_000, stallMs: 60_000 }
    )
  let result = await run(explicit ?? [])
  if (!result.ok) throw new VideoJobError(result.error, result.logs)
  const meta = result.result.meta as VideoMeta
  const count = opts.count ?? 4
  if (!explicit && count > 0 && meta.video && meta.duration > 0) {
    result = await run(keyframeTimes(meta.duration, count))
    if (!result.ok) throw new VideoJobError(result.error, result.logs)
  }
  return { meta, frames: framesOf(result.frames) }
}

export class VideoJobError extends Error {
  constructor(
    message: string,
    readonly logs: string[] = []
  ) {
    super(message)
    this.name = 'VideoJobError'
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

const CODEC_NAMES: Record<string, string> = { avc: 'H.264', hevc: 'H.265', vp9: 'VP9', vp8: 'VP8', av1: 'AV1', aac: 'AAC', opus: 'Opus', mp3: 'MP3' }

function codecName(codec: string | null | undefined): string {
  return codec ? (CODEC_NAMES[codec] ?? codec) : 'unknown'
}

/**
 * The lines the record parses (renderer toolUi/parsers/video.ts) and the
 * model reads. `Video:` and `Measured:` are the contract — keep them stable.
 */
export function formatVideoFacts(relPath: string, bytes: number, meta: VideoMeta): string[] {
  const v = meta.video
  const a = meta.audio
  const lines = [`Video: ${relPath}`]
  const picture = v ? `${v.width}x${v.height} ${v.fps}fps ${codecName(v.codec)}` : 'no video track'
  const sound = a ? `${codecName(a.codec)} ${a.channels}ch ${a.sampleRate}Hz` : 'no audio'
  lines.push(`Measured: ${meta.duration.toFixed(2)}s · ${picture} · ${sound} · ${formatBytes(bytes)}${v ? ` · ${v.frames} frames` : ''}`)
  return lines
}
