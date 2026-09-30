import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { DEFAULT_SETTINGS, type NotificationPublishInput } from '@shared/ipc'

const userData = join(tmpdir(), `vyotiq-settings-corrupt-${process.pid}-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? userData : join(tmpdir(), name)),
    getAppPath: () => join(tmpdir(), 'vyotiq-app'),
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8')
  }
}))

import { clearSettingsCacheForTests, getSettings, setSettings } from '@main/settings/settings'
import { setNotificationBus } from '@main/notifications/bus'

const settingsFile = join(userData, 'settings.json')

/**
 * A settings.json that can't be used must never be replaced by defaults: that
 * is how MCP servers and providers vanished. Not JSON → moved aside and said
 * so; can't be read → left alone and never written over.
 */
describe('a damaged or unreadable settings.json', () => {
  beforeEach(() => {
    mkdirSync(userData, { recursive: true })
    clearSettingsCacheForTests()
  })

  afterEach(() => {
    setNotificationBus(null)
    clearSettingsCacheForTests()
    rmSync(userData, { recursive: true, force: true })
  })

  it('moves a file that is not JSON aside, keeps its bytes, and says where it went', () => {
    const damaged = '{"provider":"openai","mcpServers":[{"id":"gith'
    writeFileSync(settingsFile, damaged, 'utf8')

    const loaded = getSettings()
    expect(loaded.provider).toBe(DEFAULT_SETTINGS.provider)
    expect(existsSync(settingsFile)).toBe(false)
    const kept = readdirSync(userData).filter((name) => name.startsWith('settings.json.corrupt-'))
    expect(kept).toHaveLength(1)
    expect(readFileSync(join(userData, kept[0]!), 'utf8')).toBe(damaged)

    // Raised before the inbox exists; it arrives once the inbox is wired.
    const published: NotificationPublishInput[] = []
    setNotificationBus({ publish: (input) => published.push(input), dismissByDedupeKey: () => {} })
    expect(published).toEqual([
      expect.objectContaining({
        source: 'system',
        title: "Settings couldn't be read",
        body: expect.stringContaining(kept[0]!)
      })
    ])

    // Saving now starts a fresh file beside the kept one.
    setSettings({ theme: 'dark' })
    expect(JSON.parse(readFileSync(settingsFile, 'utf8')).theme).toBe('dark')
    expect(readFileSync(join(userData, kept[0]!), 'utf8')).toBe(damaged)
  })

  it('refuses to save over a settings.json it cannot read, and reads it again once it can', () => {
    // A directory in its place: exists, but every read fails.
    mkdirSync(settingsFile)
    expect(getSettings().provider).toBe(DEFAULT_SETTINGS.provider)
    expect(() => setSettings({ theme: 'dark' })).toThrow(/Settings were not saved: settings\.json could not be read/)
    expect(statSync(settingsFile).isDirectory()).toBe(true)

    // Readable again: the next read sees the real file — defaults were never cached.
    rmSync(settingsFile, { recursive: true })
    writeFileSync(settingsFile, JSON.stringify({ theme: 'light', provider: 'anthropic' }), 'utf8')
    expect(getSettings().provider).toBe('anthropic')
    setSettings({ theme: 'dark' })
    const saved = JSON.parse(readFileSync(settingsFile, 'utf8')) as { theme: string; provider: string }
    expect(saved).toMatchObject({ theme: 'dark', provider: 'anthropic' })
  })
})
