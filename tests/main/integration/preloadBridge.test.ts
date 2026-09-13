import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const captured: { api: Record<string, (...args: unknown[]) => unknown> | undefined } = {
    api: undefined
  }
  const expose = vi.fn((_name: string, api: unknown) => {
    captured.api = api as Record<string, (...args: unknown[]) => unknown>
  })
  const invoke = vi.fn(() => Promise.resolve(undefined))
  const send = vi.fn()
  const on = vi.fn()
  const removeListener = vi.fn()
  const writeText = vi.fn()
  return { captured, expose, invoke, send, on, removeListener, writeText }
})

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: unknown) => h.expose(name, api) },
  ipcRenderer: { invoke: h.invoke, send: h.send, on: h.on, removeListener: h.removeListener },
  clipboard: { writeText: h.writeText }
}))

// Side-effect import: the module calls contextBridge.exposeInMainWorld at load.
import '../../../src/preload/index'

describe('preload bridge', () => {
  it('exposes the vyotiq API on the main world', () => {
    expect(h.expose).toHaveBeenCalledTimes(1)
    expect(h.expose.mock.calls[0][0]).toBe('vyotiq')
    const api = h.captured.api
    expect(api).toBeDefined()
    expect(typeof api!.getSettings).toBe('function')
    expect(typeof api!.chatStart).toBe('function')
    expect(typeof api!.chatCancel).toBe('function')
    expect(typeof api!.writeClipboard).toBe('function')
  })

  it('routes getSettings through ipcRenderer.invoke', async () => {
    const api = h.captured.api!
    await api.getSettings()
    expect(h.invoke).toHaveBeenCalled()
    expect(typeof h.invoke.mock.calls[0][0]).toBe('string')
    expect((h.invoke.mock.calls[0][0] as string).toLowerCase()).toContain('settings:get')
  })

  it('routes chatCancel with the run id', async () => {
    const api = h.captured.api!
    await api.chatCancel('run-123')
    expect(h.invoke).toHaveBeenCalled()
    const [channel, payload] = h.invoke.mock.calls.at(-1) as [string, { runId: string }]
    expect(channel.toLowerCase()).toContain('chat:cancel')
    expect(payload.runId).toBe('run-123')
  })

  it('writes text to the clipboard', () => {
    const api = h.captured.api!
    const ok = (api.writeClipboard as (t: string) => boolean)('hello')
    expect(ok).toBe(true)
    expect(h.writeText).toHaveBeenCalledWith('hello')
  })
})
