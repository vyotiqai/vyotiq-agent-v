import { z } from 'zod'

export const SkinIdSchema = z.enum(['default', 'proof', 'bench', 'native'])
export type SkinId = z.infer<typeof SkinIdSchema>

export const SKIN_IDS: readonly SkinId[] = ['default', 'proof', 'bench', 'native']

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
      background: 'linear-gradient(135deg, #fafafa 40%, #0072ce 40%, #0072ce 72%, #0de7ff 72%)'
    }
  },
  {
    id: 'native',
    label: 'Native',
    description: 'System fonts with branding-orange accent.',
    previewStyle: {
      background: 'linear-gradient(135deg, #f5f5f5 40%, #c2410c 40%, #c2410c 72%, #fb923c 72%)',
      fontFamily: 'system-ui, sans-serif'
    }
  }
]

/** Opaque window canvas. */
export function resolveSkinWindowBackground(
  _skinId: SkinId,
  resolved: 'light' | 'dark',
  _platform?: string
): string {
  return resolved === 'dark' ? '#000000' : '#ffffff'
}
