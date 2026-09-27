/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scrollToSettingsField } from '@renderer/features/settings/settingsSearchIndex'

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('scrollToSettingsField', () => {
  it('highlights the target field when it is mounted', () => {
    document.body.innerHTML = '<div data-settings-field="ollama-url"></div>'
    const el = document.querySelector('[data-settings-field="ollama-url"]') as HTMLElement
    el.scrollIntoView = vi.fn()
    scrollToSettingsField('ollama-url')
    expect(el.className).toContain('ring-1')
  })

  it('falls back to the owning accordion when a provider URL field is not mounted', () => {
    document.body.innerHTML =
      '<div data-settings-field="api-keys"></div><div data-settings-field="custom-endpoints"></div>'
    const keys = document.querySelector('[data-settings-field="api-keys"]') as HTMLElement
    const endpoints = document.querySelector(
      '[data-settings-field="custom-endpoints"]'
    ) as HTMLElement
    keys.scrollIntoView = vi.fn()
    endpoints.scrollIntoView = vi.fn()
    scrollToSettingsField('ollama-url')
    expect(keys.className).toContain('ring-1')
    scrollToSettingsField('custom-url')
    expect(endpoints.className).toContain('ring-1')
  })

  it('is a no-op for removed indexing fields', () => {
    document.body.innerHTML = '<div data-settings-field="codeindex-enabled"></div>'
    const el = document.querySelector('[data-settings-field="codeindex-enabled"]') as HTMLElement
    el.scrollIntoView = vi.fn()
    expect(() => scrollToSettingsField('codeindex-ollama-model')).not.toThrow()
    expect(el.className).not.toContain('ring-1')
  })
})
