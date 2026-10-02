import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * End-to-end wiring for the per-request browser egress gate: open a real tab
 * through the exported surface, capture the `onBeforeRequest` listener the
 * partition session was given, and drive it the way Chromium would.
 */

type BeforeRequestDetails = {
  id: number
  url: string
  method: string
  resourceType: string
  referrer: string
  timestamp: number
  uploadData: never[]
  webContentsId?: number
}
type BeforeRequestListener = (
  details: BeforeRequestDetails,
  callback: (response: { cancel?: boolean }) => void
) => void

type WcListener = (...args: unknown[]) => void

const hooks = vi.hoisted(() => ({
  /** Every listener handed to a partition session, in registration order. */
  beforeRequest: [] as BeforeRequestListener[],
  allowlist: [] as string[],
  nextWebContentsId: 1,
  /** Committed top-level URL per webContents id. */
  urls: new Map<number, string>(),
  /** webContents event listeners per webContents id. */
  listeners: new Map<number, Map<string, WcListener[]>>(),
  /** window-open handler per webContents id. */
  openHandlers: new Map<number, (details: { url: string }) => { action: string }>()
}))

vi.mock('electron', () => ({
  session: {
    fromPartition: () => ({
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      webRequest: {
        onHeadersReceived: vi.fn(),
        onBeforeRequest: (listener: BeforeRequestListener) => {
          hooks.beforeRequest.push(listener)
        }
      },
      on: vi.fn()
    })
  },
  WebContentsView: class {
    webContents: Record<string, unknown>
    setBounds = vi.fn()
    setVisible = vi.fn()
    constructor() {
      const id = hooks.nextWebContentsId++
      const own = new Map<string, WcListener[]>()
      hooks.listeners.set(id, own)
      this.webContents = {
        id,
        on: (event: string, listener: WcListener) => {
          own.set(event, [...(own.get(event) ?? []), listener])
        },
        once: vi.fn(),
        removeListener: vi.fn(),
        setWindowOpenHandler: (handler: (details: { url: string }) => { action: string }) => {
          hooks.openHandlers.set(id, handler)
        },
        isDestroyed: () => false,
        close: vi.fn(),
        focus: vi.fn(),
        getTitle: () => '',
        getURL: () => hooks.urls.get(id) ?? '',
        isLoading: () => false,
        loadURL: vi.fn().mockResolvedValue(undefined),
        setBackgroundThrottling: vi.fn(),
        session: {
          setPermissionRequestHandler: vi.fn(),
          setPermissionCheckHandler: vi.fn(),
          webRequest: { onHeadersReceived: vi.fn() }
        },
        capturePage: vi.fn().mockResolvedValue({
          getSize: () => ({ width: 10, height: 10 }),
          toJPEG: () => Buffer.from([0xff, 0xd8])
        })
      }
    }
  }
}))

vi.mock('@main/app/window', () => ({ getMainWindow: () => null }))

vi.mock('@main/settings/settings', () => ({
  getSettings: vi.fn(() => ({ browserDomainAllowlist: hooks.allowlist }))
}))

import { manageTabs, resetAgentBrowserForTests } from '@main/app/agentBrowser'
import { clearEgressLedger, listEgress } from '@main/net/egress'

const WS = '/ws-egress'

function tabIdFromOpen(result: string): string {
  const match = result.match(/Opened tab (t\d+)/)
  if (!match) throw new Error(`unexpected open result: ${result}`)
  return match[1]
}

/** Drive the captured listener and report whether the request was cancelled. */
function request(
  listener: BeforeRequestListener,
  url: string,
  opts: { webContentsId?: number; method?: string; resourceType?: string } = {}
): boolean {
  let response: { cancel?: boolean } | undefined
  listener(
    {
      id: 1,
      url,
      method: opts.method ?? 'GET',
      resourceType: opts.resourceType ?? 'xhr',
      referrer: '',
      timestamp: Date.now(),
      uploadData: [],
      ...(opts.webContentsId === undefined ? {} : { webContentsId: opts.webContentsId })
    },
    (res) => {
      response = res
    }
  )
  if (response === undefined) throw new Error('egress hook never answered the callback')
  return response.cancel === true
}

