import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'

/** A window that is only events: enough for what the mini window hooks onto. */
class FakeWindow extends EventEmitter {
  destroyed = false
  webContents = Object.assign(new EventEmitter(), {
    setWindowOpenHandler: () => {},
    isLoading: () => true,
    send: () => {},
    mainFrame: {}
  })
  isDestroyed = (): boolean => this.destroyed
  setAlwaysOnTop = (): void => {}
  showInactive = (): void => {}
  loadURL = async (): Promise<void> => {}
  loadFile = async (): Promise<void> => {}
  close = (): void => {
    this.destroyed = true
    this.emit('closed')
  }
  getBounds = () => ({ x: 0, y: 0, width: 800, height: 600 })
}

const main = new FakeWindow()

vi.mock('electron', () => ({
  app: { isPackaged: true },
  BrowserWindow: class {
    constructor() {
      return new FakeWindow()
    }
  },
  nativeTheme: { shouldUseDarkColors: false },
  screen: {
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
  }
}))
vi.mock('@main/app/window', () => ({ getMainWindow: () => main }))
vi.mock('@main/settings/settings', () => ({ getSettings: () => ({ theme: 'light', skinId: 'default' }) }))
vi.mock('@main/logging/init', () => ({ attachWebContentsCrashLogging: () => {} }))

describe('voice mini window (2026-10-16 audit, L5)', () => {
  it('opening and closing it again and again leaves no hooks on the main window', async () => {
    const { openVoiceMiniWindow, closeVoiceMiniWindow } = await import('@main/app/voiceMiniWindow')
    const before = main.listenerCount('closed')
    for (let i = 0; i < 5; i++) {
      openVoiceMiniWindow()
      closeVoiceMiniWindow()
    }
    expect(main.listenerCount('closed')).toBe(before)
    // Open, it still goes when the main window does.
    const win = openVoiceMiniWindow() as unknown as FakeWindow
    expect(main.listenerCount('closed')).toBe(before + 1)
    main.emit('closed')
    expect(win.destroyed).toBe(true)
  })
})
