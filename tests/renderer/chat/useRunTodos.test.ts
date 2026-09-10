/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useRunTodos } from '@renderer/features/chat/hooks/useRunTodos'

describe('useRunTodos poll cadence', () => {
  const readRunArtifact = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    readRunArtifact.mockReset()
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: { readRunArtifact }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses 2s polls while running before todos exist', async () => {
    readRunArtifact.mockResolvedValue({
      ok: true,
      data: { name: 'todos.json', exists: false, content: null }
    })
    renderHook(() =>
      useRunTodos({ workspacePath: '/ws', runId: 'run-1', running: true, active: true })
    )
    await act(async () => {
      await Promise.resolve()
    })
    const afterMount = readRunArtifact.mock.calls.length
    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
    })
    expect(readRunArtifact.mock.calls.length).toBe(afterMount)
    await act(async () => {
      vi.advanceTimersByTime(1500)
      await Promise.resolve()
    })
    expect(readRunArtifact.mock.calls.length).toBeGreaterThan(afterMount)
  })

  it('uses 500ms polls while running once todos are visible', async () => {
    readRunArtifact.mockResolvedValue({
      ok: true,
      data: {
        name: 'todos.json',
        exists: true,
        content: JSON.stringify({
          todos: [{ id: '1', content: 'Ship', status: 'in_progress' }]
        })
      }
    })
    renderHook(() =>
      useRunTodos({ workspacePath: '/ws', runId: 'run-1', running: true, active: true })
    )
    await act(async () => {
      await Promise.resolve()
    })
    const afterMount = readRunArtifact.mock.calls.length
    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
    })
    expect(readRunArtifact.mock.calls.length).toBeGreaterThan(afterMount)
  })

  it('does not poll when inactive', async () => {
    readRunArtifact.mockResolvedValue({
      ok: true,
      data: { name: 'todos.json', exists: false, content: null }
    })
    renderHook(() =>
      useRunTodos({ workspacePath: '/ws', runId: 'run-1', running: true, active: false })
    )
    await act(async () => {
      await Promise.resolve()
    })
    const afterMount = readRunArtifact.mock.calls.length
    await act(async () => {
      vi.advanceTimersByTime(4000)
      await Promise.resolve()
    })
    expect(readRunArtifact.mock.calls.length).toBe(afterMount)
  })

  it('starts no interval without a run id (dock mounted, no run)', async () => {
    // Audit L-12: a mounted dock must not tick while there is no run.
    readRunArtifact.mockResolvedValue({
      ok: true,
      data: { name: 'todos.json', exists: false, content: null }
    })
    renderHook(() =>
      useRunTodos({ workspacePath: '/ws', runId: null, running: false, active: true })
    )
    await act(async () => {
      await Promise.resolve()
    })
    // Mount load only — no runId means the load itself is a no-op too.
    expect(readRunArtifact.mock.calls.length).toBe(0)
    await act(async () => {
      vi.advanceTimersByTime(6000)
      await Promise.resolve()
    })
    expect(readRunArtifact.mock.calls.length).toBe(0)
  })

  it('stops the 2s fallback poll once the run ends (idle run, mounted dock)', async () => {
    // Audit L-12 residual: previously the 2s poll kept ticking while a dock
    // was mounted with a terminal run. todos.json only changes while the
    // agent loop is live; the terminal refetch covers the final state.
    readRunArtifact.mockResolvedValue({
      ok: true,
      data: { name: 'todos.json', exists: false, content: null }
    })
    const { rerender } = renderHook(
      (props: { running: boolean }) =>
        useRunTodos({ workspacePath: '/ws', runId: 'run-1', running: props.running, active: true }),
      { initialProps: { running: true } }
    )
    await act(async () => {
      await Promise.resolve()
    })
    const afterMount = readRunArtifact.mock.calls.length
    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
    })
    // While running: 2s fallback polls fire before todos exist.
    expect(readRunArtifact.mock.calls.length).toBeGreaterThan(afterMount)

    rerender({ running: false })
    await act(async () => {
      await Promise.resolve()
    })
    const afterStop = readRunArtifact.mock.calls.length
    // One terminal refetch on the running→stopped transition...
    expect(afterStop).toBeGreaterThan(afterMount)
    await act(async () => {
      vi.advanceTimersByTime(6000)
      await Promise.resolve()
    })
    // ...then the interval is gone: no further polls.
    expect(readRunArtifact.mock.calls.length).toBe(afterStop)
  })
})
