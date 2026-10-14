import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { DEFAULT_VOICE_RESPONDER } from '@shared/ipc/schemas/voice'

const userData = join(tmpdir(), `vyotiq-voice-language-${process.pid}`)
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

describe('voice language and voice model (v8, D-45, D-47)', () => {
  beforeEach(() => mkdirSync(userData, { recursive: true }))

  afterEach(async () => {
    const { clearSettingsCacheForTests } = await import('@main/settings/settings')
    clearSettingsCacheForTests()
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
  })

  it('a fresh install listens in English and answers with the default voice model', async () => {
    const settings = await load()
    expect(settings.voice.language).toBe('en')
    expect(settings.voice.responder).toEqual(DEFAULT_VOICE_RESPONDER)
  })

  it('a blank language saved before v8 (the old default, “detect”) becomes English, once', async () => {
    writeFileSync(settingsFile(), JSON.stringify({ settingsVersion: 7, voice: { language: '', sttProvider: 'openrouter' } }))
    const settings = await load()
    expect(settings.voice).toMatchObject({ language: 'en', sttProvider: 'openrouter' })
    expect(JSON.parse(readFileSync(settingsFile(), 'utf8'))).toMatchObject({ settingsVersion: 8, voice: { language: 'en' } })
  })

  it('a language you picked before v8 stays', async () => {
    writeFileSync(settingsFile(), JSON.stringify({ settingsVersion: 7, voice: { language: 'de' } }))
    expect((await load()).voice.language).toBe('de')
  })

  it('“detect” picked after v8 is your choice and survives', async () => {
    writeFileSync(settingsFile(), JSON.stringify({ settingsVersion: 8, voice: { language: '' } }))
    expect((await load()).voice.language).toBe('')
  })
})
