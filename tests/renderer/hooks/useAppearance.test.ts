/**
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APPEARANCE_LOCAL_STORAGE_KEY } from '@shared/appearance'
import { DEFAULT_SETTINGS } from '@shared/ipc'
import { useAppearance } from '@renderer/lib/hooks/useAppearance'

describe('useAppearance', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.removeAttribute('data-font-scale')
    document.documentElement.removeAttribute('data-skin')
    // @ts-expect-error test bridge
    window.vyotiq = {
      platform: 'win32',
      getSystemTheme: vi.fn(async () => ({ ok: true as const, data: false })),
      onSystemThemeChanged: vi.fn(() => () => undefined),
      onWindowFocusChanged: vi.fn(() => () => undefined)
    }
  })

  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('applies appearance attributes to the document root', () => {
    renderHook(() =>
      useAppearance({
        ...DEFAULT_SETTINGS,
        theme: 'dark',
        fontScale: 'large',
        skinId: 'native'
      })
    )
    const root = document.documentElement
    expect(root.getAttribute('data-theme')).toBe('dark')
    expect(root.getAttribute('data-font-scale')).toBe('large')
    expect(root.hasAttribute('data-density')).toBe(false)
    expect(root.getAttribute('data-skin')).toBe('native')
  })

  it('writes boot cache on apply', async () => {
    const { result } = renderHook(() => useAppearance(DEFAULT_SETTINGS))
    act(() => {
      result.current.setAppearance({ theme: 'light' })
    })
    await waitFor(() => {
      const raw = localStorage.getItem(APPEARANCE_LOCAL_STORAGE_KEY)
      expect(raw).toBeTruthy()
      expect(raw).toContain('"theme":"light"')
    })
  })

  it('reacts to native system theme IPC when theme is system', async () => {
    let handler: ((prefersDark: boolean) => void) | undefined
    // @ts-expect-error test bridge
    window.vyotiq = {
      platform: 'win32',
      getSystemTheme: vi.fn(async () => ({ ok: true as const, data: true })),
      onSystemThemeChanged: vi.fn((cb: (prefersDark: boolean) => void) => {
        handler = cb
        return () => undefined
      }),
      onWindowFocusChanged: vi.fn(() => () => undefined)
    }
    renderHook(() =>
      useAppearance({
        ...DEFAULT_SETTINGS,
        theme: 'system',
        fontScale: 'default'
      })
    )
    await waitFor(() => expect(handler).toBeTypeOf('function'))
    act(() => handler?.(true))
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('applies accessibility attributes and numeric scale to the document root', () => {
    const { result } = renderHook(() =>
      useAppearance({
        ...DEFAULT_SETTINGS,
        theme: 'light',
        fontScale: 1.52,
        skinId: 'native',
        reduceMotion: 'on',
        contrast: 'more',
        alwaysShowFocusRing: true,
        announceVerbosity: 'brief'
      })
    )
    const root = document.documentElement
    expect(root.getAttribute('data-font-scale')).toBe('1.52')
    expect(root.style.getPropertyValue('--vy-font-scale')).toBe('1.52')
    expect(root.getAttribute('data-reduce-motion')).toBe('on')
    expect(root.getAttribute('data-contrast')).toBe('more')
    expect(root.getAttribute('data-focus-ring')).toBe('always')
    expect(root.getAttribute('data-announce')).toBe('brief')
    expect(result.current.reduceMotion).toBe('on')
    expect(result.current.announceVerbosity).toBe('brief')
  })

  it('clears the inline scale for presets and defaults the focus ring', () => {
    renderHook(() =>
      useAppearance({
        ...DEFAULT_SETTINGS,
        theme: 'light',
        fontScale: 'large',
        skinId: 'native'
      })
    )
    const root = document.documentElement
    expect(root.getAttribute('data-font-scale')).toBe('large')
    expect(root.style.getPropertyValue('--vy-font-scale')).toBe('')
    expect(root.getAttribute('data-focus-ring')).toBe('auto')
    expect(root.getAttribute('data-announce')).toBe('full')
  })
})
