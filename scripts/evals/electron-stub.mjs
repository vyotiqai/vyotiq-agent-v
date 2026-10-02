/**
 * Minimal 'electron' stand-in for running src/main modules in plain Node
 * (scripts/eval-coding.mjs --runtime node). Only what the agent loop touches
 * outside a window exists. safeStorage reports no encryption, so stored API
 * keys are unreadable here: use this runtime for providers that need no key,
 * and the Electron runtime for everything else.
 *
 * Paths come from globalThis.__VYOTIQ_EVAL_ELECTRON__ = { userData, appPath },
 * set by the runner before the first import of a src/main module.
 */
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const config = globalThis.__VYOTIQ_EVAL_ELECTRON__ ?? {}
const userData = config.userData ?? join(tmpdir(), 'vyotiq-eval-electron-stub')

const appEvents = new EventEmitter()

export const app = Object.assign(appEvents, {
  isPackaged: false,
  getPath: (name) => (name === 'userData' ? userData : join(userData, `_${name}`)),
  getAppPath: () => config.appPath ?? process.cwd(),
  getVersion: () => config.version ?? '0.0.0-eval',
  getName: () => 'vyotiq-eval',
  getLocale: () => 'en-US',
  whenReady: () => Promise.resolve(),
  isReady: () => true,
  quit: () => {},
  exit: (code) => process.exit(code)
})

export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error('safeStorage is unavailable in the plain-Node eval runtime')
  },
  decryptString: () => {
    throw new Error('safeStorage is unavailable in the plain-Node eval runtime')
  },
  getSelectedStorageBackend: () => 'unknown'
}

export const BrowserWindow = { getAllWindows: () => [], getFocusedWindow: () => null, fromWebContents: () => null }
export const webContents = { getAllWebContents: () => [], fromId: () => null }
export const ipcMain = { handle() {}, on() {}, removeHandler() {} }
export const powerMonitor = new EventEmitter()
export const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: false })
export const shell = { openExternal: async () => {}, openPath: async () => '', showItemInFolder() {} }
export const clipboard = { readText: () => '', writeText() {} }
export const dialog = {}
export const session = { defaultSession: null, fromPartition: () => null }
export const net = {}
export const screen = {}
export const nativeImage = { createEmpty: () => ({}), createFromPath: () => ({}) }
export const Menu = { setApplicationMenu() {}, buildFromTemplate: () => ({}) }
export const protocol = {}
export const crashReporter = {}
export const utilityProcess = {}
export const desktopCapturer = {}
export const systemPreferences = {}
export const powerSaveBlocker = { start: () => 0, stop() {} }
export const autoUpdater = new EventEmitter()
export const contentTracing = {}
export const globalShortcut = { register: () => false, unregisterAll() {} }
export const inAppPurchase = {}
export const pushNotifications = {}
export const webFrameMain = {}
export const netLog = {}
export class Notification extends EventEmitter {
  static isSupported() {
    return false
  }
  show() {}
  close() {}
}
export class MessageChannelMain {}
export class WebContentsView {}
export class BaseWindow {}
export class Tray {}
export class TouchBar {}
export class ShareMenu {}

export default { app, safeStorage, BrowserWindow, webContents, ipcMain, shell, Notification }
