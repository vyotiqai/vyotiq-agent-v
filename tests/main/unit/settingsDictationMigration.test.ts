import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { DEFAULT_SETTINGS, SETTINGS_FORMAT_VERSION } from '@shared/ipc'

const userData = join(tmpdir(), `vyotiq-settings-dictation-${process.pid}-${Date.now()}`)

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

type PersistedSettings = {
  dictation?: {
    engine?: string
    localModelId?: string
    waveformStyle?: string
    [key: string]: unknown
  }
  settingsVersion?: number
  thinkingEffort?: string
  autoCompactThresholdRatio?: number
  sentinelKeepMe?: string
}

function readPersisted(): PersistedSettings {
  return JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')) as PersistedSettings
}

describe('removed dictation engine migration', () => {
  beforeEach(() => {
    mkdirSync(userData, { recursive: true })
  })

  afterEach(async () => {
    const { clearSettingsCacheForTests } = await import('@main/settings/settings')
    clearSettingsCacheForTests()
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
  })

  it('maps the removed qwen3 ONNX engine to local and clears its model id', async () => {
    const { clearSettingsCacheForTests, getSettings } = await import('@main/settings/settings')
    clearSettingsCacheForTests()
    writeFileSync(
      join(userData, 'settings.json'),
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        dictation: {
          engine: 'qwen3-asr-onnx',
          localModelId: 'qwen3-asr-onnx-0.6b',
          waveformStyle: 'bars'
        },
        settingsVersion: 3
      }),
      'utf8'
    )

    const loaded = getSettings()
    expect(loaded.dictation.engine).toBe('local')
    expect(loaded.dictation.localModelId).toBe('')
    const onDisk = readPersisted()
    expect(onDisk.dictation?.engine).toBe('local')
    expect(onDisk.dictation?.localModelId).toBe('')
    expect(onDisk.settingsVersion).toBe(SETTINGS_FORMAT_VERSION)
  })

  it('maps the removed qwen3 server engine to local and strips its endpoint secrets', async () => {
    const { clearSettingsCacheForTests, getSettings } = await import('@main/settings/settings')
    clearSettingsCacheForTests()
    writeFileSync(
      join(userData, 'settings.json'),
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        dictation: {
          engine: 'qwen3-asr',
          localModelId: '',
          waveformStyle: 'bars',
          qwen3AsrServerUrl: 'http://127.0.0.1:8000/v1',
          qwen3AsrApiKey: 'server-token'
        },
        settingsVersion: 3
      }),
      'utf8'
    )

    const loaded = getSettings()
    expect(loaded.dictation.engine).toBe('local')
    const onDisk = readPersisted()
    expect(onDisk.dictation?.engine).toBe('local')
    expect(onDisk.dictation && 'qwen3AsrServerUrl' in onDisk.dictation).toBe(false)
    expect(onDisk.dictation && 'qwen3AsrApiKey' in onDisk.dictation).toBe(false)
  })

  it('does not re-run the older v1-era default rewrites on a v3 file', async () => {
    const { clearSettingsCacheForTests, getSettings } = await import('@main/settings/settings')
    clearSettingsCacheForTests()
    writeFileSync(
      join(userData, 'settings.json'),
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        autoCompactThresholdRatio: 0.2,
        thinkingEffort: 'medium',
        dictation: {
          engine: 'qwen3-asr-onnx',
          localModelId: 'qwen3-asr-0.6b',
          waveformStyle: 'bars'
        },
        settingsVersion: 3
      }),
      'utf8'
    )

    const loaded = getSettings()
    // Deliberate v3 choices survive the v4 format bump…
    expect(loaded.thinkingEffort).toBe('medium')
    expect(loaded.autoCompactThresholdRatio).toBe(0.2)
    // …while the removed dictation engine still migrates.
    expect(loaded.dictation.engine).toBe('local')
    const onDisk = readPersisted()
    expect(onDisk.thinkingEffort).toBe('medium')
    expect(onDisk.autoCompactThresholdRatio).toBe(0.2)
    expect(onDisk.settingsVersion).toBe(SETTINGS_FORMAT_VERSION)
  })

  it('keeps a deliberate supported dictation preference through the version stamp', async () => {
    const { clearSettingsCacheForTests, getSettings } = await import('@main/settings/settings')
    clearSettingsCacheForTests()
    writeFileSync(
      join(userData, 'settings.json'),
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        dictation: { engine: 'openrouter', localModelId: 'whisper-small.en', waveformStyle: 'dots' },
        settingsVersion: 3
      }),
      'utf8'
    )

    const loaded = getSettings()
    expect(loaded.dictation).toEqual({
      engine: 'openrouter',
      localModelId: 'whisper-small.en',
      waveformStyle: 'dots'
    })
    expect(readPersisted().settingsVersion).toBe(SETTINGS_FORMAT_VERSION)
  })

  it('does not rewrite dictation once the file is at the current format version', async () => {
    const { clearSettingsCacheForTests, getSettings } = await import('@main/settings/settings')
    clearSettingsCacheForTests()
    writeFileSync(
      join(userData, 'settings.json'),
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        dictation: { engine: 'local', localModelId: 'whisper-tiny.en', waveformStyle: 'line' },
        sentinelKeepMe: 'untouched',
        settingsVersion: SETTINGS_FORMAT_VERSION
      }),
      'utf8'
    )

    expect(getSettings().dictation.engine).toBe('local')
    const onDisk = readPersisted()
    // A persist would have dropped the unknown key — its survival proves no rewrite.
    expect(onDisk.sentinelKeepMe).toBe('untouched')
    expect(onDisk.dictation?.localModelId).toBe('whisper-tiny.en')
  })
})
