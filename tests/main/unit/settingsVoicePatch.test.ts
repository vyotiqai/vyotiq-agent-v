import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SetSettingsRequestSchema } from '@shared/ipc'
import type { VoiceSettings } from '@shared/ipc/schemas/voice'
import { pickVoiceByName } from '@main/voice/sessions'

const userData = join(tmpdir(), `vyotiq-settings-voice-patch-${process.pid}-${Date.now()}`)

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

describe('a voice settings change keeps the rest (2026-10-16 audit, L6)', () => {
  beforeEach(() => {
    mkdirSync(userData, { recursive: true })
  })

  afterEach(async () => {
    const { clearSettingsCacheForTests } = await import('@main/settings/settings')
    clearSettingsCacheForTests()
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
  })

  it('two changes from two places both stay', async () => {
    const { clearSettingsCacheForTests, getSettings, setSettings } = await import('@main/settings/settings')
    clearSettingsCacheForTests()
    // The agent sets the speed; the window, from its copy, changes the placement.
    setSettings({ voice: { speed: 1.25 } as VoiceSettings })
    setSettings({ voice: { placement: 'capsule' } as VoiceSettings })
    expect(getSettings().voice).toMatchObject({ speed: 1.25, placement: 'capsule' })
  })

  it('a patch from the window is cut back to what it sent, not the schema’s defaults', async () => {
    const { sentKeysOnly } = await import('@main/settings/settings')
    const raw = { voice: { placement: 'capsule' } }
    const parsed = SetSettingsRequestSchema.parse(raw)
    // The schema alone would write speed 1 over a speed set meanwhile.
    expect(parsed.voice).toMatchObject({ speed: 1 })
    expect(sentKeysOnly(parsed.voice!, raw.voice)).toEqual({ placement: 'capsule' })
    // A whole object is kept whole.
    expect(sentKeysOnly(parsed.voice!, parsed.voice)).toEqual(parsed.voice)
  })
})

describe('a voice named out loud (2026-10-16 audit, L7)', () => {
  const voices = ['Alloy', 'Nova', 'Shimmer']

  it('"voice" alone names none, not the first one listed', () => {
    expect(pickVoiceByName(voices, 'voice')).toBeUndefined()
    expect(pickVoiceByName(voices, '  ')).toBeUndefined()
  })

  it('finds the one named, exactly or in part', () => {
    expect(pickVoiceByName(voices, 'Nova voice')).toBe('Nova')
    expect(pickVoiceByName(voices, 'shim')).toBe('Shimmer')
  })
})
