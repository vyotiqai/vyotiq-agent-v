import { BrowserWindow, session, type Session } from 'electron'
import { randomBytes } from 'crypto'
import { RENDER_SCHEME } from './schemes'
import { serveFileResponse, type MediaKind } from './serveFile'

/**
 * Runs one render or probe job in a window of its own.
 *
 * The page is the bundled runner (src/videoRunner/runner.ts) plus, for a
 * render, the agent's scene script. That script is untrusted code, so the
 * window is built to hold nothing worth taking and reach nothing:
 * - sandboxed, context-isolated, no preload, no Node;
 * - an in-memory session of its own, where every request that is not to its
 *   own `vyotiq-render://<job>/` origin is cancelled and every permission is
 *   refused;
 * - served only the files this job named, by name, never a path;
 * - a CSP that allows scripts, fetches and media from its own origin only.
 * A job that stops reporting (an endless loop in draw) is killed, as is one
 * that runs past its time limit or whose tool call is cancelled.
 */

export type HostMedia = { name: string; kind: MediaKind; path: string; mime: string }

export type HostJob = {
  /** Serialized as job.json for the runner; media URLs are filled in here. */
  spec: Record<string, unknown> & { mode: 'render' | 'probe' }
  scene?: string
  media: HostMedia[]
}

export type HostProgress = { stage: string; done: number; total: number }

export type HostFrame = { index: number; t: number; jpeg: Buffer }

export type HostResult =
  | {
      ok: true
      result: Record<string, unknown>
      logs: string[]
      output: Buffer | null
      frames: HostFrame[]
    }
  | { ok: false; error: string; logs: string[] }

export type HostOptions = {
  runnerSource: string
  signal?: AbortSignal
  onProgress?: (progress: HostProgress) => void
  /** Whole job, from window open to the last byte. */
  timeoutMs?: number
  /** Longest gap between two reports from the page. */
  stallMs?: number
  /** Largest encoded file accepted back. */
  maxOutputBytes?: number
}

const PARTITION = 'vyotiq-video-render'
const DEFAULT_TIMEOUT_MS = 15 * 60_000
const DEFAULT_STALL_MS = 90_000
const DEFAULT_MAX_OUTPUT = 1024 * 1024 * 1024
const MAX_FRAME_BYTES = 8 * 1024 * 1024
const MAX_FRAMES = 32

const CSP = [
  "default-src 'none'",
  `script-src ${RENDER_SCHEME}:`,
  `connect-src ${RENDER_SCHEME}:`,
  `img-src ${RENDER_SCHEME}: data: blob:`,
  `media-src ${RENDER_SCHEME}: blob:`,
  "font-src data:",
  "style-src 'unsafe-inline'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'"
].join('; ')

const INDEX_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>render</title></head>' +
  '<body><script src="runner.js"></script></body></html>'

type LiveJob = {
  job: HostJob
  runnerSource: string
  touch: () => void
  progress: (p: HostProgress) => void
  output: Buffer | null
  frames: HostFrame[]
  maxOutputBytes: number
  finish: (value: { ok: boolean; result?: Record<string, unknown>; error?: string; logs?: string[] }) => void
}

const jobs = new Map<string, LiveJob>()
let renderSession: Session | null = null

function headers(type: string): Record<string, string> {
  return {
    'content-type': type,
    'content-security-policy': CSP,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  }
}

async function readBody(request: Request, limit: number): Promise<Buffer> {
  const bytes = Buffer.from(await request.arrayBuffer())
  if (bytes.length > limit) throw new Error(`body over ${limit} bytes`)
  return bytes
}

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const live = jobs.get(url.host)
  if (!live) return new Response('No such job', { status: 404 })
  live.touch()
  const path = decodeURIComponent(url.pathname.replace(/^\/+/, ''))

  if (request.method === 'GET' || request.method === 'HEAD') {
    if (path === '' || path === 'index.html') return new Response(INDEX_HTML, { headers: headers('text/html; charset=utf-8') })
    if (path === 'runner.js') return new Response(live.runnerSource, { headers: headers('text/javascript; charset=utf-8') })
    if (path === 'scene.js' && typeof live.job.scene === 'string') {
      return new Response(live.job.scene, { headers: headers('text/javascript; charset=utf-8') })
    }
    if (path === 'job.json') {
      const spec = {
        ...live.job.spec,
        media: live.job.media.map((m) => ({ name: m.name, kind: m.kind, url: `media/${encodeURIComponent(m.name)}` }))
      }
      return new Response(JSON.stringify(spec), { headers: headers('application/json') })
    }
    if (path.startsWith('media/')) {
      const name = path.slice('media/'.length)
      const media = live.job.media.find((m) => m.name === name)
      if (!media) return new Response('Not found', { status: 404 })
      return serveFileResponse(request, media.path, media.mime)
    }
    return new Response('Not found', { status: 404 })
  }

  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  try {
    if (path === 'progress') {
      const p = JSON.parse((await readBody(request, 4096)).toString('utf8')) as HostProgress
      if (typeof p.done === 'number' && typeof p.total === 'number') {
        live.progress({ stage: String(p.stage ?? ''), done: p.done, total: p.total })
      }
      return new Response(null, { status: 204 })
    }
    if (path === 'output') {
      live.output = await readBody(request, live.maxOutputBytes)
      return new Response(null, { status: 204 })
    }
    if (path.startsWith('frame/')) {
      if (live.frames.length >= MAX_FRAMES) return new Response('Too many frames', { status: 413 })
      const index = Number(path.slice('frame/'.length))
      const t = Number(url.searchParams.get('t') ?? '0')
      live.frames.push({ index, t: Number.isFinite(t) ? t : 0, jpeg: await readBody(request, MAX_FRAME_BYTES) })
      return new Response(null, { status: 204 })
    }
    if (path === 'done') {
      const value = JSON.parse((await readBody(request, 1024 * 1024)).toString('utf8')) as {
        ok: boolean
        result?: Record<string, unknown>
        error?: string
        logs?: string[]
      }
      live.finish(value)
      return new Response(null, { status: 204 })
    }
  } catch (err) {
    return new Response(err instanceof Error ? err.message : 'Bad request', { status: 413 })
  }
  return new Response('Not found', { status: 404 })
}

