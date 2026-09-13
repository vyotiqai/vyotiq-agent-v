export type ResolvedTheme = 'light' | 'dark'

export type ThemeId = 'system' | 'light' | 'dark'

export function resolveTheme(
  preference: ThemeId,
  systemDark = false
): ResolvedTheme {
  if (preference === 'system') return systemDark ? 'dark' : 'light'
  return preference
}
