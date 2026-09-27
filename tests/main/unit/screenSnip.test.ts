import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

type GrabReply = Record<string, unknown>

const fake = vi.hoisted(() => ({
  userData: '',
  windowSources: [] as Array<{ id: string; name: string }>,
  screenSources: [] as Array<{ id: string; name: string; display_id: string }>,
  /** Every BaseWindow the app has open, helpers included. */
  windows: [] as Array<{ getOpacity: () => number; getMediaSourceId: () => string; isDestroyed: () => boolean }>,
  start: { ok: true } as Record<string, unknown>,
  grabs: [] as GrabReply[],
  calls: [] as string[],
  shown: 0,
  hidden: 0
}))

vi.mock('electron', () => {
  class FakeBaseWindow {
    static getAllWindows = () => fake.windows
    contentView = { addChildView: () => undefined }
    setIgnoreMouseEvents = () => undefined
    setPosition = () => undefined
    showInactive = () => {
      fake.shown += 1
    }
    hide = () => {
      fake.hidden += 1
    }
    isDestroyed = () => false
    destroy = () => undefined
    getOpacity = () => 0
    getMediaSourceId = () => 'window:777:0'
    constructor() {
      fake.windows.push(this)
    }
  }
  class FakeView {
    setBounds = () => undefined
    webContents = {
      setWindowOpenHandler: () => undefined,
      on: () => undefined,
      loadFile: async () => undefined,
      isDestroyed: () => false,
      close: () => undefined,
      executeJavaScript: async (code: string) => {
        if (code.includes('getUserMedia')) {
          fake.calls.push(`start ${/\)\("([^"]+)"\)$/.exec(code)?.[1] ?? '?'}`)
          return fake.start
        }
        if (code.includes('grabFrame')) {
          fake.calls.push(`grab ${/\}\)\((\{.*\})\)$/s.exec(code)?.[1] ?? ''}`)
          return fake.grabs.shift() ?? { error: 'ended' }
        }
        fake.calls.push('stop')
        return true
      }
    }
  }
  return {
    app: { getPath: () => fake.userData },
    BaseWindow: FakeBaseWindow,
    WebContentsView: FakeView,
    session: {
      fromPartition: () => ({
        setPermissionRequestHandler: () => undefined,
        setPermissionCheckHandler: () => undefined
      })
    },
    desktopCapturer: {
      getSources: async ({ types }: { types: string[] }) =>
        types.includes('window') ? fake.windowSources : fake.screenSources
    },
    screen: {
      getPrimaryDisplay: () => ({ id: 2 }),
      getAllDisplays: () => [
        { id: 1, size: { width: 1280, height: 1024 }, scaleFactor: 1 },
        { id: 2, size: { width: 1536, height: 864 }, scaleFactor: 1.25 }
      ]
    }
  }
})

vi.mock('@main/app/window', () => ({ getMainWindow: () => null }))

import { disposeScreenSnip, listSnipSources, snipScreen } from '@main/app/screenSnip'

function frame(extra: GrabReply = {}): GrabReply {
  return {
    dataUrl: `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff]).toString('base64')}`,
    width: 1280,
    height: 720,
    nativeWidth: 1920,
    nativeHeight: 1080,
    fullWidth: 1280,
    fullHeight: 720,
    region: null,
    ...extra
  }
}

beforeAll(() => {
  fake.userData = mkdtempSync(join(tmpdir(), 'vyotiq-snip-'))
})

afterAll(() => {
  disposeScreenSnip()
  rmSync(fake.userData, { recursive: true, force: true })
})

beforeEach(() => {
  disposeScreenSnip()
  // The agent browser's invisible offstage window is a real OS window too.
  fake.windows = [
    { getOpacity: () => 0, getMediaSourceId: () => 'window:555:0', isDestroyed: () => false },
    { getOpacity: () => 1, getMediaSourceId: () => 'window:100:0', isDestroyed: () => false }
  ]
  fake.windowSources = [
    { id: 'window:555:1', name: 'Vyotiq agent browser (offstage)' },
    { id: 'window:100:1', name: 'Vyotiq' },
    { id: 'window:200:1', name: 'My Game — settings' },
    { id: 'window:300:1', name: 'My Game' },
    { id: 'window:400:1', name: '' }
  ]
  fake.screenSources = [
    { id: 'screen:0:0', name: 'Screen 1', display_id: '1' },
    { id: 'screen:1:0', name: 'Screen 2', display_id: '2' }
  ]
  fake.start = { ok: true }
  fake.grabs = []
  fake.calls = []
  fake.shown = 0
  fake.hidden = 0
})

