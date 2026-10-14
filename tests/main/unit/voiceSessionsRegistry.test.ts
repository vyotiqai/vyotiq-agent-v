import { afterEach, describe, expect, it, vi } from 'vitest'

// The registry's real collaborators, minus the parts that need a running Electron.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false }, safeStorage: {}, webContents: {}, BrowserWindow: {} }))
vi.mock('@main/app/badges', () => ({ notifyBadgeChange: vi.fn() }))
vi.mock('@main/settings/settings', async () => {
  const { DEFAULT_SETTINGS } = await import('@shared/ipc')
  return { getSettings: () => DEFAULT_SETTINGS }
})
vi.mock('@main/voice/keys', () => ({
  voiceKeyAvailability: () => ({ voice: { deepgram: true }, chat: {} }),
  readVoiceSourceKey: () => 'k'
}))

type Listener = (details: { isMainFrame: boolean; isSameDocument: boolean }) => void

function fakeWindow(id: number) {
  const nav = new Set<Listener>()
  let onDestroyed: (() => void) | null = null
  return {
    id,
    sent: [] as unknown[],
    isDestroyed: () => false,
    send(_c: string, p: unknown) {
      this.sent.push(p)
    },
    once: (_e: 'destroyed', fn: () => void) => {
      onDestroyed = fn
    },
    on: (_e: 'did-start-navigation', fn: Listener) => void nav.add(fn),
    off: (_e: 'did-start-navigation', fn: Listener) => void nav.delete(fn),
    navigate: (details: { isMainFrame: boolean; isSameDocument: boolean }) => [...nav].forEach((fn) => fn(details)),
    destroy: () => onDestroyed?.(),
    listeners: () => nav.size
  }
}

describe('voice sessions follow their window (D-41)', () => {
  afterEach(async () => {
    const { stopAllVoiceSessions } = await import('@main/voice/sessions')
    await stopAllVoiceSessions()
    delete process.env.VYOTIQ_E2E_FIXTURE
  })

  it('a reload of the window ends its session, so nothing keeps saying "listening"', async () => {
    process.env.VYOTIQ_E2E_FIXTURE = '1'
    const { startVoiceSession, isVoiceListening, voiceSessionFor } = await import('@main/voice/sessions')
    const win = fakeWindow(7)
    const id = await startVoiceSession(win, { events: 'e', audio: 'a' }, [], '/repo')
    expect(isVoiceListening()).toBe(true)
    // An in-page navigation (a hash change) is not a reload.
    win.navigate({ isMainFrame: true, isSameDocument: true })
    expect(voiceSessionFor(7, id)).not.toBeNull()
    win.navigate({ isMainFrame: true, isSameDocument: false })
    await vi.waitFor(() => expect(voiceSessionFor(7, id)).toBeNull())
    expect(isVoiceListening()).toBe(false)
    expect(win.listeners()).toBe(0)
  })

  it('ending a session removes its navigation listener', async () => {
    process.env.VYOTIQ_E2E_FIXTURE = '1'
    const { startVoiceSession, stopVoiceSession } = await import('@main/voice/sessions')
    const win = fakeWindow(8)
    const id = await startVoiceSession(win, { events: 'e', audio: 'a' }, [], null)
    expect(win.listeners()).toBe(1)
    await stopVoiceSession(id)
    expect(win.listeners()).toBe(0)
  })
})
