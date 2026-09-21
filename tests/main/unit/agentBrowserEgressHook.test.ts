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

const hooks = vi.hoisted(() => ({
  /** Every listener handed to a partition session, in registration order. */
  beforeRequest: [] as BeforeRequestListener[],
  allowlist: [] as string[],
  nextWebContentsId: 1
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
      this.webContents = {
        id: hooks.nextWebContentsId++,
        on: vi.fn(),
        once: vi.fn(),
        removeListener: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        isDestroyed: () => false,
        close: vi.fn(),
        focus: vi.fn(),
        getTitle: () => '',
        getURL: () => '',
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

    expect(request(listener, 'http://127.0.0.1:9000/x', { webContentsId: tabWebContentsId })).toBe(
      false
    )
    // No attributable tab (a service worker, say) gets the strict posture.
    expect(request(listener, 'http://127.0.0.1:9000/x')).toBe(true)
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
