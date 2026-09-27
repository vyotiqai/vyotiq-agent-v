import { BaseWindow, WebContentsView, app, desktopCapturer, screen, session, type WebContents } from 'electron'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { abortError } from '../../shared/errors'
import { getMainWindow } from '@main/app/window'
import { clampSnipFrames, clampSnipInterval } from './snipLimits'

/**
 * Screen and window snips for the agent: a live capture stream of one window
 * or display, read frame by frame.
 *
 * Measured with standalone Electron 44 probes before this was written:
 * `desktopCapturer.getSources` thumbnails cost ~700ms per call (every window is
 * re-captured) and are scaled *up* to the requested size, so a 640x400 window
 * came back at 3725x2160. A capture stream gives the native size and a fresh
 * frame in 15-50ms. The stream needs a secure context (a file page; data: and
 * about:blank have no mediaDevices) in a window that is shown: a hidden
 * BaseWindow host returned the same stale frame every time. So the host is an
 * opacity-0, click-through window shown only while a snip runs, like the
 * agent browser's offstage window, and a BaseWindow so
 * `BrowserWindow.getAllWindows()` (IPC broadcasts) never sees it.
 */

/**
 * Longest edge of an uncropped snip. It is also the coordinate space `region`
 * is measured in, so the model can crop what it just saw.
 */
export const SCREEN_SNIP_FULL_EDGE = 1280
/** Longest edge of a region snip: a crop is for detail, so it keeps more. */
export const SCREEN_SNIP_REGION_EDGE = 1568
const JPEG_QUALITY = 0.8
/** The host window is torn down this long after the last snip. */
const HOST_IDLE_MS = 30_000
/** In-memory partition: the host page needs `media` and nothing else. */
const PARTITION = 'vyotiq-screen-snip'
const MAX_LISTED_WINDOWS = 30
const MAX_TITLE_CHARS = 120

const HOST_HTML =
  '<!doctype html><meta charset="utf-8">' +
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'">` +
  '<title>Vyotiq screen snip</title>'

export type ScreenSnipTarget =
  | { kind: 'window'; title: string }
  | { kind: 'display'; index?: number }

/** Rectangle in the uncropped snip's pixels (see SCREEN_SNIP_FULL_EDGE). */
export type ScreenSnipRegion = { x: number; y: number; width: number; height: number }

export type ScreenSnipFrame = {
  jpeg: Buffer
  width: number
  height: number
  /** Milliseconds after the first frame. */
  atMs: number
}

export type ScreenSnipResult = {
  source: { kind: 'window' | 'display'; name: string }
  /** Size of the uncropped snip: the space `region` is measured in. */
  full: { width: number; height: number }
  native: { width: number; height: number }
  /** The region actually captured, clamped to the snip. */
  region?: ScreenSnipRegion
  frames: ScreenSnipFrame[]
  /** Other window titles the query matched; the first match was taken. */
  otherMatches: string[]
}

export type SnipDisplay = { index: number; width: number; height: number; primary: boolean }
export type SnipSources = { windows: string[]; displays: SnipDisplay[] }

type Source = Electron.DesktopCapturerSource

let host: { win: BaseWindow; view: WebContentsView } | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let chain: Promise<unknown> = Promise.resolve()

function clampTitle(name: string): string {
  const flat = name.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_TITLE_CHARS ? `${flat.slice(0, MAX_TITLE_CHARS - 1)}…` : flat
}

/** Window handle part of a media source id (`window:<handle>:<n>`). */
function handleOf(mediaSourceId: string): string {
  return mediaSourceId.split(':')[1] ?? ''
}

/**
 * Our own invisible helper windows (this host, the agent browser's offstage
 * window) are real windows to the OS. Snipping one returns nothing useful.
 */
function ownHelperHandles(): Set<string> {
  const out = new Set<string>()
  for (const win of BaseWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed() && win.getOpacity() === 0) out.add(handleOf(win.getMediaSourceId()))
    } catch {
      // A window torn down mid-walk has no id to exclude.
    }
  }
  return out
}

