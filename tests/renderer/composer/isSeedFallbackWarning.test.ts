import { describe, expect, it } from 'vitest'
import {
  isModelListUnsupportedWarning,
  isSeedFallbackWarning
} from '@renderer/features/chat/components/composer/composerModelUtils'

/** Real warning shape from ModelListUnsupportedError path in listProviderModels. */
const CUSTOM_405_WARNING =
  'Custom OpenAI-compatible does not serve a model list (HTTP 405); the host is reachable and chat can still connect. Type a model ID in the composer model picker search and press Enter to use it. Showing illustrative placeholder model IDs (not live models).'

const CUSTOM_501_WARNING =
  'Custom OpenAI-compatible does not serve a model list (HTTP 501); the host is reachable and chat can still connect. Showing illustrative placeholder model IDs (not live models).'

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

  it('still matches 405 list-unsupported warnings (placeholders stay out of live list)', () => {
    expect(isSeedFallbackWarning(CUSTOM_405_WARNING)).toBe(true)
    expect(isSeedFallbackWarning(CUSTOM_501_WARNING)).toBe(true)
  })

  it('ignores null and live-catalog warnings', () => {
    expect(isSeedFallbackWarning(null)).toBe(false)
    expect(isSeedFallbackWarning('Using offline model list')).toBe(false)
  })
})

describe('isModelListUnsupportedWarning', () => {
  it('detects reachable-host 405/501 catalog-unsupported warnings', () => {
    expect(isModelListUnsupportedWarning(CUSTOM_405_WARNING)).toBe(true)
    expect(isModelListUnsupportedWarning(CUSTOM_501_WARNING)).toBe(true)
  })

  it('does not match unreachable seed-fallback warnings', () => {
    expect(
      isModelListUnsupportedWarning(
        'Cannot reach Ollama at http://127.0.0.1:11434. Showing seed defaults (not live models).'
      )
    ).toBe(false)
    expect(isModelListUnsupportedWarning(null)).toBe(false)
    expect(isModelListUnsupportedWarning('host is reachable')).toBe(false)
  })
})
