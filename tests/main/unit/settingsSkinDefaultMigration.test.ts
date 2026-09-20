import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { DEFAULT_SETTINGS, SETTINGS_FORMAT_VERSION } from '@shared/ipc'
import { DEFAULT_SKIN_ID, LEGACY_SKIN_ID } from '@shared/skins'

const userData = join(tmpdir(), `vyotiq-settings-skin-${process.pid}-${Date.now()}`)
const settingsFile = (): string => join(userData, 'settings.json')

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

const load = async () => {
  const { clearSettingsCacheForTests, getSettings } = await import('@main/settings/settings')
  clearSettingsCacheForTests()
  return getSettings()
}

const readDisk = (): { skinId: string; settingsVersion: number } =>
  JSON.parse(readFileSync(settingsFile(), 'utf8')) as {
    skinId: string
    settingsVersion: number
  }

describe('skin persisted default (v6)', () => {
  beforeEach(() => {
    mkdirSync(userData, { recursive: true })
  })

  afterEach(async () => {
    const { clearSettingsCacheForTests } = await import('@main/settings/settings')
    clearSettingsCacheForTests()
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
  })

  it('seeds Native for a fresh install', async () => {
    const settings = await load()

    expect(settings.skinId).toBe('native')
    expect(settings.skinId).toBe(DEFAULT_SKIN_ID)
    expect(settings.settingsVersion).toBe(SETTINGS_FORMAT_VERSION)
  })

  it('rewrites the persisted v5 old default and stamps settingsVersion', async () => {
    writeFileSync(
      settingsFile(),
      JSON.stringify({ ...DEFAULT_SETTINGS, skinId: LEGACY_SKIN_ID, settingsVersion: 5 }),
      'utf8'
    )

    const settings = await load()

    expect(settings.skinId).toBe('native')
    expect(readDisk()).toMatchObject({
      skinId: 'native',
      settingsVersion: SETTINGS_FORMAT_VERSION
    })
  })

  it('keeps a deliberate non-default skin through the version-stamp upgrade', async () => {
    writeFileSync(
      settingsFile(),
      JSON.stringify({ ...DEFAULT_SETTINGS, skinId: 'gild', settingsVersion: 5 }),
      'utf8'
    )

    const settings = await load()

    expect(settings.skinId).toBe('gild')
    expect(readDisk().skinId).toBe('gild')
  })

  it('respects Default picked after the v6 stamp', async () => {
    writeFileSync(
      settingsFile(),
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        skinId: LEGACY_SKIN_ID,
        settingsVersion: SETTINGS_FORMAT_VERSION
      }),
      'utf8'
    )

    const settings = await load()

    expect(settings.skinId).toBe('default')
    expect(readDisk().skinId).toBe('default')
  })
})
