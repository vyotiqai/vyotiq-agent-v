import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { DEFAULT_SETTINGS, SETTINGS_FORMAT_VERSION } from '@shared/ipc'

const userData = join(tmpdir(), `vyotiq-settings-questions-${process.pid}-${Date.now()}`)
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

type Disk = { autonomousSkipQuestions: string; autonomousMode: boolean; settingsVersion: number }
const readDisk = (): Disk => JSON.parse(readFileSync(settingsFile(), 'utf8')) as Disk

const writeV6 = (fields: Partial<Disk>): void => {
  writeFileSync(settingsFile(), JSON.stringify({ ...DEFAULT_SETTINGS, ...fields, settingsVersion: 6 }), 'utf8')
}

describe('questions setting stands alone (v7)', () => {
  beforeEach(() => {
    mkdirSync(userData, { recursive: true })
  })

  afterEach(async () => {
    const { clearSettingsCacheForTests } = await import('@main/settings/settings')
    clearSettingsCacheForTests()
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
  })

  it('turns a Skip that sat under a switch that was off back to Wait', async () => {
    writeV6({ autonomousMode: false, autonomousSkipQuestions: 'skip' })

    const settings = await load()

    expect(settings.autonomousSkipQuestions).toBe('wait')
    expect(readDisk()).toMatchObject({ autonomousSkipQuestions: 'wait', settingsVersion: SETTINGS_FORMAT_VERSION })
  })

  it('keeps Skip when the switch was on, since it applied then', async () => {
    writeV6({ autonomousMode: true, autonomousSkipQuestions: 'skip' })

    const settings = await load()

    expect(settings.autonomousSkipQuestions).toBe('skip')
    expect(settings.autonomousMode).toBe(true)
  })

  it('respects Skip chosen after the v7 stamp with the switch off', async () => {
    writeFileSync(
      settingsFile(),
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        autonomousMode: false,
        autonomousSkipQuestions: 'skip',
        settingsVersion: SETTINGS_FORMAT_VERSION
      }),
      'utf8'
    )

    const settings = await load()

    expect(settings.autonomousSkipQuestions).toBe('skip')
  })
})
