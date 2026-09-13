import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SETTINGS_FORMAT_VERSION } from '@shared/ipc'

/**
 * Only the persisted keys under test. getSettings() merges raw disk contents
 * over DEFAULT_SETTINGS, so seeding the real minimal shape (not the full
 * DEFAULT_SETTINGS spread) keeps the migration contract honest.
 */
const seed = (autoModeSwitch: boolean, autoResume: boolean, settingsVersion: number) => ({
  autoModeSwitch,
  autoResumeInterruptedRuns: autoResume,
  settingsVersion
})

const userData = join(tmpdir(), `vyotiq-defaults-on-${process.pid}`)
const settingsFile = (): string => join(userData, 'settings.json')

const load = async () => {
  const { clearSettingsCacheForTests, getSettings } = await import('@main/settings/settings')
  clearSettingsCacheForTests()
  return getSettings()
}

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? userData : join(tmpdir(), name)),
    getAppPath: () => tmpdir(),
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8')
  }
}))

describe('Runs settings default-on migration (v5)', () => {
  beforeEach(() => {
    mkdirSync(userData, { recursive: true })
  })

  afterEach(async () => {
    const { clearSettingsCacheForTests } = await import('@main/settings/settings')
    clearSettingsCacheForTests()
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
  })

  it('seeds both Runs toggles on for a fresh install', async () => {
    const settings = await load()

    expect(settings.autoModeSwitch).toBe(true)
    expect(settings.autoResumeInterruptedRuns).toBe(true)
    expect(settings.settingsVersion).toBe(SETTINGS_FORMAT_VERSION)
  })

  it('migrates the persisted v4 old-default falses on load', async () => {
    writeFileSync(settingsFile(), JSON.stringify(seed(false, false, 4)))

    const settings = await load()

    expect(settings.autoModeSwitch).toBe(true)
    expect(settings.autoResumeInterruptedRuns).toBe(true)
    expect(JSON.parse(readFileSync(settingsFile(), 'utf8'))).toMatchObject({
      autoModeSwitch: true,
      autoResumeInterruptedRuns: true,
      settingsVersion: SETTINGS_FORMAT_VERSION
    })
  })

  it('migrates each old-default false independently', async () => {
    writeFileSync(settingsFile(), JSON.stringify(seed(false, true, 4)))

    const settings = await load()

    expect(settings.autoModeSwitch).toBe(true)
    expect(settings.autoResumeInterruptedRuns).toBe(true)
  })

  it('respects deliberate offs after the v5 stamp', async () => {
    writeFileSync(settingsFile(), JSON.stringify(seed(false, false, SETTINGS_FORMAT_VERSION)))

    const settings = await load()

    expect(settings.autoModeSwitch).toBe(false)
    expect(settings.autoResumeInterruptedRuns).toBe(false)
    expect(JSON.parse(readFileSync(settingsFile(), 'utf8'))).toMatchObject({
      autoModeSwitch: false,
      autoResumeInterruptedRuns: false
    })
  })
})
