import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { DEFAULT_SETTINGS, SETTINGS_FORMAT_VERSION } from '@shared/ipc'
import {
  DEFAULT_AUTO_COMPACT_THRESHOLD_RATIO,
  LEGACY_AUTO_COMPACT_THRESHOLD_RATIO
} from '@shared/domain/contextBudget'

const userData = join(tmpdir(), `vyotiq-settings-compact-${process.pid}-${Date.now()}`)

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

describe('auto-compact threshold persisted default', () => {
  beforeEach(() => {
    mkdirSync(userData, { recursive: true })
  })

  afterEach(async () => {
    const { clearSettingsCacheForTests } = await import('@main/settings/settings')
    clearSettingsCacheForTests()
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
  })

  it('uses 55% when settings.json is missing', async () => {
    const { clearSettingsCacheForTests, getSettings } = await import('@main/settings/settings')
    clearSettingsCacheForTests()
    expect(getSettings().autoCompactThresholdRatio).toBe(DEFAULT_AUTO_COMPACT_THRESHOLD_RATIO)
    expect(getSettings().settingsVersion).toBe(SETTINGS_FORMAT_VERSION)
  })

  it('fills 55% when the key is omitted from an older settings.json', async () => {
    const { clearSettingsCacheForTests, getSettings } = await import('@main/settings/settings')
    clearSettingsCacheForTests()
    const { autoCompactThresholdRatio: _ratio, settingsVersion: _version, ...legacy } =
      DEFAULT_SETTINGS
    writeFileSync(join(userData, 'settings.json'), JSON.stringify({ ...legacy, theme: 'dark' }), 'utf8')

    const loaded = getSettings()
    expect(loaded.autoCompactThresholdRatio).toBe(DEFAULT_AUTO_COMPACT_THRESHOLD_RATIO)
    expect(loaded.settingsVersion).toBe(SETTINGS_FORMAT_VERSION)
    expect(loaded.theme).toBe('dark')
  })

  it('rewrites a pre-stamp settings.json that still has the old 0.2 default', async () => {
    const { clearSettingsCacheForTests, getSettings } = await import('@main/settings/settings')
    clearSettingsCacheForTests()
    const { settingsVersion: _version, ...legacy } = DEFAULT_SETTINGS
    writeFileSync(
      join(userData, 'settings.json'),
      JSON.stringify({ ...legacy, autoCompactThresholdRatio: LEGACY_AUTO_COMPACT_THRESHOLD_RATIO }),
      'utf8'
    )

    const loaded = getSettings()
    expect(loaded.autoCompactThresholdRatio).toBe(DEFAULT_AUTO_COMPACT_THRESHOLD_RATIO)
    const onDisk = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')) as {
      autoCompactThresholdRatio: number
      settingsVersion: number
    }
    expect(onDisk.autoCompactThresholdRatio).toBe(0.55)
    expect(onDisk.settingsVersion).toBe(SETTINGS_FORMAT_VERSION)
  })

  it('rewrites the old product default 0.2 to 0.55 and stamps settingsVersion', async () => {
    const { clearSettingsCacheForTests, getSettings } = await import('@main/settings/settings')
    clearSettingsCacheForTests()
    writeFileSync(
      join(userData, 'settings.json'),
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        autoCompactThresholdRatio: LEGACY_AUTO_COMPACT_THRESHOLD_RATIO,
        settingsVersion: 0
      }),
      'utf8'
    )

    const loaded = getSettings()
    expect(loaded.autoCompactThresholdRatio).toBe(DEFAULT_AUTO_COMPACT_THRESHOLD_RATIO)

    const onDisk = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')) as {
      autoCompactThresholdRatio: number
      settingsVersion: number
    }
    expect(onDisk.autoCompactThresholdRatio).toBe(0.55)
    expect(onDisk.settingsVersion).toBe(SETTINGS_FORMAT_VERSION)
  })

  it('does not overwrite a later intentional 20% after the format stamp', async () => {
    const { clearSettingsCacheForTests, getSettings } = await import('@main/settings/settings')
    clearSettingsCacheForTests()
    writeFileSync(
      join(userData, 'settings.json'),
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        autoCompactThresholdRatio: LEGACY_AUTO_COMPACT_THRESHOLD_RATIO,
        settingsVersion: SETTINGS_FORMAT_VERSION
      }),
      'utf8'
    )

    expect(getSettings().autoCompactThresholdRatio).toBe(LEGACY_AUTO_COMPACT_THRESHOLD_RATIO)
    const onDisk = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')) as {
      autoCompactThresholdRatio: number
    }
    expect(onDisk.autoCompactThresholdRatio).toBe(0.2)
  })

  it('keeps a custom threshold that is not the old default', async () => {
    const { clearSettingsCacheForTests, getSettings } = await import('@main/settings/settings')
    clearSettingsCacheForTests()
    writeFileSync(
      join(userData, 'settings.json'),
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        autoCompactThresholdRatio: 0.35,
        settingsVersion: 0
      }),
      'utf8'
    )

    expect(getSettings().autoCompactThresholdRatio).toBe(0.35)
    const onDisk = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')) as {
      autoCompactThresholdRatio: number
      settingsVersion: number
    }
    expect(onDisk.autoCompactThresholdRatio).toBe(0.35)
    expect(onDisk.settingsVersion).toBe(SETTINGS_FORMAT_VERSION)
  })
})
