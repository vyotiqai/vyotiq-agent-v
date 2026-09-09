/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { pickAppearanceSettings, DEFAULT_SKIN_ID } from '@shared/appearance'
import { resolveTheme } from '@shared/theme'

function applyAppearanceDom(
  appearance: ReturnType<typeof pickAppearanceSettings>,
  resolvedTheme: 'light' | 'dark'
): void {
  const root = document.documentElement
  root.setAttribute('data-theme', resolvedTheme)
  root.setAttribute('data-font-scale', appearance.fontScale)
  root.setAttribute('data-density', appearance.uiDensity)
  root.setAttribute('data-skin', appearance.skinId)
}

describe('useAppearance DOM contract', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-skin')
  })

  it('sets data-skin from appearance settings', () => {
    const appearance = pickAppearanceSettings({
      theme: 'dark',
      fontScale: 'default',
      uiDensity: 'default',
      skinId: 'bench',
      customCssPath: ''
    })
    applyAppearanceDom(appearance, resolveTheme('dark', false))
    expect(document.documentElement.getAttribute('data-skin')).toBe('bench')
  })

  it('defaults skin to default in pickAppearanceSettings when present on settings object', () => {
    const appearance = pickAppearanceSettings({
      theme: 'system',
      fontScale: 'default',
      uiDensity: 'default',
      skinId: DEFAULT_SKIN_ID,
      customCssPath: '/tmp/custom.css'
    })
    expect(appearance.skinId).toBe('default')
    expect(appearance.customCssPath).toBe('/tmp/custom.css')
  })
})
