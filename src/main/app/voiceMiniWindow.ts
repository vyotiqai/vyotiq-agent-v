import { app, BrowserWindow, nativeTheme, screen } from 'electron'
import { join } from 'path'
import { getMainWindow } from '@main/app/window'
import { getSettings } from '@main/settings/settings'
import { attachWebContentsCrashLogging } from '@main/logging/init'
import { resolveTheme } from '../../shared/theme'
import { resolveSkinWindowBackground } from '../../shared/skins'
import { IPC } from '../../shared/channels'
import { VOICE_MINI_SIZE, type VoiceMiniCommand, type VoiceMiniLevel, type VoiceMiniState } from '../../shared/ipc/schemas/voiceMini'
import { logger } from '../../shared/logger'

/*
  The voice mini window (docs/voice-mode.md §26.5): a small frameless window
  that stays on top of other apps, so you can talk from your editor. It
  MIRRORS the main window's session (2026-10-15 decision): the mic, the
  player and the session controller stay in the main window, which pushes
  what to draw here and gets this window's clicks back. This file owns the
  window and relays between the two; it holds no session state of its own.

  It loads the same renderer as the main window with `#voice-mini`, under
  the same sandboxed preload, but it is NOT the main window: every other IPC
  handler refuses it (`senderOk`), and the voice:mini-* handlers below accept
  only it (or only the main window), each for its own direction.
*/

let mini: BrowserWindow | null = null
/** The last state pushed, for a window that finishes loading after it was sent. */
let lastState: VoiceMiniState | null = null
let open = false

export function getVoiceMiniWindow(): BrowserWindow | null {
  return mini && !mini.isDestroyed() ? mini : null
}

/** Top right of the screen the main window is on, inside its work area. */
function position(size: { width: number; height: number }): { x: number; y: number } {
  const main = getMainWindow()
  const display = main && !main.isDestroyed() ? screen.getDisplayMatching(main.getBounds()) : screen.getPrimaryDisplay()
  const area = display.workArea
  return { x: Math.round(area.x + area.width - size.width - 24), y: Math.round(area.y + 24) }
}

function background(): string {
  const settings = getSettings()
  return resolveSkinWindowBackground(settings.skinId, resolveTheme(settings.theme, nativeTheme.shouldUseDarkColors), process.platform)
}

/** Open the mini window (or bring it back). */
export function openVoiceMiniWindow(): BrowserWindow {
  const existing = getVoiceMiniWindow()
  if (existing) {
    existing.showInactive()
    return existing
  }
  const size = VOICE_MINI_SIZE.pill
  const { x, y } = position(size)
  const win = new BrowserWindow({
    width: size.width,
    height: size.height,
    x,
    y,
    frame: false,
    transparent: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: 'Agent V voice',
    backgroundColor: background(),
    roundedCorners: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
  // Above full-screen apps too, where the OS allows it.
  win.setAlwaysOnTop(true, 'floating')
  mini = win
  open = true
  // It belongs to the main window's session: it goes when that window does.
  // One hook per open, taken off when this one closes, or they pile up on the main window.
  const owner = getMainWindow()
  owner?.once('closed', closeVoiceMiniWindow)

  // It never opens anything or goes anywhere: no new windows, no navigation.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.on('will-redirect', (event) => event.preventDefault())
  attachWebContentsCrashLogging(win.webContents)

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.showInactive()
  })
  win.webContents.on('did-finish-load', () => {
    if (lastState && !win.isDestroyed()) win.webContents.send(IPC.voiceMiniState, lastState)
  })
  win.on('closed', () => {
    if (owner && !owner.isDestroyed()) owner.removeListener('closed', closeVoiceMiniWindow)
    if (mini === win) mini = null
    // Closed from the OS (not by the main window): the main window shows the session itself again.
    if (open) {
      open = false
      sendToMain({ kind: 'closed' })
    }
  })

  // As the main window loads it: the dev server in development, the built file otherwise.
  const rendererUrl = !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined
  const load = rendererUrl ? win.loadURL(`${rendererUrl}#voice-mini`) : win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'voice-mini' })
  void load.catch((err: unknown) => logger.warn('Voice mini window failed to load', { scope: 'voice', err }))
  return win
}

export function closeVoiceMiniWindow(): void {
  open = false
  lastState = null
  const win = getVoiceMiniWindow()
  if (win) win.close()
  mini = null
}

/** The pill at rest, the card while open; it grows down from its top edge, so the row you pointed at stays put. */
export function resizeVoiceMiniWindow(opened: boolean): void {
  const win = getVoiceMiniWindow()
  if (!win) return
  const size = opened ? VOICE_MINI_SIZE.card : VOICE_MINI_SIZE.pill
  const [x, y] = win.getPosition()
  const area = screen.getDisplayMatching(win.getBounds()).workArea
  // Opening near the bottom of the screen: grow upwards instead, keeping it on screen.
  const top = y! + size.height > area.y + area.height ? Math.max(area.y, area.y + area.height - size.height) : y!
  win.setBounds({ x: x!, y: top, width: size.width, height: size.height }, false)
}

export function pushVoiceMiniState(state: VoiceMiniState): void {
  lastState = state
  const win = getVoiceMiniWindow()
  if (win && !win.webContents.isLoading()) win.webContents.send(IPC.voiceMiniState, state)
}

export function pushVoiceMiniLevel(level: VoiceMiniLevel): void {
  const win = getVoiceMiniWindow()
  if (win && !win.webContents.isLoading()) win.webContents.send(IPC.voiceMiniLevel, level)
}

/** The mini window's page is listening: give it the last state again (it may have missed the first). */
export function replayVoiceMiniState(): void {
  const win = getVoiceMiniWindow()
  if (win && lastState) win.webContents.send(IPC.voiceMiniState, lastState)
}

/** A click in the mini window, for the session in the main window. */
export function sendToMain(command: VoiceMiniCommand): void {
  const main = getMainWindow()
  if (main && !main.isDestroyed()) main.webContents.send(IPC.voiceMiniCommand, command)
}

export function showMainWindow(): void {
  const main = getMainWindow()
  if (!main || main.isDestroyed()) return
  if (main.isMinimized()) main.restore()
  main.show()
  main.focus()
}

/** Only the mini window's own top frame may speak for it. */
export function senderIsVoiceMini(event: { sender: Electron.WebContents; senderFrame?: Electron.WebFrameMain | null }): boolean {
  const win = getVoiceMiniWindow()
  if (!win || BrowserWindow.fromWebContents(event.sender) !== win) return false
  const frame = event.senderFrame
  return Boolean(frame && frame === event.sender.mainFrame)
}
