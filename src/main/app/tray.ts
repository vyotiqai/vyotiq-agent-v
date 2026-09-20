import { app, Menu, nativeImage, nativeTheme, Tray } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { logger } from '../../shared/logger'
import { getMainWindow } from './window'

/**
 * Tray icon — the Agent V mark, spinning while runs are active.
 *
 * The frames are pre-rendered (scripts/generate-spinner-frames.mjs) because a
 * tray icon is a bitmap, not a DOM node: the animation styles.css draws live
 * has to be baked. Playback reads its shape from the manifest the same script
 * writes, so re-tuning the spinner there needs no change here.
 *
 * Count comes from a provider passed at boot rather than an import, keeping
 * this module free of any agent/run code — same arrangement as badges.ts.
 */

type TrayManifest = {
  variant: string
  frames: number
  durationMs: number
  sizes: number[]
}

/**
 * Used when the manifest is missing or unreadable. Matching the generator's
 * defaults keeps a broken asset tree to a still icon rather than no tray.
 */
const FALLBACK_MANIFEST: TrayManifest = {
  variant: 'relay',
  frames: 16,
  durationMs: 1200,
  sizes: [16, 32]
}

/**
 * How often an idle tray re-reads the count. This is the delay before a started
 * run shows up in the tray, so it is tighter than a badge debounce; it costs one
 * array length read twice a second, and stops entirely while animating, where
 * the frame tick does the same read anyway.
 */
const IDLE_POLL_MS = 500

/** Frame sentinel for "not animating". */
const IDLE_FRAME = -1

let tray: Tray | null = null
let manifest: TrayManifest = FALLBACK_MANIFEST
let provider: (() => number) | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let frame = IDLE_FRAME
let lastTooltip: string | null = null
let themeListener: (() => void) | null = null
const imageCache = new Map<string, Electron.NativeImage | null>()

function resolveTrayAsset(...segments: string[]): string | null {
  const candidates = app.isPackaged
    ? [
        join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'tray', ...segments),
        join(process.resourcesPath, 'app.asar', 'resources', 'tray', ...segments)
      ]
    : [
        join(process.cwd(), 'resources', 'tray', ...segments),
        join(app.getAppPath(), 'resources', 'tray', ...segments)
      ]
  const found = candidates.find((candidate) => existsSync(candidate))
  return found ?? null
}

function readManifest(): TrayManifest {
  const path = resolveTrayAsset('manifest.json')
  if (!path) {
    logger.warn('Tray manifest missing — falling back to a still icon', { scope: 'main' })
    return FALLBACK_MANIFEST
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<TrayManifest>
    // Frame count drives modular arithmetic on a filename; a zero or a string
    // here would spin the tray through paths that do not exist.
    if (typeof parsed.frames !== 'number' || parsed.frames < 1) return FALLBACK_MANIFEST
    if (typeof parsed.durationMs !== 'number' || parsed.durationMs <= 0) return FALLBACK_MANIFEST
    return { ...FALLBACK_MANIFEST, ...parsed } as TrayManifest
  } catch (err) {
    logger.warn('Reading the tray manifest failed', { scope: 'main', err })
    return FALLBACK_MANIFEST
  }
}

/**
 * macOS draws the menu bar icon from alpha alone, so one template image serves
 * both appearances and following nativeTheme there would be wrong. Elsewhere
 * the directory names the theme the frame is for, not the colour of its ink.
 */
