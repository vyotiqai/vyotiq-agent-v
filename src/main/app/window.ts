import { BrowserWindow, nativeTheme } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import icon from '../../../resources/icon.png?asset'
import { attachSecurity } from '@main/app/security'
import { getSettings } from '@main/settings/settings'
import type { ThemeId } from '../../shared/ipc'
import { resolveTheme } from '../../shared/theme'
import { resolveSkinWindowBackground } from '../../shared/skins'
import type { SkinId } from '../../shared/skins'
import { IPC } from '../../shared/channels'
import {
  MACOS_TRAFFIC_LIGHT_X,
  MACOS_TRAFFIC_LIGHT_Y
} from '../../shared/windowChrome'
import { attachWebContentsCrashLogging } from '@main/logging/init'
import { logger } from '../../shared/logger'

let mainWindow: BrowserWindow | null = null

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

function resolvedThemeForWindow(theme: ThemeId): 'light' | 'dark' {
  return resolveTheme(theme, nativeTheme.shouldUseDarkColors)
}

function windowBackground(theme: ThemeId, skinId: SkinId): string {
  return resolveSkinWindowBackground(skinId, resolvedThemeForWindow(theme), process.platform)
}

function appIconPath(): string {
  const fileName = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  const candidates = is.dev
    ? [join(process.cwd(), 'resources', fileName), icon]
    : [
        join(process.resourcesPath, 'app.asar.unpacked', 'resources', fileName),
        join(process.resourcesPath, 'app.asar', 'resources', fileName)
      ]

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}

export function applyTitleBarTheme(theme: ThemeId, skinId?: SkinId): void {
  if (!mainWindow) return
  const skin = skinId ?? getSettings().skinId
  mainWindow.setBackgroundColor(windowBackground(theme, skin))
}

export function applyWindowChrome(theme: ThemeId, skinId?: SkinId): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const skin = skinId ?? getSettings().skinId
  applyTitleBarTheme(theme, skin)
}

function attachWindowStatePush(win: BrowserWindow): void {
  const push = (): void => {
    if (win.isDestroyed()) return
    win.webContents.send(IPC.windowMaximizedChanged, win.isMaximized())
  }
  win.on('maximize', push)
  win.on('unmaximize', push)
  win.on('enter-full-screen', push)
  win.on('leave-full-screen', push)
  win.on('focus', () => {
    if (!win.isDestroyed()) win.webContents.send(IPC.windowFocusChanged, true)
  })
  win.on('blur', () => {
    if (!win.isDestroyed()) win.webContents.send(IPC.windowFocusChanged, false)
  })
}

export function createWindow(): BrowserWindow {
  const settings = getSettings()

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 560,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    // Custom renderer controls own the top-right on win/linux — no titleBarOverlay.
    ...(process.platform === 'darwin'
      ? {
          trafficLightPosition: { x: MACOS_TRAFFIC_LIGHT_X, y: MACOS_TRAFFIC_LIGHT_Y }
        }
      : {}),
    backgroundColor: windowBackground(settings.theme, settings.skinId),
    icon: appIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  applyWindowChrome(settings.theme, settings.skinId)
  attachSecurity(mainWindow)
  attachWindowStatePush(mainWindow)
  attachWebContentsCrashLogging(mainWindow.webContents)

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']).catch((err: unknown) => {
      logger.error('Failed to load renderer URL', { scope: 'main', err })
    })
    // Open after first paint so DevTools detach does not race renderer boot / logging IPC.
    mainWindow.webContents.once('did-finish-load', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return
        mainWindow.webContents.openDevTools({ mode: 'detach' })
      }, 750)
    })
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html')).catch((err: unknown) => {
      logger.error('Failed to load renderer file', { scope: 'main', err })
    })
  }

  return mainWindow
}
