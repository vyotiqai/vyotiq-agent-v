import { z } from 'zod'
import type { ThemeId } from './theme'
import { resolveTheme, type ResolvedTheme } from './theme'
import { DEFAULT_SKIN_ID, SkinIdSchema, type SkinId } from './skins'

export { SkinIdSchema, type SkinId, DEFAULT_SKIN_ID, SKIN_CATALOG, SKIN_IDS } from './skins'

export const FontScalePresetSchema = z.enum(['small', 'default', 'large'])
export type FontScalePreset = z.infer<typeof FontScalePresetSchema>

/** Numeric text-scale bounds: presets keep working, numbers ride the tail. */
export const FONT_SCALE_MIN = 0.85
export const FONT_SCALE_MAX = 2.0
export const FONT_SCALE_STEP = 0.08

/** What each preset resolves to as a multiplier (mirrors styles.css). */
export const FONT_SCALE_PRESET_VALUES: Record<FontScalePreset, number> = {
  small: 0.92,
  default: 1,
  large: 1.08
}

export const FontScaleSchema = z.union([
  FontScalePresetSchema,
  z.number().min(FONT_SCALE_MIN).max(FONT_SCALE_MAX)
])
export type FontScale = z.infer<typeof FontScaleSchema>

export const DEFAULT_FONT_SCALE: FontScale = 'default'

const FONT_SCALE_STEPS: readonly FontScalePreset[] = ['small', 'default', 'large']

/** Resolve any scale to its numeric multiplier. Unknown values fall back to 1. */
export function resolveFontScaleValue(scale: FontScale): number {
  if (typeof scale === 'number') {
    if (!Number.isFinite(scale)) return 1
    return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, scale))
  }
  return FONT_SCALE_PRESET_VALUES[scale] ?? 1
}

/**
 * Step the app text-size setting. Presets step to the next preset and clamp
 * at the ends (no wrap); numeric scales move by FONT_SCALE_STEP, clamped to
 * [FONT_SCALE_MIN, FONT_SCALE_MAX] and rounded to two decimals.
 */
export function stepFontScale(current: FontScale, direction: 1 | -1): FontScale {
  if (typeof current === 'number') {
    const stepped = current + direction * FONT_SCALE_STEP
    const rounded = Math.round(stepped * 100) / 100
    return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, rounded))
  }
  const idx = FONT_SCALE_STEPS.indexOf(current as FontScalePreset)
  const at = idx >= 0 ? idx : FONT_SCALE_STEPS.indexOf(DEFAULT_FONT_SCALE as FontScalePreset)
  const next = Math.min(FONT_SCALE_STEPS.length - 1, Math.max(0, at + direction))
  return FONT_SCALE_STEPS[next]!
}

export const ReduceMotionSchema = z.enum(['system', 'on', 'off'])
export type ReduceMotion = z.infer<typeof ReduceMotionSchema>
export const DEFAULT_REDUCE_MOTION: ReduceMotion = 'system'

export const ContrastSchema = z.enum(['system', 'more'])
export type Contrast = z.infer<typeof ContrastSchema>
export const DEFAULT_CONTRAST: Contrast = 'system'

export const DEFAULT_ALWAYS_SHOW_FOCUS_RING = false

export const AnnounceVerbositySchema = z.enum(['off', 'brief', 'full'])
export type AnnounceVerbosity = z.infer<typeof AnnounceVerbositySchema>
export const DEFAULT_ANNOUNCE_VERBOSITY: AnnounceVerbosity = 'full'

export type AppearanceSettings = {
  theme: ThemeId
  fontScale: FontScale
  skinId: SkinId
  customCssPath: string
  reduceMotion: ReduceMotion
  contrast: Contrast
  alwaysShowFocusRing: boolean
  announceVerbosity: AnnounceVerbosity
}

export const APPEARANCE_LOCAL_STORAGE_KEY = 'vyotiq-appearance'

export type AppearanceBootCache = {
  theme: ThemeId
  resolvedTheme: ResolvedTheme
  fontScale: FontScale
  skinId: SkinId
  reduceMotion: ReduceMotion
  contrast: Contrast
  alwaysShowFocusRing: boolean
  announceVerbosity: AnnounceVerbosity
}

export function pickAppearanceSettings(settings: AppearanceSettings): AppearanceSettings {
  return {
    theme: settings.theme,
    fontScale: settings.fontScale,
    skinId: settings.skinId,
    customCssPath: settings.customCssPath,
    reduceMotion: settings.reduceMotion,
    contrast: settings.contrast,
    alwaysShowFocusRing: settings.alwaysShowFocusRing,
    announceVerbosity: settings.announceVerbosity
  }
}

export function resolveAppearanceBootCache(
  appearance: AppearanceSettings,
  systemDark = false
): AppearanceBootCache {
  return {
    theme: appearance.theme,
    fontScale: appearance.fontScale,
    skinId: appearance.skinId,
    reduceMotion: appearance.reduceMotion,
    contrast: appearance.contrast,
    alwaysShowFocusRing: appearance.alwaysShowFocusRing,
    announceVerbosity: appearance.announceVerbosity,
    resolvedTheme: resolveTheme(appearance.theme, systemDark)
  }
}

function isValidFontScale(value: unknown): value is FontScale {
  if (value === 'small' || value === 'default' || value === 'large') return true
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= FONT_SCALE_MIN &&
    value <= FONT_SCALE_MAX
  )
}

export function readAppearanceBootCache(): AppearanceBootCache | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(APPEARANCE_LOCAL_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const obj = parsed as Record<string, unknown>
    const theme = obj.theme
    const fontScale = obj.fontScale
    const skinId = obj.skinId
    const resolvedTheme = obj.resolvedTheme
    if (
      (theme !== 'system' && theme !== 'light' && theme !== 'dark') ||
      !isValidFontScale(fontScale) ||
      (skinId !== 'default' &&
        skinId !== 'proof' &&
        skinId !== 'bench' &&
        skinId !== 'native' &&
        skinId !== 'gild') ||
      (resolvedTheme !== 'light' && resolvedTheme !== 'dark')
    ) {
      return null
    }
    // New keys default when an older build wrote the cache without them;
    // a present-but-invalid value rejects the cache like the older keys do.
    const reduceMotion = obj.reduceMotion ?? DEFAULT_REDUCE_MOTION
    const contrast = obj.contrast ?? DEFAULT_CONTRAST
    const alwaysShowFocusRing = obj.alwaysShowFocusRing ?? DEFAULT_ALWAYS_SHOW_FOCUS_RING
    const announceVerbosity = obj.announceVerbosity ?? DEFAULT_ANNOUNCE_VERBOSITY
    if (
      (reduceMotion !== 'system' && reduceMotion !== 'on' && reduceMotion !== 'off') ||
      (contrast !== 'system' && contrast !== 'more') ||
      typeof alwaysShowFocusRing !== 'boolean' ||
      (announceVerbosity !== 'off' && announceVerbosity !== 'brief' && announceVerbosity !== 'full')
    ) {
      return null
    }
    return {
      theme,
      fontScale,
      skinId,
      resolvedTheme,
      reduceMotion,
      contrast,
      alwaysShowFocusRing,
      announceVerbosity
    }
  } catch {
    return null
  }
}

export function writeAppearanceBootCache(cache: AppearanceBootCache): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(APPEARANCE_LOCAL_STORAGE_KEY, JSON.stringify(cache))
  } catch {
    // Ignore quota / private-mode failures.
  }
}
