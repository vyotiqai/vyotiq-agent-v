/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APPEARANCE_LOCAL_STORAGE_KEY } from '@shared/appearance'

const BOOTSTRAP_PATH = join(process.cwd(), 'src/renderer/public/appearance-bootstrap.js')

function resetRoot(): void {
  const root = document.documentElement
  for (const attr of [
    'data-theme',
    'data-font-scale',
    'data-density',
    'data-skin'
  ]) {
    root.removeAttribute(attr)
  }
}

function mockMatchMedia(prefersDark = false): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn((query: string) => ({
      matches:
        (query.includes('prefers-color-scheme: dark') && prefersDark) ||
        false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))
  })
}

function runBootstrap(): void {
  const src = readFileSync(BOOTSTRAP_PATH, 'utf8')
  // Bootstrap is an IIFE loaded before the module graph; eval mirrors index.html script tag.
  eval(src)
}

describe('appearance-bootstrap', () => {
  beforeEach(() => {
    localStorage.clear()
    resetRoot()
    mockMatchMedia(false)
    // @ts-expect-error test bridge
    window.vyotiq = {
      platform: 'win32'
    }
  })

  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('sets full default attrs when cache is empty', () => {
    runBootstrap()
    const root = document.documentElement
    expect(root.getAttribute('data-skin')).toBe('default')
    expect(root.getAttribute('data-theme')).toBe('light')
    expect(root.getAttribute('data-font-scale')).toBe('default')
    expect(root.getAttribute('data-density')).toBe('default')
  })

  it('uses prefers-color-scheme when cache is empty', () => {
    mockMatchMedia(true)
    runBootstrap()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('applies valid cache fields and defaults missing ones', () => {
    localStorage.setItem(
      APPEARANCE_LOCAL_STORAGE_KEY,
      JSON.stringify({
        resolvedTheme: 'dark',
        skinId: 'proof'
      })
    )
    runBootstrap()
    const root = document.documentElement
    expect(root.getAttribute('data-theme')).toBe('dark')
    expect(root.getAttribute('data-skin')).toBe('proof')
    expect(root.getAttribute('data-font-scale')).toBe('default')
    expect(root.getAttribute('data-density')).toBe('default')
  })

  it('applies full valid cache without overwriting with defaults', () => {
    localStorage.setItem(
      APPEARANCE_LOCAL_STORAGE_KEY,
      JSON.stringify({
        resolvedTheme: 'light',
        fontScale: 'large',
        uiDensity: 'compact',
        skinId: 'native'
      })
    )
    runBootstrap()
    const root = document.documentElement
    expect(root.getAttribute('data-theme')).toBe('light')
    expect(root.getAttribute('data-font-scale')).toBe('large')
    expect(root.getAttribute('data-density')).toBe('compact')
    expect(root.getAttribute('data-skin')).toBe('native')
  })

  it('falls back to defaults on corrupt cache', () => {
    localStorage.setItem(APPEARANCE_LOCAL_STORAGE_KEY, '{not-json')
    runBootstrap()
    const root = document.documentElement
    expect(root.getAttribute('data-skin')).toBe('default')
    expect(root.getAttribute('data-font-scale')).toBe('default')
    expect(root.getAttribute('data-density')).toBe('default')
    expect(root.getAttribute('data-theme')).toBe('light')
  })

  it('defaults invalid skinId to default', () => {
    localStorage.setItem(
      APPEARANCE_LOCAL_STORAGE_KEY,
      JSON.stringify({
        resolvedTheme: 'dark',
        fontScale: 'default',
        uiDensity: 'default',
        skinId: 'neon'
      })
    )
    runBootstrap()
    expect(document.documentElement.getAttribute('data-skin')).toBe('default')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('sets default skin when localStorage throws', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    runBootstrap()
    expect(document.documentElement.getAttribute('data-skin')).toBe('default')
    getItem.mockRestore()
  })
})
