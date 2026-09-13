import { describe, expect, it } from 'vitest'
import {
  BROWSER_VIEWPORT_PRESETS,
  parseBrowserViewportPreset
} from '@renderer/features/chat/components/browserViewport'

describe('browser viewport presets', () => {
  it('parses known ids and falls back to fit', () => {
    expect(parseBrowserViewportPreset('iphone')).toBe('iphone')
    expect(parseBrowserViewportPreset('nope')).toBe('fit')
    expect(parseBrowserViewportPreset(null)).toBe('fit')
  })

  it('lists fit plus device sizes', () => {
    expect(BROWSER_VIEWPORT_PRESETS[0]?.id).toBe('fit')
    expect(BROWSER_VIEWPORT_PRESETS.some((p) => p.width === 390 && p.height === 844)).toBe(
      true
    )
  })
})
