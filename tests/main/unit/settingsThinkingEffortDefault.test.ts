import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { DEFAULT_SETTINGS, DEFAULT_THINKING_EFFORT, SETTINGS_FORMAT_VERSION } from '@shared/ipc'

const userData = join(tmpdir(), `vyotiq-settings-effort-${process.pid}-${Date.now()}`)

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

describe('thinking effort persisted default', () => {
  beforeEach(() => {
    mkdirSync(userData, { recursive: true })
  })

  afterEach(async () => {
    const { clearSettingsCacheForTests } = await import('@main/settings/settings')
    clearSettingsCacheForTests()
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
  })

  it('uses low when settings.json is missing', async () => {
    const { clearSettingsCacheForTests, getSettings } = await import('@main/settings/settings')
    clearSettingsCacheForTests()
    expect(getSettings().thinkingEffort).toBe(DEFAULT_THINKING_EFFORT)
    expect(getSettings().settingsVersion).toBe(SETTINGS_FORMAT_VERSION)
  })

  it('rewrites the v1 seed medium to low and stamps settingsVersion', async () => {
    const { clearSettingsCacheForTests, getSettings } = await import('@main/settings/settings')
    clearSettingsCacheForTests()
    writeFileSync(
      join(userData, 'settings.json'),
      JSON.stringify({ ...DEFAULT_SETTINGS, thinkingEffort: 'medium', settingsVersion: 1 }),
      'utf8'
    )

    const loaded = getSettings()
    expect(loaded.thinkingEffort).toBe(DEFAULT_THINKING_EFFORT)
    const onDisk = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')) as {
      thinkingEffort: string
      settingsVersion: number
    }
    expect(onDisk.thinkingEffort).toBe('low')
    expect(onDisk.settingsVersion).toBe(SETTINGS_FORMAT_VERSION)
  })

  it('keeps a deliberate non-default effort through the version-stamp upgrade', async () => {
    const { clearSettingsCacheForTests, getSettings } = await import('@main/settings/settings')
    clearSettingsCacheForTests()
    writeFileSync(
      join(userData, 'settings.json'),
      JSON.stringify({ ...DEFAULT_SETTINGS, thinkingEffort: 'high', settingsVersion: 1 }),
      'utf8'
    )

    const loaded = getSettings()
    expect(loaded.thinkingEffort).toBe('high')
    const onDisk = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')) as {
      thinkingEffort: string
      settingsVersion: number
    }
    expect(onDisk.thinkingEffort).toBe('high')
    expect(onDisk.settingsVersion).toBe(SETTINGS_FORMAT_VERSION)
  })

  it('does not rewrite a post-stamp medium choice', async () => {
    const { clearSettingsCacheForTests, getSettings } = await import('@main/settings/settings')
    clearSettingsCacheForTests()
    writeFileSync(
      join(userData, 'settings.json'),
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        thinkingEffort: 'medium',
        settingsVersion: SETTINGS_FORMAT_VERSION
      }),
      'utf8'
    )

    expect(getSettings().thinkingEffort).toBe('medium')
    const onDisk = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')) as {
      thinkingEffort: string
    }
    expect(onDisk.thinkingEffort).toBe('medium')
  })

  it('leaves per-provider thinking prefs untouched while migrating the top-level default', async () => {
    const { clearSettingsCacheForTests, getSettings } = await import('@main/settings/settings')
    clearSettingsCacheForTests()
    writeFileSync(
      join(userData, 'settings.json'),
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        thinkingEffort: 'medium',
        thinkingPrefsByProvider: { openai: { thinkingEnabled: true, thinkingEffort: 'high' } },
        settingsVersion: 1
      }),
      'utf8'
    )

    const loaded = getSettings()
    expect(loaded.thinkingEffort).toBe(DEFAULT_THINKING_EFFORT)
    expect(loaded.thinkingPrefsByProvider.openai?.thinkingEffort).toBe('high')
  })
})
