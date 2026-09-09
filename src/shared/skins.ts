import { z } from 'zod'

export const SkinIdSchema = z.enum(['default', 'proof', 'bench', 'native', 'gild'])
export type SkinId = z.infer<typeof SkinIdSchema>

export const SKIN_IDS: readonly SkinId[] = ['default', 'proof', 'bench', 'native', 'gild']

export const DEFAULT_SKIN_ID: SkinId = 'default'

export type SkinCatalogEntry = {
  id: SkinId
  label: string
  description: string
  /** Inline preview for the settings swatch chip. */
  previewStyle: Record<string, string>
}

export const SKIN_CATALOG: readonly SkinCatalogEntry[] = [
  {
    id: 'default',
    label: 'Default',
    description: 'Azure instrument look.',
    previewStyle: {
      background: 'linear-gradient(135deg, #ffffff 40%, #00638e 40%, #00638e 72%, #4fb3e8 72%)'
    }
  },
  {
    id: 'proof',
    label: 'Proof',
    description: 'Dusk contrast for diffs and long reading.',
    previewStyle: {
      background: 'linear-gradient(135deg, #f7f7f7 40%, #736a86 40%, #736a86 72%, #aca3c4 72%)'
    }
  },
  {
    id: 'bench',
    label: 'Bench',
    description: 'Neon-blue workshop — borders only, no elevation.',
    previewStyle: {
      background: 'linear-gradient(135deg, #ffffff 40%, #0072ce 40%, #0072ce 72%, #0de7ff 72%)'
    }
  },
  {
    id: 'native',
    label: 'Native',
    description: 'System fonts with branding-orange accent.',
    previewStyle: {
      background: 'linear-gradient(135deg, #f9f9f9 40%, #c2410c 40%, #c2410c 72%, #fb923c 72%)',
      fontFamily: 'system-ui, sans-serif'
    }
  },
  {
    id: 'gild',
    label: 'Gild',
    description: 'Blue-slate instrument on alabaster and onyx.',
    previewStyle: {
      background: 'linear-gradient(135deg, #e5e4e2 40%, #536878 40%, #536878 72%, #0a0a0a 72%)'
    }
  }
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