async function windowSources(): Promise<Source[]> {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false
  })
  const own = ownHelperHandles()
  return sources.filter((s) => s.name.trim() && !own.has(handleOf(s.id)))
}

function displayList(): SnipDisplay[] {
  const primaryId = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map((d, index) => ({
    index,
    width: Math.round(d.size.width * d.scaleFactor),
    height: Math.round(d.size.height * d.scaleFactor),
    primary: d.id === primaryId
  }))
}

export async function listSnipSources(): Promise<SnipSources> {
  const windows = (await windowSources()).map((s) => clampTitle(s.name)).slice(0, MAX_LISTED_WINDOWS)
  return { windows, displays: displayList() }
}

/** Best match first: exact title, then prefix, then substring (case-insensitive). */
function pickWindow(sources: Source[], query: string): { source: Source; others: string[] } | null {
  const q = query.trim().toLowerCase()
  const exact = sources.filter((s) => s.name.trim().toLowerCase() === q)
  const prefix = sources.filter((s) => !exact.includes(s) && s.name.toLowerCase().startsWith(q))
  const partial = sources.filter(
    (s) => !exact.includes(s) && !prefix.includes(s) && s.name.toLowerCase().includes(q)
  )
  const ranked = [...exact, ...prefix, ...partial]
  const first = ranked[0]
  if (!first) return null
  return { source: first, others: ranked.slice(1, 6).map((s) => clampTitle(s.name)) }
}

async function resolveSource(
  target: ScreenSnipTarget
): Promise<{ source: Source; name: string; kind: 'window' | 'display'; others: string[] }> {
  if (target.kind === 'window') {
    const sources = await windowSources()
    const hit = pickWindow(sources, target.title)
    if (!hit) {
      const open = sources.slice(0, MAX_LISTED_WINDOWS).map((s) => JSON.stringify(clampTitle(s.name)))
      throw new Error(
        `No open window title contains ${JSON.stringify(target.title)}. Minimized windows cannot be ` +
          `snipped; restore it first. Open windows: ${open.length ? open.join(', ') : '(none)'}`
      )
    }
    return { source: hit.source, name: clampTitle(hit.source.name), kind: 'window', others: hit.others }
  }
  const displays = screen.getAllDisplays()
  const list = displayList()
  const index = target.index ?? Math.max(0, list.findIndex((d) => d.primary))
  const display = displays[index]
  if (!display) {
    throw new Error(`No display ${index}. Displays: ${list.map((d) => d.index).join(', ')}`)
  }
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false
  })
  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[index]
  if (!source) throw new Error(`Display ${index} is not available for capture`)
  const info = list[index]!
  const name = `display ${index} (${info.width}x${info.height}${info.primary ? ', primary' : ''})`
  return { source, name, kind: 'display', others: [] }
}

function destroyHost(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  const current = host
  host = null
  if (!current) return
  try {
    if (!current.view.webContents.isDestroyed()) current.view.webContents.close()
  } catch {
    // Already gone with its window.
  }
  if (!current.win.isDestroyed()) current.win.destroy()
}

function hostPagePath(): string {
  const dir = join(app.getPath('userData'), 'screen-snip')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'host.html')
  // Rewritten on every host start, so a stale or edited copy is never loaded.
  writeFileSync(file, HOST_HTML)
  return file
}

async function ensureHost(): Promise<{ win: BaseWindow; wc: WebContents }> {
  if (host && !host.win.isDestroyed() && !host.view.webContents.isDestroyed()) {
    return { win: host.win, wc: host.view.webContents }
  }
  destroyHost()
  const ses = session.fromPartition(PARTITION)
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'media'))
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'media')
  const win = new BaseWindow({
    width: 16,
    height: 16,
    show: false,
    frame: false,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    hasShadow: false,
    opacity: 0,
    title: 'Vyotiq screen snip'
  })
  win.setIgnoreMouseEvents(true)
  // Linux has no window opacity; keep the window off every screen there.
  if (process.platform === 'linux') win.setPosition(-20000, -20000)
  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  view.webContents.on('will-navigate', (event) => event.preventDefault())
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 16, height: 16 })
  host = { win, view }
  // A hidden window would otherwise keep the app alive after the last real one closes.
  getMainWindow()?.once('closed', destroyHost)
  try {
    await view.webContents.loadFile(hostPagePath())
  } catch (err) {
    destroyHost()
    throw err
  }
  return { win, wc: view.webContents }
}

