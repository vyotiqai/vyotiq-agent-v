/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { ErrorBoundary } from '@renderer/lib/ErrorBoundary'
import { resetStaleChunkReloadFlagForTests, takeStaleChunkReload } from '@renderer/lib/staleChunk'

afterEach(() => {
  cleanup()
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

  it('reloads the window once when a child throws a stale-chunk failure', () => {
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

    // Reload fires during componentDidCatch; the fallback state is already
    // committed (getDerivedStateFromError runs first) — the real window
    // navigates before it is ever seen.
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('shows recovery UI instead of reloading twice (loop guard)', () => {
    // Simulate the allowance already consumed earlier in this window session.
    expect(takeStaleChunkReload()).toBe(true)
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

    expect(reload).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toBeTruthy()
  })
})
