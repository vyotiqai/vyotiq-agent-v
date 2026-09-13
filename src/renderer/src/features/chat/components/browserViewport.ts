export type BrowserViewportPresetId =
  | 'fit'
  | 'iphone-se'
  | 'iphone'
  | 'ipad'
  | 'laptop'
  | 'desktop'

export type BrowserViewportPreset = {
  id: BrowserViewportPresetId
  label: string
  width: number
  height: number
}

export const BROWSER_VIEWPORT_PRESETS: readonly BrowserViewportPreset[] = [
  { id: 'fit', label: 'Fit', width: 0, height: 0 },
  { id: 'iphone-se', label: '375×667', width: 375, height: 667 },
  { id: 'iphone', label: '390×844', width: 390, height: 844 },
  { id: 'ipad', label: '768×1024', width: 768, height: 1024 },
  { id: 'laptop', label: '1280×800', width: 1280, height: 800 },
  { id: 'desktop', label: '1440×900', width: 1440, height: 900 }
]

export const BROWSER_VIEWPORT_KEY = 'vyotiq.browserViewport'

export function parseBrowserViewportPreset(raw: string | null): BrowserViewportPresetId {
  const id = raw?.trim()
  if (BROWSER_VIEWPORT_PRESETS.some((p) => p.id === id)) {
    return id as BrowserViewportPresetId
  }
  return 'fit'
}

export function browserViewportPreset(
  id: BrowserViewportPresetId
): BrowserViewportPreset {
  return BROWSER_VIEWPORT_PRESETS.find((p) => p.id === id) ?? BROWSER_VIEWPORT_PRESETS[0]!
}
