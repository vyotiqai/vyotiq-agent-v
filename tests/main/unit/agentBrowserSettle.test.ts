import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  session: { fromPartition: () => ({ on: vi.fn() }) },
  WebContentsView: class {
    webContents = {
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      isDestroyed: () => false,
      close: vi.fn()
    }
    setBounds = vi.fn()
    setVisible = vi.fn()
  }
}))

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null
}))

import { settleAfterActionForTests } from '@main/app/agentBrowser'

function createFakeContents() {
  const listeners = new Map<string, Set<() => void>>()
  return {
    listenerCount(event: string): number {
      return listeners.get(event)?.size ?? 0
    },
    emit(event: string): void {
      const set = listeners.get(event)
      if (!set) return
      for (const listener of [...set]) {
        set.delete(listener)
        listener()
      }
    },
    once(event: string, listener: () => void): void {
      let set = listeners.get(event)
      if (!set) {
        set = new Set()
        listeners.set(event, set)
      }
      set.add(listener)
    },
    removeListener(event: string, listener: () => void): void {
      listeners.get(event)?.delete(listener)
    }
  }
}

describe('browser action settle cleanup', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('removes navigation listeners when the settle fallback wins', async () => {
    vi.useFakeTimers()
    const wc = createFakeContents()
    const done = settleAfterActionForTests(wc, undefined, { waitForNav: true, settleMs: 50 })
    expect(wc.listenerCount('did-finish-load')).toBe(1)
    expect(wc.listenerCount('did-navigate-in-page')).toBe(1)
    await vi.advanceTimersByTimeAsync(50)
    await done
    expect(wc.listenerCount('did-finish-load')).toBe(0)
    expect(wc.listenerCount('did-navigate-in-page')).toBe(0)
  })

  it('removes navigation listeners when a navigation event wins', async () => {
    vi.useFakeTimers()
    const wc = createFakeContents()
    const done = settleAfterActionForTests(wc, undefined, { waitForNav: true, settleMs: 5_000 })
    wc.emit('did-finish-load')
    await done
    expect(wc.listenerCount('did-finish-load')).toBe(0)
    expect(wc.listenerCount('did-navigate-in-page')).toBe(0)
    await vi.advanceTimersByTimeAsync(8_000)
    expect(wc.listenerCount('did-finish-load')).toBe(0)
    expect(wc.listenerCount('did-navigate-in-page')).toBe(0)
  })

  it('cancels navigation wait and removes listeners on abort', async () => {
    vi.useFakeTimers()
    const wc = createFakeContents()
    const controller = new AbortController()
    const done = settleAfterActionForTests(wc, controller.signal, {
      waitForNav: true,
      settleMs: 5_000
    })
    controller.abort()
    await expect(done).rejects.toMatchObject({ name: 'AbortError' })
    expect(wc.listenerCount('did-finish-load')).toBe(0)
    expect(wc.listenerCount('did-navigate-in-page')).toBe(0)
  })
})
