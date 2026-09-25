/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  handleStaleChunkFailure,
  isStaleChunkFailure,
  rearmStaleChunkReload,
  resetStaleChunkReloadFlagForTests,
  takeStaleChunkReload,
  STALE_CHUNK_RELOAD_COOLDOWN_MS,
  STALE_CHUNK_RELOAD_DELAYS_MS,
  STALE_CHUNK_RELOAD_GRACE_MS
} from '@renderer/lib/staleChunk'
import { resetErrorLogRateLimiter } from '@renderer/logging/errorLogRateLimiter'

const MAX_ATTEMPTS = STALE_CHUNK_RELOAD_DELAYS_MS.length

function stubReload(): ReturnType<typeof vi.fn> {
  const reload = vi.fn()
  Object.defineProperty(window, 'location', {
    value: { reload },
    configurable: true,
    writable: true
  })
  return reload
}

describe('staleChunk recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetStaleChunkReloadFlagForTests()
    resetErrorLogRateLimiter()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('detects failed dynamic module imports across Chromium message shapes', () => {
    expect(
      isStaleChunkFailure(
        new TypeError(
          'Failed to fetch dynamically imported module: file:///C:/app/out/renderer/assets/FilesPanel-BXMtR6pW.js'
        )
      )
    ).toBe(true)
    expect(isStaleChunkFailure(new Error('Importing a module script failed.'))).toBe(true)
    expect(isStaleChunkFailure('error loading dynamically imported module x')).toBe(true)
    expect(isStaleChunkFailure(new TypeError('boom'))).toBe(false)
    expect(isStaleChunkFailure('plain failure')).toBe(false)
    expect(isStaleChunkFailure(undefined)).toBe(false)
    expect(isStaleChunkFailure({ message: 'Failed to fetch dynamically imported module' })).toBe(
      false
    )
  })

  it("detects Vite's CSS-preload shape, which carries no 'module' wording", () => {
    // __vitePreload rejects with this when the lazy chunk's stylesheet hash is
    // gone — the same rebuild, a message none of the module patterns match.
    expect(
      isStaleChunkFailure(new Error('Unable to preload CSS for /assets/FilesPanel-CtQm2k_x.css'))
    ).toBe(true)
  })

  it('grants a fresh reload budget to every rebuild, not one per window', () => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      expect(takeStaleChunkReload()).toBe(attempt)
    }
    // Stacked up inside the cooldown: this is a loop, so stop.
    expect(takeStaleChunkReload()).toBeNull()

    // sessionStorage survives location.reload(), so a boolean flag would have
    // stayed spent for the life of the window. A later rebuild must recover.
    vi.advanceTimersByTime(STALE_CHUNK_RELOAD_COOLDOWN_MS)
    expect(takeStaleChunkReload()).toBe(1)
  })

  it('re-arms on explicit user recovery', () => {
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) takeStaleChunkReload()
    expect(takeStaleChunkReload()).toBeNull()
    rearmStaleChunkReload()
    expect(takeStaleChunkReload()).toBe(1)
  })

  it('survives unreadable storage by failing open', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    expect(takeStaleChunkReload()).toBe(1)
    expect(takeStaleChunkReload()).toBe(1)
    getItem.mockRestore()
    setItem.mockRestore()
  })

  it('ignores a corrupt budget rather than blocking recovery', () => {
    sessionStorage.setItem('vyotiq-stale-chunk-reload', 'not json')
    expect(takeStaleChunkReload()).toBe(1)
  })

  it('leaves unrelated failures alone', () => {
    const reload = stubReload()
    expect(handleStaleChunkFailure(new Error('boom'))).toBe('not-stale')
    vi.runAllTimers()
    expect(reload).not.toHaveBeenCalled()
  })

  it('waits out the build write burst before re-entering', () => {
    const reload = stubReload()
    const stale = new TypeError('Failed to fetch dynamically imported module: x.js')

    expect(handleStaleChunkFailure(stale)).toBe('reloading')
    vi.advanceTimersByTime(STALE_CHUNK_RELOAD_DELAYS_MS[0] - 1)
    expect(reload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('swallows the fallout of a scheduled reload without scheduling another', () => {
    const reload = stubReload()
    const stale = new TypeError('Failed to fetch dynamically imported module: x.js')
    expect(handleStaleChunkFailure(stale)).toBe('reloading')

    // The surface tearing down behind the pending reload throws whatever it
    // throws — a lazy import that never resolved, a half-rendered tree.
    expect(handleStaleChunkFailure(new Error('Element type is invalid'))).toBe('reloading')
    vi.advanceTimersByTime(STALE_CHUNK_RELOAD_DELAYS_MS[0])
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('backs off further and finally gives up when a reload does not take', () => {
    const reload = stubReload()
    const stale = new TypeError('Failed to fetch dynamically imported module: x.js')
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      expect(handleStaleChunkFailure(stale)).toBe('reloading')
      vi.advanceTimersByTime(STALE_CHUNK_RELOAD_DELAYS_MS[attempt])
      expect(reload).toHaveBeenCalledTimes(attempt + 1)
      // No navigation followed, so suppression lapses and the next failure is
      // free to try again — with a longer wait each time.
      vi.advanceTimersByTime(STALE_CHUNK_RELOAD_GRACE_MS)
    }

    expect(handleStaleChunkFailure(stale)).toBe('exhausted')
    vi.runAllTimers()
    expect(reload).toHaveBeenCalledTimes(MAX_ATTEMPTS)
  })
})
