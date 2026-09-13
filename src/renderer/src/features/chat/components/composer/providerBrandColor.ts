const THEME_BACKGROUNDS = {
  light: ['#ffffff', '#f7fafc', '#eef5f9'],
  dark: ['#141414', '#1a1e20', '#202528']
} as const

const MIN_CONTRAST_RATIO = 3

function readCssColor(variable: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(variable).trim()
  return value || fallback
}

function themeBackgrounds(theme: 'light' | 'dark'): readonly [string, string, string] {
  const fallbacks = THEME_BACKGROUNDS[theme]
  return [
    readCssColor('--vy-bg', fallbacks[0]),
    readCssColor('--vy-card', fallbacks[1]),
    readCssColor('--vy-surface', fallbacks[2])
  ]
}

function parseHexColor(hex: string): [number, number, number] | null {
  const normalized = hex.trim().replace(/^#/, '')
  if (!/^[0-9a-f]{3}$|^[0-9a-f]{6}$/i.test(normalized)) return null
  const expanded =
    normalized.length === 3
      ? normalized
          .split('')
          .map((c) => c + c)
          .join('')
      : normalized
  const value = Number.parseInt(expanded, 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (c: number): number => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

export function contrastRatio(foreground: string, background: string): number {
  const fg = parseHexColor(foreground)
  const bg = parseHexColor(background)
  if (!fg || !bg) return 21
  const l1 = relativeLuminance(fg)
  const l2 = relativeLuminance(bg)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

/** Use brand color when it clears common theme surfaces; otherwise inherit foreground. */
export function resolveProviderBrandColor(
  colorPrimary: string,
  theme: string
): string {
  const resolvedTheme = theme === 'dark' ? 'dark' : 'light'
  const backgrounds = themeBackgrounds(resolvedTheme)
  const minContrast = Math.min(...backgrounds.map((bg) => contrastRatio(colorPrimary, bg)))
  if (minContrast < MIN_CONTRAST_RATIO) {
    return 'var(--vy-fg)'
  }
  return colorPrimary
}
