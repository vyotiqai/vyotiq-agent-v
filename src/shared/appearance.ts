import { z } from 'zod'
import type { ThemeId } from './theme'
import { resolveTheme, type ResolvedTheme } from './theme'
import { DEFAULT_SKIN_ID, SkinIdSchema, type SkinId } from './skins'

export { SkinIdSchema, type SkinId, DEFAULT_SKIN_ID, SKIN_CATALOG, SKIN_IDS } from './skins'

export const FontScaleSchema = z.enum(['small', 'default', 'large'])
export type FontScale = z.infer<typeof FontScaleSchema>

export const UiDensitySchema = z.enum(['compact', 'default', 'comfortable'])
export type UiDensity = z.infer<typeof UiDensitySchema>

export const AccentPresetSchema = z.enum(['neutral', 'blue', 'violet', 'green'])
export type AccentPreset = z.infer<typeof AccentPresetSchema>

export const DEFAULT_FONT_SCALE: FontScale = 'default'

const FONT_SCALE_STEPS: readonly FontScale[] = ['small', 'default', 'large']

/** Step the app text-size setting. Clamps at the ends (does not wrap). */
export function stepFontScale(current: FontScale, direction: 1 | -1): FontScale {
  const idx = FONT_SCALE_STEPS.indexOf(current)
  const at = idx >= 0 ? idx : FONT_SCALE_STEPS.indexOf(DEFAULT_FONT_SCALE)
  const next = Math.min(FONT_SCALE_STEPS.length - 1, Math.max(0, at + direction))
  return FONT_SCALE_STEPS[next]!
}

export const DEFAULT_UI_DENSITY: UiDensity = 'default'
export const DEFAULT_ACCENT_PRESET: AccentPreset = 'blue'

export type AppearanceSettings = {
  theme: ThemeId
  fontScale: FontScale
  uiDensity: UiDensity
  accentPreset: AccentPreset
  skinId: SkinId
  customCssPath: string
}

export const APPEARANCE_LOCAL_STORAGE_KEY = 'vyotiq-appearance'

export type AppearanceBootCache = {
  theme: ThemeId
  resolvedTheme: ResolvedTheme
  fontScale: FontScale
  uiDensity: UiDensity
  accentPreset: AccentPreset
  skinId: SkinId
}

export function pickAppearanceSettings(settings: AppearanceSettings): AppearanceSettings {
  return {
    theme: settings.theme,
    fontScale: settings.fontScale,
    uiDensity: settings.uiDensity,
    accentPreset: settings.accentPreset,
    skinId: settings.skinId,
    customCssPath: settings.customCssPath
  }
}

export function resolveAppearanceBootCache(
  appearance: AppearanceSettings,
  systemDark = false
): AppearanceBootCache {
  return {
    ...appearance,
    resolvedTheme: resolveTheme(appearance.theme, systemDark)
  }
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
    const uiDensity = obj.uiDensity
    const accentPreset = obj.accentPreset
    const skinId = obj.skinId
    const resolvedTheme = obj.resolvedTheme
    if (
      (theme !== 'system' && theme !== 'light' && theme !== 'dark') ||
      (fontScale !== 'small' && fontScale !== 'default' && fontScale !== 'large') ||
      (uiDensity !== 'compact' && uiDensity !== 'default' && uiDensity !== 'comfortable') ||
      (accentPreset !== 'neutral' &&
        accentPreset !== 'blue' &&
        accentPreset !== 'violet' &&
        accentPreset !== 'green') ||
      (skinId !== 'default' &&
        skinId !== 'proof' &&
        skinId !== 'bench' &&
        skinId !== 'native') ||
      (resolvedTheme !== 'light' && resolvedTheme !== 'dark')
    ) {
      return null
    }
    return {
      theme,
      fontScale,
      uiDensity,
      accentPreset,
      skinId,
      resolvedTheme
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