function scheduleIdleTeardown(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(destroyHost, HOST_IDLE_MS)
  idleTimer.unref?.()
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const done = (): void => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    const timer = setTimeout(done, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError())
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

const START_STREAM = `(async (id) => {
  if (window.__snip) { try { window.__snip.track.stop() } catch {} window.__snip = null }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: id, maxWidth: 7680, maxHeight: 4320, maxFrameRate: 30 } }
    })
    const track = stream.getVideoTracks()[0]
    if (!track) return { error: 'no video track' }
    window.__snip = { track, capture: new ImageCapture(track) }
    return { ok: true }
  } catch (e) {
    return { error: (e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : String(e)) }
  }
})`

const GRAB_FRAME = `(async (o) => {
  const s = window.__snip
  if (!s || s.track.readyState !== 'live') return { error: 'ended' }
  let bmp
  try { bmp = await s.capture.grabFrame() } catch (e) {
    return { error: s.track.readyState === 'live' ? 'no frame: ' + (e && e.message ? e.message : String(e)) : 'ended' }
  }
  const nw = bmp.width, nh = bmp.height
  const k = Math.min(1, o.fullEdge / Math.max(nw, nh))
  const fw = Math.max(1, Math.round(nw * k)), fh = Math.max(1, Math.round(nh * k))
  let sx = 0, sy = 0, sw = nw, sh = nh, region = null
  if (o.region) {
    const x0 = Math.max(0, Math.min(fw, o.region.x)), y0 = Math.max(0, Math.min(fh, o.region.y))
    const x1 = Math.max(0, Math.min(fw, o.region.x + o.region.width)), y1 = Math.max(0, Math.min(fh, o.region.y + o.region.height))
    if (x1 - x0 < 1 || y1 - y0 < 1) { bmp.close(); return { error: 'outside', fullWidth: fw, fullHeight: fh } }
    region = { x: Math.round(x0), y: Math.round(y0), width: Math.round(x1 - x0), height: Math.round(y1 - y0) }
    sx = Math.floor(x0 / k); sy = Math.floor(y0 / k)
    sw = Math.max(1, Math.min(nw - sx, Math.ceil((x1 - x0) / k)))
    sh = Math.max(1, Math.min(nh - sy, Math.ceil((y1 - y0) / k)))
  }
  const ok = Math.min(1, o.outEdge / Math.max(sw, sh))
  const dw = Math.max(1, Math.round(sw * ok)), dh = Math.max(1, Math.round(sh * ok))
  const canvas = new OffscreenCanvas(dw, dh)
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, dw, dh)
  bmp.close()
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: o.quality })
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
  return { dataUrl, width: dw, height: dh, nativeWidth: nw, nativeHeight: nh, fullWidth: fw, fullHeight: fh, region }
})`

const STOP_STREAM = `(() => { if (window.__snip) { try { window.__snip.track.stop() } catch {} window.__snip = null } return true })()`

type GrabResult =
  | {
      dataUrl: string
      width: number
      height: number
      nativeWidth: number
      nativeHeight: number
      fullWidth: number
      fullHeight: number
      region: ScreenSnipRegion | null
    }
  | { error: string; fullWidth?: number; fullHeight?: number }

function streamStartError(raw: string, kind: 'window' | 'display'): Error {
  if (process.platform === 'darwin' && /NotAllowed|Permission|NotReadable/i.test(raw)) {
    return new Error(
      'macOS blocked screen capture. Allow Vyotiq under System Settings > Privacy & Security > ' +
        `Screen Recording, then retry. (${raw})`
    )
  }
  if (/NotFound|NotReadable|Could not start/i.test(raw) && kind === 'window') {
    return new Error(`The window could not be captured; it may have closed or been minimized. (${raw})`)
  }
  return new Error(`Screen capture failed to start: ${raw}`)
}

export async function snipScreen(opts: {
  target: ScreenSnipTarget
  region?: ScreenSnipRegion
  frames?: number
  intervalMs?: number
  signal?: AbortSignal
}): Promise<ScreenSnipResult> {
  // One stream at a time: the host page holds a single capture.
  const run = chain.then(() => snipScreenUnlocked(opts))
  chain = run.catch(() => undefined)
  return run
}

async function snipScreenUnlocked(opts: {
  target: ScreenSnipTarget
  region?: ScreenSnipRegion
  frames?: number
  intervalMs?: number
  signal?: AbortSignal
}): Promise<ScreenSnipResult> {
  const { signal } = opts
  throwIfAborted(signal)
  const frameCount = clampSnipFrames(opts.frames)
  const interval = clampSnipInterval(opts.intervalMs)
  const resolved = await resolveSource(opts.target)
  throwIfAborted(signal)
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  const { win, wc } = await ensureHost()
  win.showInactive()
  const frames: ScreenSnipFrame[] = []
  let full = { width: 0, height: 0 }
  let native = { width: 0, height: 0 }
  let region: ScreenSnipRegion | undefined
  try {
    const started = (await wc.executeJavaScript(
      `${START_STREAM}(${JSON.stringify(resolved.source.id)})`,
      true
    )) as { ok?: true; error?: string }
    if (!started?.ok) throw streamStartError(started?.error ?? 'unknown error', resolved.kind)
    const grabOpts = JSON.stringify({
      fullEdge: SCREEN_SNIP_FULL_EDGE,
      outEdge: opts.region ? SCREEN_SNIP_REGION_EDGE : SCREEN_SNIP_FULL_EDGE,
      region: opts.region ?? null,
      quality: JPEG_QUALITY
    })
    let firstAt = 0
    for (let i = 0; i < frameCount; i++) {
      if (i > 0) await sleep(firstAt + i * interval - Date.now(), signal)
      throwIfAborted(signal)
      const grabbed = (await wc.executeJavaScript(`${GRAB_FRAME}(${grabOpts})`)) as GrabResult
      const at = Date.now()
      if (i === 0) firstAt = at
      if ('error' in grabbed) {
        if (grabbed.error === 'outside') {
          throw new Error(
            `region lies outside the ${grabbed.fullWidth}x${grabbed.fullHeight} snip; ` +
              'measure it on an uncropped snip first'
          )
        }
        if (grabbed.error === 'ended') {
          // Keep what the burst already has: the frames before the window went away still count.
          if (frames.length > 0) break
          throw new Error('The capture ended before a frame arrived; the window may have closed or been minimized.')
        }
        throw new Error(`Screen capture returned no frame (${grabbed.error})`)
      }
      const base64 = grabbed.dataUrl.slice(grabbed.dataUrl.indexOf(',') + 1)
      frames.push({
        jpeg: Buffer.from(base64, 'base64'),
        width: grabbed.width,
        height: grabbed.height,
        atMs: at - firstAt
      })
      full = { width: grabbed.fullWidth, height: grabbed.fullHeight }
      native = { width: grabbed.nativeWidth, height: grabbed.nativeHeight }
      region = grabbed.region ?? undefined
    }
  } finally {
    try {
      if (!wc.isDestroyed()) await wc.executeJavaScript(STOP_STREAM)
    } catch {
      // The page went with its window; nothing is left streaming.
    }
    if (!win.isDestroyed()) win.hide()
    scheduleIdleTeardown()
  }
  return {
    source: { kind: resolved.kind, name: resolved.name },
    full,
    native,
    ...(region ? { region } : {}),
    frames,
    otherMatches: resolved.others
  }
}

/** Test and shutdown hook. */
export function disposeScreenSnip(): void {
  destroyHost()
  chain = Promise.resolve()
}