function renderSessionOnce(): Session {
  if (renderSession) return renderSession
  // No `persist:` prefix: in memory only, nothing written to userData.
  const ses = session.fromPartition(PARTITION)
  ses.protocol.handle(RENDER_SCHEME, handle)
  // The only listener on this session; nothing else ever registers here.
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith(`${RENDER_SCHEME}://`) })
  })
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  renderSession = ses
  return ses
}

/** Run one job to completion. Never throws: failures come back as `{ ok: false }`. */
export async function runRenderJob(job: HostJob, opts: HostOptions): Promise<HostResult> {
  if (opts.signal?.aborted) return { ok: false, error: 'Cancelled', logs: [] }
  const ses = renderSessionOnce()
  const id = `job-${randomBytes(9).toString('hex')}`
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const stallMs = opts.stallMs ?? DEFAULT_STALL_MS

  let win: BrowserWindow | null = null
  let settled = false
  let lastActivity = Date.now()
  let resolveResult: (r: HostResult) => void = () => undefined
  const result = new Promise<HostResult>((resolve) => {
    resolveResult = resolve
  })

  const consoleLogs: string[] = []
  const live: LiveJob = {
    job,
    runnerSource: opts.runnerSource,
    touch: () => {
      lastActivity = Date.now()
    },
    progress: (p) => opts.onProgress?.(p),
    output: null,
    frames: [],
    maxOutputBytes: opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT,
    finish: (value) => {
      if (value.ok) {
        settle({
          ok: true,
          result: value.result ?? {},
          logs: value.logs ?? [],
          output: live.output,
          frames: [...live.frames].sort((a, b) => a.index - b.index)
        })
      } else {
        settle({ ok: false, error: value.error || 'The render failed', logs: value.logs ?? consoleLogs })
      }
    }
  }

  const settle = (r: HostResult): void => {
    if (settled) return
    settled = true
    clearInterval(watchdog)
    opts.signal?.removeEventListener('abort', onAbort)
    jobs.delete(id)
    const w = win
    win = null
    if (w && !w.isDestroyed()) {
      // A page stuck in a loop never yields to a close; crash it first.
      try {
        w.webContents.forcefullyCrashRenderer()
      } catch {
        // already gone
      }
      w.destroy()
    }
    resolveResult(r)
  }

  const onAbort = (): void => settle({ ok: false, error: 'Cancelled', logs: consoleLogs })
  opts.signal?.addEventListener('abort', onAbort, { once: true })

  const startedAt = Date.now()
  const watchdog = setInterval(() => {
    const now = Date.now()
    if (now - startedAt > timeoutMs) {
      settle({ ok: false, error: `Stopped after ${Math.round(timeoutMs / 1000)}s: the job ran past its time limit`, logs: consoleLogs })
    } else if (now - lastActivity > stallMs) {
      settle({
        ok: false,
        error: `Stopped: the page went ${Math.round(stallMs / 1000)}s without reporting progress (an endless loop in draw/setup/audio, or one frame that takes too long)`,
        logs: consoleLogs
      })
    }
  }, 1000)

  jobs.set(id, live)
  win = new BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    skipTaskbar: true,
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
      spellcheck: false,
      enableWebSQL: false,
      navigateOnDragDrop: false
    }
  })
  const wc = win.webContents
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('will-navigate', (event) => event.preventDefault())
  wc.on('console-message', (event) => {
    const e = event as unknown as { level?: string; message?: string; lineNumber?: number; sourceId?: string }
    if (consoleLogs.length < 40 && e.message) {
      const where = e.sourceId?.endsWith('scene.js') ? ` (scene.js:${e.lineNumber})` : ''
      consoleLogs.push(`[${e.level ?? 'log'}] ${String(e.message).slice(0, 300)}${where}`)
    }
  })
  wc.on('render-process-gone', (_event, details) => {
    settle({
      ok: false,
      error: `The render page crashed (${details.reason}${details.exitCode ? `, exit ${details.exitCode}` : ''}) — usually memory: lower the size, length or number of media inputs`,
      logs: consoleLogs
    })
  })
  wc.on('did-fail-load', (_event, code, description) => {
    settle({ ok: false, error: `The render page failed to load: ${description} (${code})`, logs: consoleLogs })
  })
  void win.loadURL(`${RENDER_SCHEME}://${id}/index.html`).catch(() => undefined)
  return result
}

/** Close every live job (app quit). */
export function cancelAllRenderJobs(): void {
  for (const live of [...jobs.values()]) live.finish({ ok: false, error: 'The app is closing' })
}
