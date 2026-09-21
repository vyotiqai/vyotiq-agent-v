import { afterEach, describe, expect, it, vi } from 'vitest'

interface FakeWcLike {
  url: string
  loading: boolean
  emit: (event: string) => boolean
}

// Shared between the electron mock factory and the tests below so a test can
// preconfigure loadURL behavior before navigateUrl runs (no races with the
// navigation continuation microtasks).
const h = vi.hoisted(() => {
  return {
    instances: [] as { webContents: FakeWcLike }[],
    loadBehavior: null as null | ((wc: FakeWcLike, url: string) => void)
  }
})

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')

  class FakeSession extends EventEmitter {
    setPermissionRequestHandler = (): void => {}
    setPermissionCheckHandler = (): void => {}
    webRequest = { onHeadersReceived: (): void => {}, onBeforeRequest: (): void => {} }
  }
  const sharedSession = new FakeSession()

  class FakeWebContents extends EventEmitter {
    url = 'about:blank'
    title = ''
    loading = false
    destroyedFlag = false
    loadURLCalls: string[] = []
    session = sharedSession
    setWindowOpenHandler = (): void => {}
    focus = (): void => {}
    setBackgroundThrottling = (): void => {}
    close = (): void => {}
    executeJavaScript = async (): Promise<boolean> => true
    isDestroyed = (): boolean => this.destroyedFlag
    getURL = (): string => this.url
    getTitle = (): string => this.title
    isLoading = (): boolean => this.loading
    loadURL = async (u: string): Promise<undefined> => {
      this.loadURLCalls.push(u)
      if (h.loadBehavior) {
        h.loadBehavior(this, u)
        return undefined
      }
      this.url = u
      this.loading = false
      this.emit('did-finish-load')
      return undefined
    }
  }

  class FakeWebContentsView {
    webContents = new FakeWebContents()
    setBounds = (): void => {}
    setVisible = (): void => {}
    constructor() {
      h.instances.push(this)
    }
  }

  return {
    session: { fromPartition: (): FakeSession => sharedSession },
    WebContentsView: FakeWebContentsView
  }
})

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null
}))

vi.mock('@main/settings/settings', () => ({
  getSettings: () => ({ browserDomainAllowlist: [] })
}))

import {
  navigateUrl,
  resetAgentBrowserForTests,
  settleAfterActionForTests
} from '@main/app/agentBrowser'

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

describe('navigateUrl superseded navigation (ERR_ABORTED)', () => {
  afterEach(() => {
    h.loadBehavior = null
    resetAgentBrowserForTests()
  })

  it('succeeds when loadURL rejects with ERR_ABORTED while the superseding navigation completes', async () => {
    h.loadBehavior = (wc, url) => {
      // Simulate a page-initiated redirect (e.g. Google) superseding the
      // wc.loadURL() call: the initial navigation rejects with ERR_ABORTED (-3)
      // while the superseding one completes and resolves `done` via
      // did-finish-load (waitForLoad already ignores errorCode -3 there).
      wc.loading = true
      queueMicrotask(() => {
        wc.url = 'https://www.google.com/'
        wc.loading = false
        wc.emit('did-finish-load')
      })
      const err = new Error(`ERR_ABORTED (-3) loading '${url}'`) as NodeJS.ErrnoException
      err.errno = -3
      throw err
    }
    const result = await navigateUrl('https://www.google.com/', { agentControl: true })
    expect(result).toContain('Navigated to https://www.google.com/')
    expect(result).toContain('tab_id: ')
  })
})
