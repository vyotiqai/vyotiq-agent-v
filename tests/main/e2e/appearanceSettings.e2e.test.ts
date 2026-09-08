/**
 * Appearance settings persistence e2e — real settings.json I/O via main settings module.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { DEFAULT_SETTINGS } from '@shared/ipc'

const userData = join(tmpdir(), `vyotiq-appearance-e2e-${process.pid}-${Date.now()}`)

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

describe('e2e: appearance settings persistence', () => {
  beforeEach(() => {
    mkdirSync(userData, { recursive: true })
  })

  afterEach(async () => {
    const { clearSettingsCacheForTests } = await import('@main/settings/settings')
    clearSettingsCacheForTests()
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
  })

  it('persists appearance fields through setSettings/getSettings round-trip', async () => {
    const { clearSettingsCacheForTests, setSettings, getSettings } = await import(
      '@main/settings/settings'
    )
    clearSettingsCacheForTests()

    setSettings({
      theme: 'dark',
      fontScale: 'large',
      uiDensity: 'comfortable',
      accentPreset: 'violet'
    })

    const loaded = getSettings()
    expect(loaded.theme).toBe('dark')
    expect(loaded.fontScale).toBe('large')
    expect(loaded.uiDensity).toBe('comfortable')
    expect(loaded.accentPreset).toBe('violet')

    const onDisk = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')) as {
      theme: string
      fontScale: string
      uiDensity: string
      accentPreset: string
    }
    expect(onDisk).toMatchObject({
      theme: 'dark',
      fontScale: 'large',
      uiDensity: 'comfortable',
      accentPreset: 'violet'
    })
  })

  it('merges partial appearance updates without dropping other settings keys', async () => {
    const { clearSettingsCacheForTests, setSettings, getSettings } = await import(
      '@main/settings/settings'
    )
    clearSettingsCacheForTests()

    setSettings({ theme: 'light', fontScale: 'small' })
    setSettings({ accentPreset: 'green' })

    const loaded = getSettings()
    expect(loaded.theme).toBe('light')
    expect(loaded.fontScale).toBe('small')
    expect(loaded.uiDensity).toBe(DEFAULT_SETTINGS.uiDensity)
    expect(loaded.accentPreset).toBe('green')
    expect(loaded.telemetryEnabled).toBe(DEFAULT_SETTINGS.telemetryEnabled)
  })

  it('migrates legacy settings.json missing appearance fields to schema defaults', async () => {
    const { clearSettingsCacheForTests, getSettings } = await import('@main/settings/settings')
    clearSettingsCacheForTests()

    const { fontScale: _fs, uiDensity: _ud, accentPreset: _ap, ...legacy } = DEFAULT_SETTINGS
    writeFileSync(
      join(userData, 'settings.json'),
      JSON.stringify({ ...legacy, theme: 'dark' }, null, 2),
      'utf8'
    )

    const loaded = getSettings()
    expect(loaded.theme).toBe('dark')
    expect(loaded.fontScale).toBe('default')
    expect(loaded.uiDensity).toBe('default')
    expect(loaded.accentPreset).toBe('blue')
    expect(loaded.skinId).toBe('default')
    expect(loaded.customCssPath).toBe('')
  })
})
