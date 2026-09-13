import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const sessionOn = vi.hoisted(() => vi.fn())
const browserViews = vi.hoisted(() => ({
  instances: [] as Array<{
    webContents: { setBackgroundThrottling: ReturnType<typeof vi.fn> }
    setBounds: ReturnType<typeof vi.fn>
    setVisible: ReturnType<typeof vi.fn>
  }>
}))

vi.mock('electron', () => ({
  session: {
    fromPartition: () => ({
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      webRequest: { onHeadersReceived: vi.fn() },
      on: sessionOn
    })
  },
  WebContentsView: class {
    webContents: {
      on: ReturnType<typeof vi.fn>
      once: ReturnType<typeof vi.fn>
      removeListener: ReturnType<typeof vi.fn>
      setWindowOpenHandler: ReturnType<typeof vi.fn>
      isDestroyed: () => boolean
      close: ReturnType<typeof vi.fn>
      focus: ReturnType<typeof vi.fn>
      getTitle: () => string
      getURL: () => string
      isLoading: () => boolean
      loadURL: ReturnType<typeof vi.fn>
      setBackgroundThrottling: ReturnType<typeof vi.fn>
      session: {
        setPermissionRequestHandler: ReturnType<typeof vi.fn>
        setPermissionCheckHandler: ReturnType<typeof vi.fn>
        webRequest: { onHeadersReceived: ReturnType<typeof vi.fn> }
      }
      capturePage: ReturnType<typeof vi.fn>
    }
    setBounds = vi.fn()
    setVisible = vi.fn()
    constructor() {
      this.webContents = {
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
      browserViews.instances.push(this)
    }
  }
}))

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null
}))

vi.mock('@main/settings/settings', () => ({
  getSettings: vi.fn(() => ({ browserDomainAllowlist: [] }))
}))

import {
  manageTabs,
  navigateUrl,
  resetAgentBrowserForTests,
  selectBrowserTab,
  setAgentBrowserBounds,
  takeBrowserScreenshot
} from '@main/app/agentBrowser'

const WS_A = '/ws-a'
const WS_B = '/ws-b'

function tabIdFromOpen(result: string): string {
  const match = result.match(/Opened tab (t\d+)/)
  if (!match) throw new Error(`unexpected open result: ${result}`)
  return match[1]
}

describe('browser tab workspace ownership', () => {
  let runDir = ''

  beforeEach(() => {
    sessionOn.mockClear()
    browserViews.instances.length = 0
    runDir = mkdtempSync(join(tmpdir(), 'vyotiq-browser-ss-'))
  })

  afterEach(() => {
    resetAgentBrowserForTests()
    rmSync(runDir, { recursive: true, force: true })
  })

  async function openOwnedTabs(): Promise<{ tabA: string; tabB: string }> {
    const tabA = tabIdFromOpen(await manageTabs('open', { workspacePath: WS_A }))
    const tabB = tabIdFromOpen(await manageTabs('open', { workspacePath: WS_B }))
    return { tabA, tabB }
  }

  it('refuses navigate to an explicit tab owned by another workspace', async () => {
    const { tabA } = await openOwnedTabs()
    await expect(
      navigateUrl('https://example.com', {
        tabId: tabA,
        workspacePath: WS_B,
        agentControl: false
      })
    ).rejects.toThrow(`Unknown browser tab_id: ${tabA}`)
  })

  it('refuses select/close of an explicit tab owned by another workspace', async () => {
    const { tabA, tabB } = await openOwnedTabs()

    await expect(manageTabs('select', { tabId: tabA, workspacePath: WS_B })).rejects.toThrow(
      `Unknown browser tab_id: ${tabA}`
    )
    expect(selectBrowserTab(tabA, WS_B)).toBe(false)
    expect(selectBrowserTab(tabA, WS_A)).toBe(true)

    await expect(manageTabs('close', { tabId: tabA, workspacePath: WS_B })).rejects.toThrow(
      `Unknown browser tab_id: ${tabA}`
    )
    await expect(manageTabs('close', { tabId: tabA, workspacePath: WS_A })).resolves.toBe(
      `Closed tab ${tabA}`
    )
    expect(tabB).toMatch(/^t\d+$/)
  })

  it('refuses screenshot of an explicit tab owned by another workspace', async () => {
    const { tabA } = await openOwnedTabs()

    await expect(
      takeBrowserScreenshot({
        runDir,
        tabId: tabA,
        workspacePath: WS_B
      })
    ).rejects.toThrow(`Unknown browser tab_id: ${tabA}`)

    const result = await takeBrowserScreenshot({
      runDir,
      tabId: tabA,
      workspacePath: WS_A
    })
    expect(result.path).toContain(join('browser', 'snapshot-'))
  })

  it('installs a will-download handler that prevents unowned downloads', async () => {
    await openOwnedTabs()
    expect(sessionOn).toHaveBeenCalledWith('will-download', expect.any(Function))
    const handler = sessionOn.mock.calls.find((call) => call[0] === 'will-download')?.[1] as
      | ((event: { preventDefault: () => void }) => void)
      | undefined
    expect(handler).toBeTypeOf('function')
    const event = { preventDefault: vi.fn() }
    handler!(event)
    expect(event.preventDefault).toHaveBeenCalled()
  })
})

function lastThrottling(index: number): boolean | undefined {
  const calls = browserViews.instances[index]?.webContents.setBackgroundThrottling.mock.calls
  return calls?.[calls.length - 1]?.[0] as boolean | undefined
}

describe('agent browser background throttling', () => {
  beforeEach(() => {
    sessionOn.mockClear()
    browserViews.instances.length = 0
  })

  afterEach(() => {
    resetAgentBrowserForTests()
  })

  it('restores default throttling on hidden tabs and disables it while painted', async () => {
    const tabA = tabIdFromOpen(await manageTabs('open', { workspacePath: WS_A }))
    const tabB = tabIdFromOpen(await manageTabs('open', { workspacePath: WS_A }))
    expect(browserViews.instances).toHaveLength(2)
    // Dock closed (no bounds): guests may sleep after the tool lock releases.
    expect(lastThrottling(0)).toBe(true)
    expect(lastThrottling(1)).toBe(true)

    setAgentBrowserBounds({ x: 8, y: 12, width: 640, height: 480 })
    expect(lastThrottling(0)).toBe(true)
    expect(lastThrottling(1)).toBe(false)
    expect(browserViews.instances[1]?.setBounds).toHaveBeenCalledWith({
      x: 8,
      y: 12,
      width: 640,
      height: 480
    })
    expect(browserViews.instances[0]?.setVisible).toHaveBeenCalledWith(false)
    expect(browserViews.instances[1]?.setVisible).toHaveBeenCalledWith(true)

    expect(selectBrowserTab(tabA, WS_A)).toBe(true)
    expect(lastThrottling(0)).toBe(false)
    expect(lastThrottling(1)).toBe(true)
    expect(tabB).toMatch(/^t\d+$/)
  })

  it('keeps the active guest unthrottled while a browser tool holds the lock', async () => {
    await manageTabs('open', { workspacePath: WS_A })
    expect(lastThrottling(0)).toBe(true)

    await navigateUrl('https://example.com', {
      workspacePath: WS_A,
      agentControl: true
    })
    const calls = browserViews.instances[0]!.webContents.setBackgroundThrottling.mock.calls.map(
      (c) => c[0]
    )
    expect(calls).toContain(false)
    expect(lastThrottling(0)).toBe(true)
  })
})
