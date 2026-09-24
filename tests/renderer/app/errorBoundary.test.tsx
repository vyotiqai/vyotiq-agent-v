/**
 * @vitest-environment jsdom
 */
import type { JSX } from 'react'
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { ErrorBoundary } from '@renderer/lib/ErrorBoundary'
import {
  resetStaleChunkReloadFlagForTests,
  takeStaleChunkReload,
  STALE_CHUNK_RELOAD_DELAYS_MS
} from '@renderer/lib/staleChunk'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function Boom(): never {
  throw new Error('boundary-test-crash')
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    resetStaleChunkReloadFlagForTests()
  })

  it('renders recovery UI on child throw', () => {
    // @ts-expect-error test bridge
    window.vyotiq = {
      openLogsDir: vi.fn(async () => ({ ok: true as const, data: true as const }))
    }

    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    )
    spy.mockRestore()

    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText(/Something went wrong/i)).toBeTruthy()
    expect(screen.queryByText(/boundary-test-crash/i)).toBeNull()
    expect(screen.getByRole('button', { name: /Try again/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Reload/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Open logs/i })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Open logs/i }))
    expect(window.vyotiq.openLogsDir).toHaveBeenCalled()
  })

  it('a panel that fails says so in its own space, without the error text', () => {
    // @ts-expect-error test bridge
    window.vyotiq = {
      openLogsDir: vi.fn(async () => ({ ok: true as const, data: true as const }))
    }

    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(
      <div>
        <ErrorBoundary panel="Changes">
          <Boom />
        </ErrorBoundary>
        <ErrorBoundary panel="Files">
          <span>files still here</span>
        </ErrorBoundary>
      </div>
    )
    spy.mockRestore()

    const alert = screen.getByRole('alert')
    expect(alert.getAttribute('data-panel-error')).toBe('Changes')
    expect(screen.getByRole('heading', { name: 'The Changes panel couldn’t render' })).toBeTruthy()
    expect(alert.textContent).toContain(
      'The rest of the window is fine. The error is in the log, with the component it came from.'
    )
    expect(screen.queryByText(/boundary-test-crash/i)).toBeNull()
    expect(screen.getByText('files still here')).toBeTruthy()
    // The window is fine, so there is nothing to reload.
    expect(screen.queryByRole('button', { name: /Reload/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Open logs/i }))
    expect(window.vyotiq.openLogsDir).toHaveBeenCalled()
  })

  it('Try again renders the panel afresh', () => {
    let fail = true
    function Flaky(): JSX.Element {
      if (fail) throw new Error('boundary-test-crash')
      return <span>rendered</span>
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(
      <ErrorBoundary panel="Plan">
        <Flaky />
      </ErrorBoundary>
    )
    spy.mockRestore()
    expect(screen.getByRole('alert')).toBeTruthy()
    fail = false
    fireEvent.click(screen.getByRole('button', { name: /Try again/i }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('rendered')).toBeTruthy()
  })

  it('clears a caught error when resetKey changes', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { rerender } = render(
      <ErrorBoundary resetKey="a">
        <Boom />
      </ErrorBoundary>
    )
    spy.mockRestore()

    expect(screen.getByRole('alert')).toBeTruthy()

    rerender(
      <ErrorBoundary resetKey="b">
        <span>recovered</span>
      </ErrorBoundary>
    )

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('recovered')).toBeTruthy()
  })

  it('reloads the window when a child throws a stale-chunk failure', () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const reload = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { reload },
      configurable: true,
      writable: true
    })
    function StaleBoom(): never {
      throw new TypeError(
        'Failed to fetch dynamically imported module: file:///C:/app/out/renderer/assets/FilesPanel-B-tydSMi.js'
      )
    }
    render(
      <ErrorBoundary>
        <StaleBoom />
      </ErrorBoundary>
    )
    spy.mockRestore()

    // The reload waits out the rest of the build's write burst, so the crash UI
    // must not flash in the meantime — a rebuild is not a crash.
    expect(reload).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('status').textContent).toMatch(/reloading the window/i)

    vi.advanceTimersByTime(STALE_CHUNK_RELOAD_DELAYS_MS[0])
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('shows recovery UI once reloads stop clearing the failure (loop guard)', () => {
    vi.useFakeTimers()
    // Simulate the budget already spent by reloads earlier in this window.
    for (let attempt = 1; attempt <= STALE_CHUNK_RELOAD_DELAYS_MS.length; attempt += 1) {
      expect(takeStaleChunkReload()).toBe(attempt)
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const reload = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { reload },
      configurable: true,
      writable: true
    })
    function StaleBoom(): never {
      throw new TypeError('Failed to fetch dynamically imported module: x.js')
    }
    render(
      <ErrorBoundary>
        <StaleBoom />
      </ErrorBoundary>
    )
    spy.mockRestore()

    vi.runAllTimers()
    expect(reload).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toBeTruthy()
  })
})