describe('screen snip sources', () => {
  it('lists real windows only, never our own invisible helpers', async () => {
    const sources = await listSnipSources()
    expect(sources.windows).toEqual(['Vyotiq', 'My Game — settings', 'My Game'])
    expect(sources.displays).toEqual([
      { index: 0, width: 1280, height: 1024, primary: false },
      { index: 1, width: 1920, height: 1080, primary: true }
    ])
  })

  it('prefers an exact title, then a prefix, and names the other matches', async () => {
    fake.grabs = [frame()]
    const result = await snipScreen({ target: { kind: 'window', title: 'my game' } })
    expect(fake.calls[0]).toBe('start window:300:1')
    expect(result.source).toEqual({ kind: 'window', name: 'My Game' })
    expect(result.otherMatches).toEqual(['My Game — settings'])
  })

  it('explains a miss, including that minimized windows are not snippable', async () => {
    await expect(snipScreen({ target: { kind: 'window', title: 'terminal' } })).rejects.toThrow(
      /Minimized windows cannot be snipped.*"My Game"/
    )
    expect(fake.shown).toBe(0)
  })

  it('snips the primary display by default', async () => {
    fake.grabs = [frame()]
    const result = await snipScreen({ target: { kind: 'display' } })
    expect(fake.calls[0]).toBe('start screen:1:0')
    expect(result.source.name).toBe('display 1 (1920x1080, primary)')
  })
})

describe('screen snip capture', () => {
  it('takes a burst at the interval and releases the stream and window after', async () => {
    fake.grabs = [frame(), frame(), frame()]
    const result = await snipScreen({ target: { kind: 'window', title: 'My Game' }, frames: 3, intervalMs: 60 })
    expect(result.frames).toHaveLength(3)
    expect(result.frames[0]!.atMs).toBe(0)
    expect(result.frames[1]!.atMs).toBeGreaterThanOrEqual(55)
    expect(result.frames[2]!.atMs).toBeGreaterThanOrEqual(115)
    expect(result.frames[0]!.jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    expect(result.full).toEqual({ width: 1280, height: 720 })
    expect(result.native).toEqual({ width: 1920, height: 1080 })
    expect(fake.calls.filter((c) => c.startsWith('grab'))).toHaveLength(3)
    expect(fake.calls.at(-1)).toBe('stop')
    expect(fake.shown).toBe(1)
    expect(fake.hidden).toBe(1)
  })

  it('sends a region in snip-space and a larger edge for it', async () => {
    fake.grabs = [frame({ region: { x: 10, y: 20, width: 300, height: 200 }, width: 450, height: 300 })]
    const result = await snipScreen({
      target: { kind: 'window', title: 'My Game' },
      region: { x: 10, y: 20, width: 300, height: 200 }
    })
    const grab = JSON.parse(fake.calls.find((c) => c.startsWith('grab'))!.slice(5)) as Record<string, unknown>
    expect(grab).toMatchObject({ fullEdge: 1280, outEdge: 1568, region: { x: 10, y: 20, width: 300, height: 200 } })
    expect(result.region).toEqual({ x: 10, y: 20, width: 300, height: 200 })
  })

  it('says where the snip is when a region misses it', async () => {
    fake.grabs = [{ error: 'outside', fullWidth: 1280, fullHeight: 720 }]
    await expect(
      snipScreen({ target: { kind: 'window', title: 'My Game' }, region: { x: 5000, y: 0, width: 10, height: 10 } })
    ).rejects.toThrow('region lies outside the 1280x720 snip')
    expect(fake.calls.at(-1)).toBe('stop')
    expect(fake.hidden).toBe(1)
  })

  it('keeps the frames it has when the window closes mid-burst', async () => {
    fake.grabs = [frame(), { error: 'ended' }]
    const result = await snipScreen({ target: { kind: 'window', title: 'My Game' }, frames: 4, intervalMs: 50 })
    expect(result.frames).toHaveLength(1)
  })

  // The failure wording depends on the host OS, so each case pins it.
  async function onPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
    const prev = process.platform
    Object.defineProperty(process, 'platform', { value: platform })
    try {
      return await run()
    } finally {
      Object.defineProperty(process, 'platform', { value: prev })
    }
  }

  it('fails with the reason when the stream will not start, and still cleans up', async () => {
    fake.start = { error: 'NotReadableError: Could not start video source' }
    await onPlatform('win32', () =>
      expect(snipScreen({ target: { kind: 'window', title: 'My Game' } })).rejects.toThrow(
        /could not be captured/
      )
    )
    expect(fake.calls.at(-1)).toBe('stop')
    expect(fake.hidden).toBe(1)
  })

  it('points macOS at the Screen Recording permission when the stream is refused', async () => {
    fake.start = { error: 'NotReadableError: Could not start video source' }
    await onPlatform('darwin', () =>
      expect(snipScreen({ target: { kind: 'window', title: 'My Game' } })).rejects.toThrow(
        /Privacy & Security > Screen Recording/
      )
    )
    expect(fake.calls.at(-1)).toBe('stop')
  })

  it('stops between frames when the run is cancelled', async () => {
    fake.grabs = [frame(), frame(), frame()]
    const controller = new AbortController()
    const pending = snipScreen({
      target: { kind: 'window', title: 'My Game' },
      frames: 3,
      intervalMs: 1000,
      signal: controller.signal
    })
    setTimeout(() => controller.abort(), 30)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(fake.calls.filter((c) => c.startsWith('grab'))).toHaveLength(1)
    expect(fake.calls.at(-1)).toBe('stop')
  })
})
