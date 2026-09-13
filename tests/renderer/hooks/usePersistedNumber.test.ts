/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, renderHook, act } from '@testing-library/react'
import { usePersistedNumber } from '@renderer/lib/hooks/usePersistedNumber'

beforeEach(() => {
  const store = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, String(value))
      },
      removeItem: (key: string) => {
        store.delete(key)
      },
      clear: () => store.clear(),
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size
      }
    }
  })
})

afterEach(() => {
  cleanup()
})

describe('usePersistedNumber', () => {
  it('persists and restores a clamped value', () => {
    const clamp = (n: number) => Math.min(400, Math.max(100, Math.round(n)))
    const { result, unmount } = renderHook(() =>
      usePersistedNumber('vyotiq.testWidth', 220, clamp)
    )
    expect(result.current[0]).toBe(220)
    act(() => {
      result.current[1](500)
    })
    expect(result.current[0]).toBe(400)
    expect(localStorage.getItem('vyotiq.testWidth')).toBe('400')
    unmount()

    const again = renderHook(() => usePersistedNumber('vyotiq.testWidth', 220, clamp))
    expect(again.result.current[0]).toBe(400)
  })
})
