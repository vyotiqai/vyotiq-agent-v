import { describe, expect, it } from 'vitest'
import { sanitizeCustomCss } from '@main/appearance/customCss'
import {
  DEFAULT_SKIN_ID,
  resolveSkinWindowBackground,
  SkinIdSchema
} from '@shared/skins'
import { DEFAULT_SETTINGS, parseSettings } from '@shared/ipc/schemas/settings'

describe('skins', () => {
  it('SkinIdSchema accepts built-in catalog ids', () => {
    for (const id of ['default', 'proof', 'bench', 'native', 'gild']) {
      expect(SkinIdSchema.parse(id)).toBe(id)
    }
  })

  it('SettingsSchema defaults skinId and customCssPath for legacy partials', () => {
    const { skinId: _skin, customCssPath: _css, ...legacy } = DEFAULT_SETTINGS
    const parsed = parseSettings(legacy)
    expect(parsed.skinId).toBe(DEFAULT_SKIN_ID)
    expect(parsed.customCssPath).toBe('')
  })

  it('SettingsSchema maps unknown skinId to default', () => {
    const parsed = parseSettings({ ...DEFAULT_SETTINGS, skinId: 'retired-skin' as never })
    expect(parsed.skinId).toBe(DEFAULT_SKIN_ID)
  })

  it('uses opaque window backgrounds', () => {
    // Each skin owns its opaque window canvas, matching its CSS `--vy-bg`.
    expect(resolveSkinWindowBackground('default', 'light', 'win32')).toBe('#FFFFFF')
    expect(resolveSkinWindowBackground('default', 'dark', 'win32')).toBe('#141414')
    expect(resolveSkinWindowBackground('proof', 'light', 'darwin')).toBe('#F7F7F7')
    expect(resolveSkinWindowBackground('proof', 'dark', 'darwin')).toBe('#272A3B')
    expect(resolveSkinWindowBackground('bench', 'light', 'linux')).toBe('#FFFFFF')
    expect(resolveSkinWindowBackground('bench', 'dark', 'linux')).toBe('#04040A')
    expect(resolveSkinWindowBackground('native', 'light', 'win32')).toBe('#F9F9F9')
    expect(resolveSkinWindowBackground('native', 'dark', 'win32')).toBe('#1A1A1A')
    expect(resolveSkinWindowBackground('gild', 'light', 'win32')).toBe('#E5E4E2')
    expect(resolveSkinWindowBackground('gild', 'dark', 'win32')).toBe('#0A0A0A')
  })
})

describe('customCss', () => {
  it('sanitizeCustomCss strips remote @import rules', () => {
    const input = `@import url("https://evil.com/a.css");
:root { --vy-bg: #111; }`
    expect(sanitizeCustomCss(input)).not.toMatch(/https?:/i)
    expect(sanitizeCustomCss(input)).toContain('--vy-bg')
  })
})
