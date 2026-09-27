import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const sessionOn = vi.hoisted(() => vi.fn())
const browserViews = vi.hoisted(() => ({
  instances: [] as Array<{
    webContents: {
      setBackgroundThrottling: ReturnType<typeof vi.fn>
      capturePage: ReturnType<typeof vi.fn>
      debugger: { sendCommand: ReturnType<typeof vi.fn> }
    }
    setBounds: ReturnType<typeof vi.fn>
    setVisible: ReturnType<typeof vi.fn>
  }>
}))

/** A window's view list, enough for attach/detach bookkeeping. */
const hosts = vi.hoisted(() => {
  const contentView = () => {
    const children: unknown[] = []
    return {
      children,
      addChildView: (v: unknown) => children.push(v),
      removeChildView: (v: unknown) => {
        const i = children.indexOf(v)
        if (i >= 0) children.splice(i, 1)
      }
    }
  }
  return {
    contentView,
    main: {
      isDestroyed: () => false,
      once: () => undefined,
      webContents: { send: () => undefined },
      contentView: contentView()
    },
    offstage: [] as Array<{ contentView: { children: unknown[] }; setContentSize: (w: number, h: number) => void }>
  }
})

vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 1280, height: 800 }),
      toJPEG: () => Buffer.from([0xff, 0xd8])
    })
  },
  BaseWindow: class {
    contentView = hosts.contentView()
    size: [number, number] = [0, 0]
    setIgnoreMouseEvents = vi.fn()
    setPosition = vi.fn()
    showInactive = vi.fn()
    isDestroyed = () => false
    destroy = vi.fn()
    getContentSize = () => this.size
    setContentSize = (w: number, h: number) => {
      this.size = [w, h]
    }
    constructor() {
      hosts.offstage.push(this)
    }
  },
  session: {
    fromPartition: () => ({
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      webRequest: { onHeadersReceived: vi.fn(), onBeforeRequest: vi.fn() },
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
      debugger: {
        isAttached: () => boolean
        attach: ReturnType<typeof vi.fn>
        detach: ReturnType<typeof vi.fn>
        sendCommand: ReturnType<typeof vi.fn>
      }
      getZoomFactor: () => number
    }
    visible = false
    setBounds = vi.fn()
    setVisible = vi.fn((v: boolean) => {
      this.visible = v
    })
    getVisible = () => this.visible
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
          isEmpty: () => false,
          getSize: () => ({ width: 10, height: 10 }),
          toJPEG: () => Buffer.from([0xff, 0xd8])
        }),
        debugger: {
          isAttached: () => false,
          attach: vi.fn(),
          detach: vi.fn(),
          sendCommand: vi.fn(async (method: string) =>
            method === 'Page.getLayoutMetrics'
              ? { cssVisualViewport: { pageX: 0, pageY: 40, clientWidth: 1280, clientHeight: 800 } }
              : { data: Buffer.from([0x89, 0x50]).toString('base64') }
          )
        },
        getZoomFactor: () => 1,
        executeJavaScript: vi.fn(async () => ({ text: 'page', viewport: { w: 1280, h: 800 }, items: [] }))
      }
      browserViews.instances.push(this)
    }
  }
}))

