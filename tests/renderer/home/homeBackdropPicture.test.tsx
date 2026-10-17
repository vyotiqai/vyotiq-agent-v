/** @vitest-environment jsdom */
/**
 * Home's backdrop picture is read over IPC once per pick, not once per visit
 * to Home: Home unmounts whenever another view opens, and the picture can be
 * ~11 MB of base64.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { HomeBackdrop, resetHomeBackdropCacheForTests } from '@renderer/features/home/components/HomeBackdrop'

const read = vi.fn(async () => ({ ok: true as const, data: { dataUrl: 'data:image/png;base64,iVBORw==' } }))

beforeEach(() => {
  resetHomeBackdropCacheForTests()
  read.mockClear()
  // jsdom has neither; the canvases only need them to exist.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    }
  )
  window.vyotiq = { appearanceReadHomeBackdrop: read } as unknown as typeof window.vyotiq
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Home backdrop picture', () => {
  it('reads the picture once per pick, however often Home opens', async () => {
    const first = render(<HomeBackdrop kind="image" imageStamp="2026-10-17T10:00:00.000Z" />)
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    first.unmount()
    render(<HomeBackdrop kind="image" imageStamp="2026-10-17T10:00:00.000Z" />)
    cleanup()
    expect(read).toHaveBeenCalledTimes(1)
    // A new pick moves the stamp: read again, never the old picture.
    render(<HomeBackdrop kind="image" imageStamp="2026-10-17T11:00:00.000Z" />)
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  })

  it('lets the picture go when the backdrop leaves it, and retries a read that failed', async () => {
    const a = render(<HomeBackdrop kind="image" imageStamp="s1" />)
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    a.unmount()
    render(<HomeBackdrop kind="pixels" imageStamp="s1" />)
    cleanup()
    render(<HomeBackdrop kind="image" imageStamp="s1" />)
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    cleanup()

    resetHomeBackdropCacheForTests()
    read.mockResolvedValueOnce({ ok: false, error: 'gone' } as never)
    render(<HomeBackdrop kind="image" imageStamp="s2" />)
    await waitFor(() => expect(read).toHaveBeenCalledTimes(3))
    cleanup()
    render(<HomeBackdrop kind="image" imageStamp="s2" />)
    await waitFor(() => expect(read).toHaveBeenCalledTimes(4))
  })
})

describe('Home backdrop canvas', () => {
  it('draws in device pixels, and again when the display scaling changes with the box the same size', () => {
    // A controllable resolution query: jsdom has none, and Chromium's device emulation never fires one.
    const queries: Array<{ media: string; listeners: Set<() => void> }> = []
    vi.stubGlobal('matchMedia', (media: string) => {
      const q = { media, listeners: new Set<() => void>() }
      queries.push(q)
      return {
        media,
        matches: true,
        addEventListener: (_: string, fn: () => void) => q.listeners.add(fn),
        removeEventListener: (_: string, fn: () => void) => q.listeners.delete(fn)
      }
    })
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (target, key) => (key in target ? target[key as string] : key === 'createLinearGradient' ? () => ({ addColorStop() {} }) : () => {}),
      set: (target, key, value) => {
        target[key as string] = value
        return true
      }
    })
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never)
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400)
    const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100)
    vi.stubGlobal('devicePixelRatio', 1.5)
    try {
      render(<HomeBackdrop kind="pixels" imageStamp="" />)
      const canvas = document.querySelector('[data-home-backdrop] canvas') as HTMLCanvasElement
      expect([canvas.width, canvas.height]).toEqual([600, 150])
      expect(queries.at(-1)!.media).toBe('(resolution: 1.5dppx)')

      vi.stubGlobal('devicePixelRatio', 2)
      const armed = queries.at(-1)!
      armed.listeners.forEach((fn) => fn())
      expect([canvas.width, canvas.height]).toEqual([800, 200])
      // The old query is let go and the new ratio watched, so the next move is heard too.
      expect(armed.listeners.size).toBe(0)
      expect(queries.at(-1)!.media).toBe('(resolution: 2dppx)')
      expect(queries.at(-1)!.listeners.size).toBe(1)

      cleanup()
      expect(queries.at(-1)!.listeners.size).toBe(0)
    } finally {
      getContext.mockRestore()
      width.mockRestore()
      height.mockRestore()
    }
  })
})
