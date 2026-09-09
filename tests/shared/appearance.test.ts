/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  APPEARANCE_LOCAL_STORAGE_KEY,
  DEFAULT_FONT_SCALE,
  DEFAULT_SKIN_ID,
  readAppearanceBootCache,
  resolveAppearanceBootCache,
  stepFontScale,
  writeAppearanceBootCache,
  type AppearanceBootCache
} from '@shared/appearance'
import { resolveTheme } from '@shared/theme'

const baseAppearance = {
  theme: 'system' as const,
  fontScale: 'default' as const,
  uiDensity: 'default' as const,
  skinId: DEFAULT_SKIN_ID,
  customCssPath: ''
}

describe('appearance', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.removeAttribute('data-font-scale')
    document.documentElement.removeAttribute('data-density')
    document.documentElement.removeAttribute('data-skin')
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('resolveAppearanceBootCache resolves system theme from OS preference flag', () => {
    expect(resolveAppearanceBootCache(baseAppearance, true).resolvedTheme).toBe('dark')
    expect(
      resolveAppearanceBootCache(
        { ...baseAppearance, theme: 'light' },
        true
      ).resolvedTheme
    ).toBe('light')
  })

  it('round-trips boot cache through localStorage', () => {
    const cache: AppearanceBootCache = {
      theme: 'dark',
      resolvedTheme: resolveTheme('dark', false),
      fontScale: 'large',
      uiDensity: 'compact',
      skinId: 'proof'
    }
    writeAppearanceBootCache(cache)
    expect(localStorage.getItem(APPEARANCE_LOCAL_STORAGE_KEY)).toBeTruthy()
    expect(readAppearanceBootCache()).toEqual(cache)
  })

  it('boot cache fields map to expected html data attributes', () => {
    const cache = {
      theme: 'system' as const,
      resolvedTheme: 'light' as const,
      fontScale: 'small' as const,
      uiDensity: 'comfortable' as const,
      skinId: 'native' as const
    }
    const root = document.documentElement
    root.setAttribute('data-theme', cache.resolvedTheme)
    root.setAttribute('data-font-scale', cache.fontScale)
    root.setAttribute('data-density', cache.uiDensity)
    root.setAttribute('data-skin', cache.skinId)
    expect(root.getAttribute('data-theme')).toBe('light')
    expect(root.getAttribute('data-font-scale')).toBe('small')
    expect(root.getAttribute('data-density')).toBe('comfortable')
    expect(root.getAttribute('data-skin')).toBe('native')
  })

  it('readAppearanceBootCache rejects corrupt cache', () => {
    localStorage.setItem(APPEARANCE_LOCAL_STORAGE_KEY, '{"theme":"nope"}')
    expect(readAppearanceBootCache()).toBeNull()
  })

  it('readAppearanceBootCache rejects invalid skinId', () => {
    localStorage.setItem(
      APPEARANCE_LOCAL_STORAGE_KEY,
      JSON.stringify({
        theme: 'dark',
        resolvedTheme: 'dark',
        fontScale: 'default',
        uiDensity: 'default',
        skinId: 'neon'
      })
    )
    expect(readAppearanceBootCache()).toBeNull()
  })

  it('steps text size without wrapping past the ends', () => {
    expect(stepFontScale('default', 1)).toBe('large')
    expect(stepFontScale('large', 1)).toBe('large')
    expect(stepFontScale('default', -1)).toBe('small')
    expect(stepFontScale('small', -1)).toBe('small')
    expect(stepFontScale(DEFAULT_FONT_SCALE, 1)).toBe('large')
  })
})
