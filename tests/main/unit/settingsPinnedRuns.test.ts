import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, SettingsSchema, parseSettings } from '@shared/ipc'

describe('pinnedRuns settings schema', () => {
  it('defaults a settings object without pinnedRuns to an empty array', () => {
    const { pinnedRuns: _omitted, ...withoutPinnedRuns } = DEFAULT_SETTINGS
    expect(parseSettings(withoutPinnedRuns).pinnedRuns).toEqual([])
  })

  it('accepts explicit lists up to the cap and rejects more', () => {
    const keys = Array.from({ length: 24 }, (_, i) => `k${i}`)
    expect(parseSettings({ ...DEFAULT_SETTINGS, pinnedRuns: keys }).pinnedRuns).toHaveLength(24)
    expect(
      SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, pinnedRuns: [...keys, 'k24'] }).success
    ).toBe(false)
  })

  it('keeps DEFAULT_SETTINGS consistent with the schema default', () => {
    expect(DEFAULT_SETTINGS.pinnedRuns).toEqual([])
  })
})
