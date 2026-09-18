import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, SettingsSchema } from '@shared/ipc'

describe('maxChatPanes setting', () => {
  it('defaults to auto (0)', () => {
    expect(DEFAULT_SETTINGS.maxChatPanes).toBe(0)
    const { maxChatPanes: _omitted, ...withoutMaxChatPanes } = DEFAULT_SETTINGS
    expect(SettingsSchema.parse(withoutMaxChatPanes).maxChatPanes).toBe(0)
  })

  it('accepts explicit limits 0–6', () => {
    for (const value of [0, 1, 2, 3, 4, 5, 6]) {
      expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, maxChatPanes: value }).success).toBe(
        true
      )
    }
  })

  it('rejects out-of-range or non-integer values', () => {
    expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, maxChatPanes: 7 }).success).toBe(false)
    expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, maxChatPanes: -1 }).success).toBe(false)
    expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, maxChatPanes: 2.5 }).success).toBe(false)
    expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, maxChatPanes: '3' }).success).toBe(false)
  })
})
