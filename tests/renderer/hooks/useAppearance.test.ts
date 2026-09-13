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
    document.documentElement.removeAttribute('data-density')
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
        uiDensity: 'compact',
        skinId: 'native'
      })
    )
    const root = document.documentElement
    expect(root.getAttribute('data-theme')).toBe('dark')
    expect(root.getAttribute('data-font-scale')).toBe('large')
    expect(root.getAttribute('data-density')).toBe('compact')
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
        fontScale: 'default',
        uiDensity: 'default',
      })
    )
    await waitFor(() => expect(handler).toBeTypeOf('function'))
    act(() => handler?.(true))
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })
})