function currentThemeDir(): string {
  if (process.platform === 'darwin') return 'light'
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

function loadFrameImage(theme: string, name: string): Electron.NativeImage | null {
  const key = `${theme}:${name}`
  const cached = imageCache.get(key)
  if (cached !== undefined) return cached

  let image: Electron.NativeImage | null = null
  const base = resolveTrayAsset(theme, '16', `${name}.png`)
  if (base) {
    const rendered = nativeImage.createFromPath(base)
    if (!rendered.isEmpty()) {
      // 16 is the logical size; the 32 is its @2x, so one image covers both a
      // standard and a HiDPI tray without picking a scale factor ourselves.
      const retina = resolveTrayAsset(theme, '32', `${name}.png`)
      if (retina) {
        try {
          rendered.addRepresentation({ scaleFactor: 2, buffer: readFileSync(retina) })
        } catch (err) {
          logger.warn('Adding the @2x tray representation failed', { scope: 'main', err })
        }
      }
      rendered.setTemplateImage(process.platform === 'darwin')
      image = rendered
    }
  }
  if (!image) {
    logger.warn('Tray frame asset missing', { scope: 'main', theme, frame: name })
  }
  imageCache.set(key, image)
  return image
}

function applyFrame(next: number): void {
  if (!tray || tray.isDestroyed()) return
  const name = next === IDLE_FRAME ? 'idle' : String(next).padStart(2, '0')
  const image = loadFrameImage(currentThemeDir(), name)
  if (!image) return
  try {
    tray.setImage(image)
  } catch (err) {
    logger.warn('Applying the tray image failed', { scope: 'main', err })
  }
}

function applyTooltip(count: number): void {
  if (!tray || tray.isDestroyed()) return
  const text = count > 0 ? `Vyotiq — ${count} run${count === 1 ? '' : 's'} active` : 'Vyotiq'
  if (text === lastTooltip) return
  lastTooltip = text
  try {
    tray.setToolTip(text)
  } catch (err) {
    logger.warn('Applying the tray tooltip failed', { scope: 'main', err })
  }
}

function readActiveRunCount(): number {
  if (!provider) return 0
  try {
    const count = provider()
    return Number.isFinite(count) && count > 0 ? count : 0
  } catch (err) {
    logger.warn('Tray run-count provider failed', { scope: 'main', err })
    return 0
  }
}

function schedule(ms: number): void {
  if (!tray || tray.isDestroyed()) return
  timer = setTimeout(tick, ms)
}

function tick(): void {
  timer = null
  if (!tray || tray.isDestroyed()) return
  const count = readActiveRunCount()
  if (count > 0) {
    // A chain rather than setInterval: a slow setImage then delays the next
    // frame instead of stacking one behind it.
    frame = frame === IDLE_FRAME ? 0 : (frame + 1) % manifest.frames
    applyFrame(frame)
    schedule(manifest.durationMs / manifest.frames)
  } else {
    if (frame !== IDLE_FRAME) {
      frame = IDLE_FRAME
      applyFrame(IDLE_FRAME)
    }
    schedule(IDLE_POLL_MS)
  }
  applyTooltip(count)
}

function revealMainWindow(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  // Same restore/focus pair the second-instance handler uses, plus a show:
  // the tray is reachable while the window is hidden, which that path is not.
  if (!win.isVisible()) win.show()
  if (win.isMinimized()) win.restore()
  win.focus()
}

export function createTray(options: { getActiveRunCount: () => number }): void {
  if (tray) {
    logger.warn('Tray already created', { scope: 'main' })
    return
  }
  provider = options.getActiveRunCount
  manifest = readManifest()

  const idle = loadFrameImage(currentThemeDir(), 'idle')
  if (!idle) {
    // No assets means no tray. Boot continues: the window and the taskbar
    // badge are the app's primary surfaces, and neither depends on this.
    logger.warn('Tray not created — idle frame unavailable', { scope: 'main' })
    provider = null
    return
  }

  try {
    tray = new Tray(idle)
  } catch (err) {
    // Linux without a StatusNotifier host is the common case here.
    logger.warn('Creating the tray failed', { scope: 'main', err })
    tray = null
    provider = null
    return
  }

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Vyotiq', click: revealMainWindow },
      { type: 'separator' },
      { label: 'Quit Vyotiq', click: () => app.quit() }
    ])
  )
  tray.on('click', revealMainWindow)
  applyTooltip(readActiveRunCount())

  themeListener = () => {
    // Cached per theme, so the swap is a map hit; the running frame is
    // re-applied rather than waiting up to a full cycle to repaint.
    applyFrame(frame)
  }
  nativeTheme.on('updated', themeListener)

  tick()
}

export function destroyTray(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  if (themeListener) {
    nativeTheme.off('updated', themeListener)
    themeListener = null
  }
  if (tray && !tray.isDestroyed()) {
    try {
      tray.destroy()
    } catch (err) {
      logger.warn('Destroying the tray failed', { scope: 'main', err })
    }
  }
  tray = null
  provider = null
  frame = IDLE_FRAME
  lastTooltip = null
  imageCache.clear()
}
