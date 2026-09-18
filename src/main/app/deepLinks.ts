import { app } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { IPC } from '../../shared/channels'
import {
  DEEP_LINK_SCHEME,
  extractDeepLinkUrlFromArgv,
  parseDeepLinkUrl
} from '../../shared/deepLink'
import type { DeepLinkPayload } from '../../shared/ipc'
import { logger } from '../../shared/logger'
import { getMainWindow } from './window'

/**
 * Latest deep link that arrived before the renderer could consume it. Deep
 * links are user-intent clicks, so the most recent one wins; the slot is
 * drained by `deeplink:consume` on renderer mount (cold start, recreate-window).
 */
let pendingDeepLink: DeepLinkPayload | null = null

function workspaceDirectoryExists(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

function sendToRenderer(payload: DeepLinkPayload): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  try {
    win.webContents.send(IPC.deepLinkOpened, payload)
  } catch (err) {
    logger.warn('Deep link push to renderer failed', { scope: 'main', err })
  }
}

/** Entry point for every OS-level deep-link delivery path. */
export function handleDeepLinkUrl(raw: string): void {
  const parsed = parseDeepLinkUrl(raw)
  if (!parsed) {
    logger.warn('Ignoring unrecognized deep link', {
      scope: 'main',
      url: raw.slice(0, 512)
    })
    pendingDeepLink = { rawUrl: raw.slice(0, 4096), target: null }
    sendToRenderer(pendingDeepLink)
    return
  }
  if (parsed.workspacePath && !workspaceDirectoryExists(parsed.workspacePath)) {
    logger.warn('Deep link workspace path does not exist', {
      scope: 'main',
      workspacePath: parsed.workspacePath
    })
    pendingDeepLink = { rawUrl: raw.slice(0, 4096), target: null }
    sendToRenderer(pendingDeepLink)
    return
  }
  const payload: DeepLinkPayload = {
    rawUrl: raw.slice(0, 4096),
    target: { type: 'open_run', workspacePath: parsed.workspacePath, runId: parsed.runId }
  }
  pendingDeepLink = payload
  sendToRenderer(payload)
}

/** Drain the pending slot; the renderer calls this on mount to pick up cold-start links. */
export function consumePendingDeepLink(): DeepLinkPayload | null {
  const pending = pendingDeepLink
  pendingDeepLink = null
  return pending
}

/** Register the OS-level plumbing. Must run before `whenReady` (macOS cold start). */
export function registerDeepLinks(): void {
  // Packaged installs get registration from electron-builder; register here so
  // dev runs (`pnpm start`) and machines where the installer entry was skipped
  // still resolve vyotiq:// URLs.
  if (process.defaultApp) {
    if (process.argv.length >= 2 && process.argv[1]) {
      app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [
        path.resolve(process.argv[1])
      ])
    }
  } else {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME)
  }

  app.on('open-url', (event, url) => {
    event.preventDefault()
    handleDeepLinkUrl(url)
  })
}

/** Windows/Linux: the OS hands the URL to a second instance's argv. */
export function handleDeepLinkArgv(argv: readonly string[]): void {
  const url = extractDeepLinkUrlFromArgv(argv)
  if (url) handleDeepLinkUrl(url)
}
