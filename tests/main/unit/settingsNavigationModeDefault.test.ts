import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { DEFAULT_SETTINGS, SettingsSchema, parseSettings } from '@shared/ipc'

const userData = join(tmpdir(), `vyotiq-settings-navigation-mode-${process.pid}-${Date.now()}`)

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

describe('navigationMode settings schema', () => {
  it('defaults a settings object without navigationMode to home', () => {
    const { navigationMode: _omitted, ...withoutNavigationMode } = DEFAULT_SETTINGS
    const parsed = parseSettings(withoutNavigationMode)
    expect(parsed.navigationMode).toBe('home')
  })

  it('accepts explicit home and sidebar', () => {
    expect(parseSettings({ ...DEFAULT_SETTINGS, navigationMode: 'home' }).navigationMode).toBe('home')
    expect(parseSettings({ ...DEFAULT_SETTINGS, navigationMode: 'sidebar' }).navigationMode).toBe('sidebar')
  })

  it('rejects values outside home/sidebar', () => {
    expect(
      SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, navigationMode: 'chat' }).success
    ).toBe(false)
    expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, navigationMode: 1 }).success).toBe(false)
  })
})

describe('navigationMode persisted default', () => {
  beforeEach(() => {
    mkdirSync(userData, { recursive: true })
  })

  afterEach(async () => {
    const { clearSettingsCacheForTests } = await import('@main/settings/settings')
    clearSettingsCacheForTests()
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
  })

  it('uses home when settings.json is missing', async () => {
    const { clearSettingsCacheForTests, getSettings } = await import('@main/settings/settings')
    clearSettingsCacheForTests()
    expect(getSettings().navigationMode).toBe('home')
  })

  it('fills home when the key is omitted from an existing settings.json', async () => {
    const { clearSettingsCacheForTests, getSettings } = await import('@main/settings/settings')
    clearSettingsCacheForTests()
    const { navigationMode: _omitted, ...legacy } = DEFAULT_SETTINGS
    writeFileSync(join(userData, 'settings.json'), JSON.stringify({ ...legacy, theme: 'dark' }), 'utf8')

    const loaded = getSettings()
    expect(loaded.navigationMode).toBe('home')
    expect(loaded.theme).toBe('dark')
  })

  it('persists an explicit sidebar choice through setSettings', async () => {
    const { clearSettingsCacheForTests, getSettings, setSettings } = await import(
      '@main/settings/settings'
    )
    clearSettingsCacheForTests()
    const next = setSettings({ navigationMode: 'sidebar' })
    expect(next.navigationMode).toBe('sidebar')
    expect(getSettings().navigationMode).toBe('sidebar')
  })
})
