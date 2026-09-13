import { describe, expect, it } from 'vitest'
import { isSeedFallbackWarning } from '@renderer/features/chat/components/composer/composerModelUtils'

describe('isSeedFallbackWarning', () => {
  it('detects seed fallback catalog warnings', () => {
    expect(
      isSeedFallbackWarning(
        'Cannot reach Ollama at http://127.0.0.1:11434. Showing seed defaults (not live models).'
      )
    ).toBe(true)
    expect(
      isSeedFallbackWarning(
        'Ollama live catalog was empty; showing seed defaults (not installed models).'
      )
    ).toBe(true)
  })

  it('ignores null and live-catalog warnings', () => {
    expect(isSeedFallbackWarning(null)).toBe(false)
    expect(isSeedFallbackWarning('Using offline model list')).toBe(false)
  })
})
