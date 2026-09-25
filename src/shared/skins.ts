import { z } from 'zod'

export const SkinIdSchema = z.enum(['default', 'proof', 'bench', 'native', 'gild'])
export type SkinId = z.infer<typeof SkinIdSchema>

export const SKIN_IDS: readonly SkinId[] = ['default', 'proof', 'bench', 'native', 'gild']

/**
 * Shipped skin. `default` remains the Azure instrument look the base CSS
 * tokens encode; Native is the skin the product picks for you.
 */
export const DEFAULT_SKIN_ID: SkinId = 'native'

/** Previous product default, once written into settings.json. */
export const LEGACY_SKIN_ID: SkinId = 'default'

export type SkinCatalogEntry = {
  id: SkinId
  label: string
  /** One line under the skin's miniature in Settings. */
  description: string
}

/**
 * The skins in the order Settings offers them: the shipped one first. Each
 * line says what the skin's own tokens do, so it stays true only while they do.
 */
export const SKIN_CATALOG: readonly SkinCatalogEntry[] = [
  { id: 'native', label: 'Native', description: 'System type, branding orange' },
  { id: 'default', label: 'Default', description: 'Neutral grey, azure instrument' },
  { id: 'proof', label: 'Proof', description: 'Dusk contrast for long reading' },
  { id: 'bench', label: 'Bench', description: 'Workshop blue, the squarest corners' },
  { id: 'gild', label: 'Gild', description: 'Alabaster and onyx, blue slate' }
]

/** Opaque window canvas. */
export function resolveSkinWindowBackground(
  skinId: SkinId,
  resolved: 'light' | 'dark',
  _platform?: string
): string {
  switch (skinId) {
    case 'default':
      return resolved === 'dark' ? '#141414' : '#FFFFFF'
    case 'proof':
      return resolved === 'dark' ? '#272A3B' : '#F7F7F7'
    case 'bench':
      return resolved === 'dark' ? '#04040A' : '#FFFFFF'
    case 'native':
      return resolved === 'dark' ? '#1A1A1A' : '#F9F9F9'
    case 'gild':
      return resolved === 'dark' ? '#0A0A0A' : '#E5E4E2'
  }
}
