import { app, nativeImage, type BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { computeBadgeState, dockBadgeTextFor, type BadgeInput, type BadgeState } from './badgeState'
import { logger } from '../../shared/logger'
import { getMainWindow } from './window'

/**
 * Taskbar badge (Windows overlay icon; macOS dock badge for parity).
 * State comes from a provider registered at boot — this module imports no
 * agent/notification code, so the stores can notify it without import cycles.
 */

let provider: (() => BadgeInput) | null = null
let refreshTimer: ReturnType<typeof setTimeout> | null = null
const imageCache = new Map<string, Electron.NativeImage | null>()
let lastAppliedKey: string | null = null
let lastOverlayWinId: number | null = null

export function setBadgeProvider(next: () => BadgeInput): void {
  provider = next
}

/** Mutation sites call this; application is debounced so bursts coalesce. */
export function notifyBadgeChange(): void {
  if (refreshTimer !== null) return
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    applyBadgeNow()
  }, 120)
}

function resolveBadgeAsset(fileName: string): string | null {
  const candidates = app.isPackaged
    ? [
        join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'badges', fileName),
        join(process.resourcesPath, 'app.asar', 'resources', 'badges', fileName)
      ]
    : [
        join(process.cwd(), 'resources', 'badges', fileName),
        join(app.getAppPath(), 'resources', 'badges', fileName)
      ]
  const found = candidates.find((candidate) => existsSync(candidate))
  return found ?? null
}

function loadBadgeImage(fileName: string): Electron.NativeImage | null {
  const cached = imageCache.get(fileName)
  if (cached !== undefined) return cached
  let image: Electron.NativeImage | null = null
  const path = resolveBadgeAsset(fileName)
  if (path) {
    const rendered = nativeImage.createFromPath(path)
    if (!rendered.isEmpty()) image = rendered
  }
  if (!image) {
    logger.warn('Badge overlay asset missing', { scope: 'main', file: fileName })
  }
  imageCache.set(fileName, image)
  return image
}

function descriptionFor(state: BadgeState): string {
  switch (state.kind) {
    case 'needsyou':
      return `${state.count >= 10 ? '9+' : state.count} agent${
        state.count === 1 ? '' : 's'
      } waiting for your approval`
    case 'unread':
      return `${state.count >= 10 ? '9+' : state.count} unread notification${
        state.count === 1 ? '' : 's'
      }`
    case 'working':
      return 'Runs active'
    case 'idle':
      return ''
  }
}

function applyOverlay(win: BrowserWindow, state: BadgeState): void {
  if (state.kind === 'idle') {
    win.setOverlayIcon(null, '')
    return
  }
  const fileName =
    state.kind === 'working'
      ? 'working.png'
      : `${state.kind}-${state.count}.png`
  const image = loadBadgeImage(fileName)
  if (!image) {
    win.setOverlayIcon(null, '')
    return
  }
  win.setOverlayIcon(image, descriptionFor(state))
}

function applyDock(state: BadgeState): void {
  // macOS parity: same state machine, dock-native text dialect. `app.dock`
  // is undefined off macOS. Applied even with no window — on macOS the app
  // outlives a closed window while runs keep going.
  const dock = app.dock
  if (!dock) return
  try {
    dock.setBadge(dockBadgeTextFor(state))
  } catch (err) {
    logger.warn('Applying dock badge failed', { scope: 'main', err })
  }
}

function overlayKeyFor(state: BadgeState): string {
  return state.kind === 'working' || state.kind === 'idle'
    ? state.kind
    : `${state.kind}:${state.count}`
}

export function applyBadgeNow(): void {
  if (!provider) return
  let state: BadgeState
  try {
    state = computeBadgeState(provider())
  } catch (err) {
    logger.warn('Badge provider failed', { scope: 'main', err })
    return
  }
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    const key = overlayKeyFor(state)
    // A recreated window must re-receive its overlay even when the state
    // key is unchanged (new window owns none of the old overlay).
    if (key !== lastAppliedKey || win.id !== lastOverlayWinId) {
      try {
        applyOverlay(win, state)
        lastAppliedKey = key
        lastOverlayWinId = win.id
      } catch (err) {
        logger.warn('Applying taskbar badge failed', { scope: 'main', err })
      }
    }
  }
  applyDock(state)
}
