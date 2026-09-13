import { describe, expect, it } from 'vitest'
import {
  contrastRatio,
  resolveProviderBrandColor
} from '@renderer/features/chat/components/composer/providerBrandColor'

describe('providerBrandColor', () => {
  it('reports low contrast for black on dark and white on light', () => {
    expect(contrastRatio('#000000', '#000000')).toBeLessThan(3)
    expect(contrastRatio('#ffffff', '#ffffff')).toBeLessThan(3)
  })

  it('falls back to foreground on dark surfaces for black brand marks', () => {
    expect(resolveProviderBrandColor('#000000', 'dark')).toBe('var(--vy-fg)')
  })

  it('falls back to foreground token for invisible brand colors', () => {
    expect(resolveProviderBrandColor('#000000', 'dark')).toBe('var(--vy-fg)')
    expect(resolveProviderBrandColor('#ffffff', 'light')).toBe('var(--vy-fg)')
    expect(resolveProviderBrandColor('#F1F0E8', 'light')).toBe('var(--vy-fg)')
  })

  it('keeps high-contrast brand colors', () => {
    expect(resolveProviderBrandColor('#4D6BFE', 'light')).toBe('#4D6BFE')
    expect(resolveProviderBrandColor('#FA520F', 'dark')).toBe('#FA520F')
  })
})
