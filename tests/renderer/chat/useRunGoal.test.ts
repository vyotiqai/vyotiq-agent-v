/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useRunGoal } from '@renderer/features/chat/hooks/useRunGoal'

const activeGoal = {
  objective: 'Make CI green',
  status: 'active' as const,
  createdAt: 't',
  updatedAt: 't'
}

describe('useRunGoal poll cadence', () => {
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

  it('uses 2s polls while running before a goal exists', async () => {
    readRunArtifact.mockResolvedValue({
      ok: true,
      data: { name: 'goal.json', exists: false, content: null }
    })
    renderHook(() =>
      useRunGoal({ workspacePath: '/ws', runId: 'run-1', running: true, active: true })
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

  it('uses 500ms polls while running once a goal is visible', async () => {
    readRunArtifact.mockImplementation(async (payload: { name: string }) => {
      if (payload.name === 'goal.json') {
        return { ok: true, data: { name: 'goal.json', exists: true, content: JSON.stringify(activeGoal) } }
      }
      return { ok: true, data: { name: payload.name, exists: false, content: null } }
    })
    renderHook(() =>
      useRunGoal({ workspacePath: '/ws', runId: 'run-1', running: true, active: true })
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

  it('does not poll once the run is idle (L-12 parity)', async () => {
    readRunArtifact.mockResolvedValue({
      ok: true,
      data: { name: 'goal.json', exists: false, content: null }
    })
    renderHook(() =>
      useRunGoal({ workspacePath: '/ws', runId: 'run-1', running: false, active: true })
    )
    await act(async () => {
      await Promise.resolve()
    })
    const afterMount = readRunArtifact.mock.calls.length
    await act(async () => {
      vi.advanceTimersByTime(10_000)
      await Promise.resolve()
    })
    expect(readRunArtifact.mock.calls.length).toBe(afterMount)
  })
})
