/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  APPEARANCE_LOCAL_STORAGE_KEY,
  DEFAULT_FONT_SCALE,
  DEFAULT_SKIN_ID,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  FontScaleSchema,
  readAppearanceBootCache,
  resolveAppearanceBootCache,
  resolveFontScaleValue,
  stepFontScale,
  writeAppearanceBootCache,
  type AppearanceBootCache
} from '@shared/appearance'
import { resolveTheme } from '@shared/theme'

const baseAppearance = {
  theme: 'system' as const,
  fontScale: 'default' as const,
  skinId: DEFAULT_SKIN_ID,
  customCssPath: '',
  reduceMotion: 'system' as const,
  contrast: 'system' as const,
  alwaysShowFocusRing: false,
  announceVerbosity: 'full' as const
}

describe('appearance', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.removeAttribute('data-font-scale')
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
      skinId: 'proof',
      reduceMotion: 'on',
      contrast: 'more',
      alwaysShowFocusRing: true,
      announceVerbosity: 'brief'
    }
    writeAppearanceBootCache(cache)
    expect(localStorage.getItem(APPEARANCE_LOCAL_STORAGE_KEY)).toBeTruthy()
    expect(readAppearanceBootCache()).toEqual(cache)
  })

  it('round-trips a numeric font scale through localStorage', () => {
    const cache: AppearanceBootCache = {
      theme: 'system',
      resolvedTheme: resolveTheme('system', false),
      fontScale: 1.52,
      skinId: 'native',
      reduceMotion: 'system',
      contrast: 'system',
      alwaysShowFocusRing: false,
      announceVerbosity: 'full'
    }
    writeAppearanceBootCache(cache)
    expect(readAppearanceBootCache()).toEqual(cache)
  })

  it('boot cache fields map to expected html data attributes', () => {
    const cache = {
      theme: 'system' as const,
      resolvedTheme: 'light' as const,
      fontScale: 'small' as const,
      skinId: 'native' as const
    }
    const root = document.documentElement
    root.setAttribute('data-theme', cache.resolvedTheme)
    root.setAttribute('data-font-scale', cache.fontScale)
    root.setAttribute('data-skin', cache.skinId)
    expect(root.getAttribute('data-theme')).toBe('light')
    expect(root.getAttribute('data-font-scale')).toBe('small')
    expect(root.getAttribute('data-skin')).toBe('native')
  })

  it('readAppearanceBootCache accepts and drops a legacy uiDensity', () => {
    const legacy = {
      theme: 'dark',
      resolvedTheme: 'dark',
      fontScale: 'default',
      uiDensity: 'compact',
      skinId: 'proof'
    }
    localStorage.setItem(APPEARANCE_LOCAL_STORAGE_KEY, JSON.stringify(legacy))
    const { uiDensity: _dropped, ...expected } = legacy
    expect(readAppearanceBootCache()).toEqual({
      ...expected,
      reduceMotion: 'system',
      contrast: 'system',
      alwaysShowFocusRing: false,
      announceVerbosity: 'full'
    })
  })

  it('readAppearanceBootCache defaults accessibility keys missing from older caches', () => {
    localStorage.setItem(
      APPEARANCE_LOCAL_STORAGE_KEY,
      JSON.stringify({
        theme: 'dark',
        resolvedTheme: 'dark',
        fontScale: 'default',
        skinId: 'proof'
      })
    )
    expect(readAppearanceBootCache()).toEqual({
      theme: 'dark',
      resolvedTheme: 'dark',
      fontScale: 'default',
      skinId: 'proof',
      reduceMotion: 'system',
      contrast: 'system',
      alwaysShowFocusRing: false,
      announceVerbosity: 'full'
    })
  })

  it('readAppearanceBootCache rejects out-of-range numeric font scales', () => {
    localStorage.setItem(
      APPEARANCE_LOCAL_STORAGE_KEY,
      JSON.stringify({
        theme: 'dark',
        resolvedTheme: 'dark',
        fontScale: 2.5,
        skinId: 'proof'
      })
    )
    expect(readAppearanceBootCache()).toBeNull()
  })

  it('readAppearanceBootCache rejects invalid accessibility values', () => {
    localStorage.setItem(
      APPEARANCE_LOCAL_STORAGE_KEY,
      JSON.stringify({
        theme: 'dark',
        resolvedTheme: 'dark',
        fontScale: 'default',
        skinId: 'proof',
        reduceMotion: 'sometimes'
      })
    )
    expect(readAppearanceBootCache()).toBeNull()
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

  it('accepts preset and numeric font scales, rejects the rest', () => {
    expect(FontScaleSchema.safeParse('small').success).toBe(true)
    expect(FontScaleSchema.safeParse('default').success).toBe(true)
    expect(FontScaleSchema.safeParse('large').success).toBe(true)
    expect(FontScaleSchema.safeParse(1).data).toBe(1)
    expect(FontScaleSchema.safeParse(FONT_SCALE_MIN).success).toBe(true)
    expect(FontScaleSchema.safeParse(FONT_SCALE_MAX).success).toBe(true)
    expect(FontScaleSchema.safeParse('huge').success).toBe(false)
    expect(FontScaleSchema.safeParse(0.5).success).toBe(false)
    expect(FontScaleSchema.safeParse(2.5).success).toBe(false)
    expect(FontScaleSchema.safeParse(Number.NaN).success).toBe(false)
  })

  it('resolves every scale to its numeric multiplier', () => {
    expect(resolveFontScaleValue('small')).toBeCloseTo(0.92, 5)
    expect(resolveFontScaleValue('default')).toBe(1)
    expect(resolveFontScaleValue('large')).toBeCloseTo(1.08, 5)
    expect(resolveFontScaleValue(2)).toBe(2)
    expect(resolveFontScaleValue(0.85)).toBe(0.85)
  })

  it('steps numeric scales by the step and clamps at the ends', () => {
    expect(stepFontScale(1, 1)).toBeCloseTo(1.08, 5)
    expect(stepFontScale(1, -1)).toBeCloseTo(0.92, 5)
    expect(stepFontScale(FONT_SCALE_MAX, 1)).toBe(FONT_SCALE_MAX)
    expect(stepFontScale(FONT_SCALE_MIN, -1)).toBe(FONT_SCALE_MIN)
    expect(stepFontScale(2, 1)).toBe(2)
  })

  it('carries accessibility settings through pick and boot cache', () => {
    const appearance = {
      ...baseAppearance,
      reduceMotion: 'on' as const,
      contrast: 'more' as const,
      alwaysShowFocusRing: true,
      announceVerbosity: 'brief' as const
    }
    expect(resolveAppearanceBootCache(appearance, false)).toMatchObject({
      reduceMotion: 'on',
      contrast: 'more',
      alwaysShowFocusRing: true,
      announceVerbosity: 'brief'
    })
  })
})