vi.mock('@main/app/window', () => ({
  getMainWindow: () => hosts.main
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
  snapshotPage,
  takeBrowserScreenshot,
  HEADLESS_VIEWPORT
} from '@main/app/agentBrowser'
import type { ToolImageRef } from '@shared/ipc'

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
    hosts.offstage.length = 0
    hosts.main.contentView.children.length = 0
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
    expect(result.artifact).toMatch(/^browser\/snapshot-\d+-\d+\.jpg$/)
  })

  it('hosts the active tab offstage at a real size while no panel shows it', async () => {
    const { tabA } = await openOwnedTabs()
    expect(selectBrowserTab(tabA, WS_A)).toBe(true)
    const view = browserViews.instances[0]!
    const offstage = hosts.offstage.at(-1)!
    // It used to sit in the main window at 0x0: no viewport, no frame, no clicks.
    expect(offstage.contentView.children).toContain(view)
    expect(hosts.main.contentView.children).not.toContain(view)
    expect(view.setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 0,
      width: HEADLESS_VIEWPORT.width,
      height: HEADLESS_VIEWPORT.height
    })
    // Idle: laid out but unpainted.
    expect(view.setVisible).toHaveBeenLastCalledWith(false)

    await takeBrowserScreenshot({ runDir, tabId: tabA, workspacePath: WS_A })
    // Painted for the capture, read through DevTools, then back to idle.
    expect(view.setVisible).toHaveBeenCalledWith(true)
    expect(view.webContents.debugger.sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { x: 0, y: 40, width: 1280, height: 800, scale: 1 }
    })
    expect(view.webContents.capturePage).not.toHaveBeenCalled()
    expect(view.setVisible).toHaveBeenLastCalledWith(false)
  })

  it('records a burst: every frame kept, painted throughout, idle after', async () => {
    const { tabA } = await openOwnedTabs()
    expect(selectBrowserTab(tabA, WS_A)).toBe(true)
    const view = browserViews.instances[0]!
    const captures: ToolImageRef[] = []
    const text = await snapshotPage({
      runDir,
      tabId: tabA,
      workspacePath: WS_A,
      frames: 3,
      intervalMs: 50,
      captures
    })
    const shots = view.webContents.debugger.sendCommand.mock.calls.filter(
      ([method]) => method === 'Page.captureScreenshot'
    )
    expect(shots).toHaveLength(3)
    expect(captures).toHaveLength(3)
    expect(new Set(captures.map((c) => c.artifact)).size).toBe(3)
    expect(captures[0]!.label).toBe('viewport · frame 1/3 +0ms')
    expect(captures[2]!.label).toMatch(/^viewport · frame 3\/3 \+\d+ms$/)
    expect(text.match(/\[Screenshot saved under run browser\/snapshot-/g)).toHaveLength(3)
    // Painted for the whole burst: nothing hid the page between its frames.
    const { invocationCallOrder: shotOrder, calls: sent } = view.webContents.debugger.sendCommand.mock
    const shotAt = shotOrder.filter((_, i) => sent[i]![0] === 'Page.captureScreenshot')
    const { invocationCallOrder: paintOrder, calls: paints } = view.setVisible.mock
    const hiddenAt = paintOrder.filter((_, i) => paints[i]![0] === false)
    expect(hiddenAt.some((at) => at > shotAt[0]! && at < shotAt.at(-1)!)).toBe(false)
    expect(view.setVisible).toHaveBeenLastCalledWith(false)
  })

  it('moves the tab to the dock panel when it opens, and offstage at its size under a modal', async () => {
    const { tabA } = await openOwnedTabs()
    expect(selectBrowserTab(tabA, WS_A)).toBe(true)
    const view = browserViews.instances[0]!
    setAgentBrowserBounds({ x: 10, y: 20, width: 600, height: 400 })
    expect(hosts.main.contentView.children).toContain(view)
    expect(view.setVisible).toHaveBeenLastCalledWith(true)

    // A dialog covers the panel: the native view would paint over it.
    setAgentBrowserBounds({ x: 10, y: 20, width: 600, height: 400, occluded: true })
    expect(hosts.main.contentView.children).not.toContain(view)
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 600, height: 400 })
    setAgentBrowserBounds(null)
  })

  it('enumerates live workspace-visible tab ids in the unknown-tab error', async () => {
    const { tabA, tabB } = await openOwnedTabs()
    let message = ''
    try {
      await navigateUrl('https://example.com', {
        tabId: 't999',
        workspacePath: WS_A,
        agentControl: false
      })
      expect.fail('expected throw')
    } catch (err) {
      message = String(err)
    }
    expect(message).toContain('Unknown browser tab_id: t999')
    // Only this workspace's tabs are addressable, so only its ids are listed.
    const live = /Live tab ids: (.+)/.exec(message)?.[1]?.split(', ') ?? []
    expect(live).toEqual([tabA])
    expect(tabB).toMatch(/^t\d+$/)
  })

  it('says no live browser tabs when none are open', async () => {
    let message = ''
    try {
      await navigateUrl('https://example.com', {
        tabId: 't1',
        workspacePath: WS_A,
        agentControl: false
      })
      expect.fail('expected throw')
    } catch (err) {
      message = String(err)
    }
    expect(message).toContain('Unknown browser tab_id: t1')
    expect(message).toContain('No live browser tabs open.')
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