describe('agent browser egress hook', () => {
  beforeEach(() => {
    hooks.beforeRequest.length = 0
    hooks.allowlist = []
    hooks.nextWebContentsId = 1
    hooks.urls.clear()
    hooks.listeners.clear()
    hooks.openHandlers.clear()
    clearEgressLedger()
  })

  afterEach(() => {
    resetAgentBrowserForTests()
    clearEgressLedger()
  })

  it('registers exactly one listener per partition, however many tabs open', async () => {
    await manageTabs('open', { workspacePath: WS })
    expect(hooks.beforeRequest).toHaveLength(1)

    await manageTabs('open', { workspacePath: WS })
    expect(hooks.beforeRequest).toHaveLength(1)

    // A different workspace is a different partition, so it gets its own gate.
    await manageTabs('open', { workspacePath: '/ws-other' })
    expect(hooks.beforeRequest).toHaveLength(2)
  })

  it('cancels a subresource to a host outside the allowlist', async () => {
    hooks.allowlist = ['example.com']
    await manageTabs('open', { workspacePath: WS })
    const [listener] = hooks.beforeRequest

    expect(request(listener, 'https://evil.com/collect', { method: 'POST' })).toBe(true)
    expect(request(listener, 'https://example.com/api', { method: 'POST' })).toBe(false)
  })

  it('allows non-network schemes so ordinary pages keep working', async () => {
    hooks.allowlist = ['example.com']
    await manageTabs('open', { workspacePath: WS })
    const [listener] = hooks.beforeRequest

    expect(request(listener, 'about:blank', { resourceType: 'subFrame' })).toBe(false)
    expect(request(listener, 'data:text/plain,hi', { resourceType: 'image' })).toBe(false)
  })

  it('takes allowLocal from the originating tab and is strict when unattributable', async () => {
    const open = await manageTabs('open', { workspacePath: WS, allowLocal: true })
    tabIdFromOpen(open)
    const [listener] = hooks.beforeRequest
    // The mocked WebContentsView hands out ids from 1; the first tab holds 1.
    const tabWebContentsId = 1
    hooks.urls.set(tabWebContentsId, 'http://localhost:5173/')

    expect(request(listener, 'http://127.0.0.1:9000/x', { webContentsId: tabWebContentsId })).toBe(
      false
    )
    // No attributable tab (a service worker, say) gets the strict posture.
    expect(request(listener, 'http://127.0.0.1:9000/x')).toBe(true)
  })

  describe('private-network access from a public page', () => {
    const TAB = 1

    it('cancels subresources into loopback/LAN when the top-level page is public', async () => {
      await manageTabs('open', { workspacePath: WS, allowLocal: true })
      const [listener] = hooks.beforeRequest
      hooks.urls.set(TAB, 'https://evil.example/page')

      for (const url of [
        'http://127.0.0.1:9000/admin',
        'http://localhost:3000/api',
        'http://192.168.1.1/cgi-bin/reboot',
        'http://10.0.0.8/',
        'http://172.20.1.1/',
        'http://169.254.169.254/latest/meta-data',
        'http://[::1]:8080/',
        'http://[fd00::1]/',
        'http://printer.local/',
        'http://2130706433/',
        'ws://127.0.0.1:9229/'
      ]) {
        expect(request(listener, url, { webContentsId: TAB, method: 'POST' }), url).toBe(true)
      }
      // A subframe is a page load too.
      expect(
        request(listener, 'http://192.168.1.1/', { webContentsId: TAB, resourceType: 'subFrame' })
      ).toBe(true)
      // Public hosts are unaffected.
      expect(request(listener, 'https://cdn.example/app.js', { webContentsId: TAB })).toBe(false)

      const denied = listEgress({ deniedOnly: true, purpose: 'browser_subresource' })
      expect(denied.every((entry) => entry.reason === 'private_network')).toBe(true)
    })

    it('allows the same subresources when the top-level page is itself local', async () => {
      await manageTabs('open', { workspacePath: WS, allowLocal: true })
      const [listener] = hooks.beforeRequest
      hooks.urls.set(TAB, 'http://localhost:5173/')

      expect(request(listener, 'http://127.0.0.1:8787/api', { webContentsId: TAB })).toBe(false)
      expect(request(listener, 'http://192.168.1.20/', { webContentsId: TAB })).toBe(false)
    })

    it('leaves the main-frame request to the navigation guards', async () => {
      await manageTabs('open', { workspacePath: WS, allowLocal: true })
      const [listener] = hooks.beforeRequest
      // The agent explicitly navigating a public tab to its dev server.
      hooks.urls.set(TAB, 'https://example.com/')
      expect(
        request(listener, 'http://localhost:3000/', { webContentsId: TAB, resourceType: 'mainFrame' })
      ).toBe(false)
    })

    function emit(event: string, ...args: unknown[]): { prevented: boolean } {
      const state = { prevented: false }
      const evt = {
        preventDefault: () => {
          state.prevented = true
        },
        ...(args[0] as Record<string, unknown> | undefined)
      }
      for (const fn of hooks.listeners.get(TAB)?.get(event) ?? []) fn(evt, ...args.slice(1))
      return state
    }

    it('refuses a link or script navigation from a public page into local space', async () => {
      await manageTabs('open', { workspacePath: WS, allowLocal: true })
      hooks.urls.set(TAB, 'https://evil.example/')
      expect(emit('will-navigate', {}, 'http://192.168.1.1/admin').prevented).toBe(true)
      expect(emit('will-navigate', {}, 'https://other.example/').prevented).toBe(false)

      hooks.urls.set(TAB, 'http://localhost:3000/')
      expect(emit('will-navigate', {}, 'http://localhost:3000/login').prevented).toBe(false)
    })

    it('judges a redirect by the URL it leaves, not the page still committed', async () => {
      await manageTabs('open', { workspacePath: WS, allowLocal: true })
      // The tab still shows a local page while an explicit public navigation runs.
      hooks.urls.set(TAB, 'http://localhost:3000/')
      for (const fn of hooks.listeners.get(TAB)?.get('did-start-navigation') ?? []) {
        fn({ url: 'https://public.example/r', isMainFrame: true, isSameDocument: false })
      }
      expect(
        emit('will-redirect', { isMainFrame: true }, 'http://127.0.0.1:9000/admin').prevented
      ).toBe(true)

      // An explicit local navigation may redirect within local space.
      for (const fn of hooks.listeners.get(TAB)?.get('did-start-navigation') ?? []) {
        fn({ url: 'http://localhost:3000/', isMainFrame: true, isSameDocument: false })
      }
      expect(
        emit('will-redirect', { isMainFrame: true }, 'http://localhost:3000/login').prevented
      ).toBe(false)
    })

    it('denies a popup from a public page into local space', async () => {
      await manageTabs('open', { workspacePath: WS, allowLocal: true })
      hooks.urls.set(TAB, 'https://evil.example/')
      const handler = hooks.openHandlers.get(TAB)
      expect(handler).toBeDefined()
      expect(handler!({ url: 'http://localhost:8080/' })).toEqual({ action: 'deny' })
      expect(listEgress({ deniedOnly: true, purpose: 'browser_navigation' })).toEqual([
        expect.objectContaining({ origin: 'http://localhost:8080', reason: 'private_network' })
      ])
    })
  })

  it('records every decision in the ledger with the workspace attached', async () => {
    hooks.allowlist = ['example.com']
    await manageTabs('open', { workspacePath: WS })
    const [listener] = hooks.beforeRequest
    clearEgressLedger()

    request(listener, 'https://example.com/ok?token=SUPERSECRET')
    request(listener, 'https://evil.com/collect', { method: 'POST' })

    const entries = listEgress({ purpose: 'browser_subresource' })
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      origin: 'https://example.com',
      allowed: true,
      workspacePath: WS
    })
    expect(entries[1]).toMatchObject({
      origin: 'https://evil.com',
      allowed: false,
      reason: 'not_in_allowlist',
      method: 'POST',
      workspacePath: WS
    })
    expect(JSON.stringify(entries)).not.toContain('SUPERSECRET')
  })
})
