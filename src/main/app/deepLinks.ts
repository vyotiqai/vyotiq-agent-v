import { app } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { IPC } from '../../shared/channels'
import {
  DEEP_LINK_SCHEME,
  extractDeepLinkUrlFromArgv,
  parseDeepLinkUrl
} from '../../shared/deepLink'
import type { DeepLinkPayload, DeepLinkTarget } from '../../shared/ipc'
import { logger } from '../../shared/logger'
import { canonicalizeWorkspacePath } from '../../shared/utils/workspacePath'
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

/**
 * The folder named on a command line (`Vyotiq.exe C:\repo`, `vyotiq .`), or
 * null. Positional arguments only, from `start` on (a dev run's argv[1] is the
 * app itself); switches Chromium or the shell add are skipped. A relative path
 * resolves against the launching process's folder, and it must exist as a
 * directory: a file or a typo opens nothing.
 */
export function workspacePathFromArgv(
  argv: readonly string[],
  { start, cwd, isDirectory = workspaceDirectoryExists }: { start: number; cwd: string; isDirectory?: (p: string) => boolean }
): string | null {
  for (let i = argv.length - 1; i >= start; i -= 1) {
    const arg = argv[i]
    if (typeof arg !== 'string' || !arg.trim() || arg.startsWith('-')) continue
    if (arg.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}:`)) continue
    const resolved = path.resolve(cwd, arg.trim())
    if (isDirectory(resolved)) return canonicalizeWorkspacePath(resolved)
  }
  return null
}

/** Where a command line's own arguments start: past the exe, and past the app path in a dev run. */
export function argvStart(): number {
  return process.defaultApp ? 2 : 1
}

function deliver(rawUrl: string, target: DeepLinkTarget | null): void {
  pendingDeepLink = { rawUrl: rawUrl.slice(0, 4096), target }
  sendToRenderer(pendingDeepLink)
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
    deliver(raw, null)
    return
  }
  deliver(raw, parsed)
}

/** A folder named on the command line or dropped on the Dock icon: open it as a workspace. */
export function handleOpenFolder(folder: string): void {
  if (!workspaceDirectoryExists(folder)) return
  const workspacePath = canonicalizeWorkspacePath(folder)
  deliver(workspacePath, { type: 'open_workspace', workspacePath, fromCommandLine: true })
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
  // macOS: a folder dropped on the Dock icon, or `open -a "Agent V" ~/repo`.
  app.on('open-file', (event, file) => {
    if (!workspaceDirectoryExists(file)) return
    event.preventDefault()
    handleOpenFolder(file)
  })
}

/**
 * Windows/Linux: a vyotiq:// URL, or a folder (`Vyotiq.exe C:\repo`, Explorer's
 * "Open in Agent V"), in our own argv at a cold start or in a second
 * instance's. `cwd` is the folder that instance was started in.
 */
export function handleDeepLinkArgv(argv: readonly string[], cwd: string = process.cwd()): void {
  const url = extractDeepLinkUrlFromArgv(argv)
  if (url) {
    handleDeepLinkUrl(url)
    return
  }
  const folder = workspacePathFromArgv(argv, { start: argvStart(), cwd })
  if (folder) handleOpenFolder(folder)
}
