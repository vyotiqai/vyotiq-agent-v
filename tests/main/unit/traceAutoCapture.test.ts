import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTraceAutoCapture, resetTraceAutoCaptureForTests } from '@main/perf/traceAutoCapture'
import type { TraceAutoCapture } from '@main/perf/traceAutoCapture'

function fakeContentTracing() {
  return {
    startRecording: vi.fn(async () => undefined),
    stopRecording: vi.fn(async (path?: string) => path ?? ''),
    getTraceBufferUsage: vi.fn(async () => ({ value: 4242, percentage: 42 }))
  }
}

type Listener = (...args: unknown[]) => void

function fakeApp() {
  const listeners = new Map<string, Listener[]>()
  return {
    app: {
      on: vi.fn((event: string, listener: Listener) => {
        const list = listeners.get(event) ?? []
        list.push(listener)
        listeners.set(event, list)
      }),
      getPath: vi.fn(() => 'C:/traces'),
      emit: (event: string, ...args: unknown[]) => {
        for (const listener of listeners.get(event) ?? []) listener(...args)
      },
      listenerCount: (event: string) => (listeners.get(event) ?? []).length
    },
    listeners
  }
}

function fakeProc() {
  const listeners = new Map<string, Listener[]>()
  return {
    proc: {
      on: vi.fn((event: string, listener: Listener) => {
        const list = listeners.get(event) ?? []
        list.push(listener)
        listeners.set(event, list)
      }),
      emit: (event: string, ...args: unknown[]) => {
        for (const listener of listeners.get(event) ?? []) listener(...args)
      },
      listenerCount: (event: string) => (listeners.get(event) ?? []).length
    },
    listeners
  }
}

async function drain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

describe('traceAutoCapture wiring', () => {
  it('init starts the ring buffer and registers all five triggers exactly once', async () => {
    const { app } = fakeApp()
    const { proc } = fakeProc()
    const auto: TraceAutoCapture = createTraceAutoCapture(fakeContentTracing(), app, proc)
    auto.init()
    await drain()
    expect(app.on).toHaveBeenCalledWith('render-process-gone', expect.any(Function))
    expect(app.on).toHaveBeenCalledWith('child-process-gone', expect.any(Function))
    expect(app.on).toHaveBeenCalledWith('browser-window-created', expect.any(Function))
    expect(proc.on).toHaveBeenCalledWith('uncaughtException', expect.any(Function))
    expect(proc.on).toHaveBeenCalledWith('unhandledRejection', expect.any(Function))
    // Second init() is a no-op (idempotent).
    auto.init()
    await drain()
    expect(proc.listenerCount('uncaughtException')).toBe(1)
  })

  it('renderer crash (non-clean) dumps with reason-stamped file and resumes', async () => {
    const ct = fakeContentTracing()
    const { app } = fakeApp()
    const { proc } = fakeProc()
    const auto = createTraceAutoCapture(ct, app, proc)
    auto.init()
    await drain()
    app.emit('render-process-gone', {}, {}, { reason: 'crashed' })
    await drain()
    expect(ct.stopRecording).toHaveBeenCalledTimes(1)
    expect(String(ct.stopRecording.mock.calls[0]?.[0])).toContain('trace-renderer-crash-')
    expect((await auto.capture.status()).recording).toBe(true)
  })

  it('renderer killed/clean-exit does NOT dump; child-process crash does', async () => {
    const ct = fakeContentTracing()
    const { app } = fakeApp()
    const { proc } = fakeProc()
    const auto = createTraceAutoCapture(ct, app, proc)
    auto.init()
    await drain()
    app.emit('render-process-gone', {}, {}, { reason: 'killed' })
    app.emit('render-process-gone', {}, {}, { reason: 'clean-exit' })
    await drain()
    expect(ct.stopRecording).not.toHaveBeenCalled()
    app.emit('child-process-gone', {}, { reason: 'crashed' })
    await drain()
    expect(ct.stopRecording).toHaveBeenCalledTimes(1)
    expect(String(ct.stopRecording.mock.calls[0]?.[0])).toContain('trace-child-process-crash-')
  })

  it('unresponsive (per-webContents via browser-window-created) dumps', async () => {
    const ct = fakeContentTracing()
    const { app } = fakeApp()
    const { proc } = fakeProc()
    const auto = createTraceAutoCapture(ct, app, proc)
    auto.init()
    await drain()
    const wcListeners: Listener[] = []
    app.emit('browser-window-created', {}, {
      webContents: {
        on: vi.fn((event: string, listener: Listener) => {
          if (event === 'unresponsive') wcListeners.push(listener)
        }),
        isDestroyed: () => false
      }
    })
    for (const listener of wcListeners) listener()
    await drain()
    expect(ct.stopRecording).toHaveBeenCalledTimes(1)
    expect(String(ct.stopRecording.mock.calls[0]?.[0])).toContain('trace-renderer-unresponsive-')
  })

  it('uncaughtException/unhandledRejection trigger dumps (registered first at boot)', async () => {
    const ct = fakeContentTracing()
    const { app } = fakeApp()
    const { proc } = fakeProc()
    const auto = createTraceAutoCapture(ct, app, proc)
    auto.init()
    await drain()
    proc.emit('uncaughtException', new Error('boom'))
    await drain() // let the dump complete (stamps the cool-down)
    proc.emit('unhandledRejection', new Error('reject'))
    await drain()
    // Cool-down dedupes the second trigger — exactly one auto dump ran.
    expect(ct.stopRecording).toHaveBeenCalledTimes(1)
    expect(String(ct.stopRecording.mock.calls[0]?.[0])).toContain('trace-uncaught-exception-')
    expect((await auto.capture.status()).recording).toBe(true)
  })
})

afterEach(() => {
  resetTraceAutoCaptureForTests()
})
