import { EventEmitter } from 'events'
import { describe, expect, it, vi, type Mock } from 'vitest'
import type { WebContents } from 'electron'
import { startElementPick, type PickEndReason } from '@main/app/agentBrowserPick'
import type { BrowserPickedElement } from '@shared/ipc'

type Handler = (method: string, params: Record<string, unknown>) => unknown

/** A WebContents whose debugger answers the protocol calls a pick makes. */
function fakeContents(handler: Handler = () => ({})) {
  const dbg = new EventEmitter() as EventEmitter & {
    attach: Mock<(version?: string) => void>
    detach: Mock<() => void>
    isAttached: () => boolean
    sendCommand: ReturnType<typeof vi.fn>
  }
  let attached = false
  dbg.attach = vi.fn(() => {
    attached = true
  })
  dbg.detach = vi.fn(() => {
    attached = false
  })
  dbg.isAttached = () => attached
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  dbg.sendCommand = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, params })
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } }
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 }
    if (method === 'DOM.resolveNode') return { object: { objectId: `obj-${JSON.stringify(params)}` } }
    const answer = handler(method, params)
    return answer ?? {}
  })
  const wc = new EventEmitter() as EventEmitter & {
    debugger: typeof dbg
    isDestroyed: () => boolean
    getURL: () => string
  }
  wc.debugger = dbg
  wc.isDestroyed = () => false
  wc.getURL = () => 'https://example.test/pricing'
  return { wc, dbg, calls }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

const described = {
  selector: '#plans > button:nth-of-type(2)',
  tag: 'button',
  role: 'button',
  name: '',
  text: '  Sign\n  in  ',
  bounds: { x: 10.4, y: 20.6, width: 100, height: 32 },
  refIndex: 1
}

function start(handler?: Handler) {
  const fake = fakeContents(handler)
  const picks: BrowserPickedElement[] = []
  const ends: PickEndReason[] = []
  const session = startElementPick({
    wc: fake.wc as unknown as WebContents,
    refs: () => [
      { id: 'e1', selector: 'a' },
      { id: 'e2', selector: '#plans > button:nth-of-type(2)' }
    ],
    onPick: (el) => picks.push(el),
    onEnd: (reason) => ends.push(reason)
  })
  return { ...fake, picks, ends, session }
}

describe('startElementPick', () => {
  it('arms the inspect overlay through the protocol, attaching only when nothing else holds it', async () => {
    const { dbg, calls, session } = start()
    await session
    expect(dbg.attach).toHaveBeenCalledWith('1.3')
    expect(calls.map((c) => c.method)).toEqual([
      'DOM.enable',
      'DOM.getDocument',
      'Overlay.enable',
      'Overlay.setInspectMode'
    ])
    expect(calls[3]!.params.mode).toBe('searchForNode')
  })

  it('reads a clicked element in an isolated world and sends it clamped, with its snapshot ref', async () => {
    const { dbg, calls, picks, session } = start((method) => {
      if (method === 'Runtime.callFunctionOn') return { result: { value: described } }
      if (method === 'Accessibility.getPartialAXTree') {
        return { nodes: [{ role: { value: 'button' }, name: { value: 'Sign in' } }] }
      }
      return undefined
    })
    await session
    dbg.emit('message', {}, 'Overlay.inspectNodeRequested', { backendNodeId: 42 })
    await flush()
    const resolve = calls.find((c) => c.method === 'DOM.resolveNode')
    expect(resolve?.params).toMatchObject({ backendNodeId: 42, executionContextId: 7 })
    const call = calls.find((c) => c.method === 'Runtime.callFunctionOn')
    expect(call?.params.returnByValue).toBe(true)
    expect(picks).toEqual([
      {
        selector: '#plans > button:nth-of-type(2)',
        tag: 'button',
        role: 'button',
        name: 'Sign in',
        text: 'Sign in',
        url: 'https://example.test/pricing',
        bounds: { x: 10, y: 21, width: 100, height: 32 },
        ref: 'e2'
      }
    ])
  })

  it('drops a pick whose page data does not hold together', async () => {
    const { dbg, picks, session } = start((method) =>
      method === 'Runtime.callFunctionOn'
        ? { result: { value: { ...described, tag: 'x><script' } } }
        : undefined
    )
    await session
    dbg.emit('message', {}, 'Overlay.inspectNodeRequested', { backendNodeId: 1 })
    await flush()
    expect(picks).toEqual([])
  })

  it('walks the tree with the arrow keys and picks with Enter', async () => {
    const { wc, calls, picks, session } = start((method, params) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'focused' } }
      if (method === 'DOM.describeNode') {
        return { node: { backendNodeId: params.objectId === 'focused' ? 5 : 6, nodeType: 1 } }
      }
      if (method === 'Runtime.callFunctionOn') {
        return params.returnByValue ? { result: { value: described } } : { result: { objectId: 'parent' } }
      }
      return undefined
    })
    await session
    const key = (k: string) => {
      const event = { preventDefault: vi.fn() }
      wc.emit('before-input-event', event, { type: 'keyDown', key: k })
      return event
    }
    // The first key starts on the page's focused element.
    expect(key('ArrowUp').preventDefault).toHaveBeenCalled()
    await flush()
    expect(calls.filter((c) => c.method === 'Overlay.highlightNode').at(-1)?.params).toMatchObject({ backendNodeId: 5 })
    key('ArrowUp')
    await flush()
    const move = calls.find((c) => c.method === 'Runtime.callFunctionOn' && !c.params.returnByValue)
    expect(move?.params.arguments).toEqual([{ value: 'parent' }])
    expect(calls.filter((c) => c.method === 'Overlay.highlightNode').at(-1)?.params).toMatchObject({ backendNodeId: 6 })
    key('Enter')
    await flush()
    expect(picks).toHaveLength(1)
    expect(calls.filter((c) => c.method === 'DOM.resolveNode').at(-1)?.params).toMatchObject({ backendNodeId: 6 })
  })

  it('ends on Esc in the page, turns the overlay off and detaches what it attached', async () => {
    const { wc, dbg, calls, ends, session } = start()
    await session
    const event = { preventDefault: vi.fn() }
    wc.emit('before-input-event', event, { type: 'keyDown', key: 'Escape' })
    await flush()
    expect(event.preventDefault).toHaveBeenCalled()
    expect(ends).toEqual(['escape'])
    expect(calls.some((c) => c.method === 'Overlay.setInspectMode' && c.params.mode === 'none')).toBe(true)
    expect(dbg.detach).toHaveBeenCalled()
    // Ended is ended: further input is ignored.
    wc.emit('before-input-event', { preventDefault: vi.fn() }, { type: 'keyDown', key: 'Escape' })
    expect(ends).toEqual(['escape'])
  })

  it('ends on a navigation, and leaves a shared protocol session attached', async () => {
    const fake = fakeContents()
    fake.dbg.attach('1.3')
    fake.dbg.attach.mockClear()
    const ends: PickEndReason[] = []
    const session = await startElementPick({
      wc: fake.wc as unknown as WebContents,
      refs: () => [],
      onPick: () => undefined,
      onEnd: (reason) => ends.push(reason)
    })
    expect(fake.dbg.attach).not.toHaveBeenCalled()
    fake.wc.emit('did-navigate')
    await flush()
    expect(ends).toEqual(['navigated'])
    expect(session.active()).toBe(false)
    expect(fake.dbg.detach).not.toHaveBeenCalled()
  })
})
