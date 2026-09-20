// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'

import { useRunFeedback } from '@renderer/features/chat/hooks/useRunFeedback'
import type { RunFeedbackRating } from '@shared/ipc'

const { pushToastMock } = vi.hoisted(() => ({ pushToastMock: vi.fn() }))

vi.mock('@renderer/lib/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/lib/ui')>()),
  pushToast: pushToastMock
}))

type Result = ReturnType<typeof useRunFeedback>

/** Renders the hook and exposes its latest return value. */
function mountHook(args: {
  workspacePath?: string | null
  runId?: string | null
  enabled?: boolean
}): { current: () => Result } {
  let latest: Result
  function Probe(): null {
    latest = useRunFeedback(
      args.workspacePath === undefined ? '/ws' : args.workspacePath,
      args.runId === undefined ? 'run-1' : args.runId,
      args.enabled ?? true
    )
    return null
  }
  render(<Probe />)
  return { current: () => latest }
}

function setBridge(over: Record<string, unknown>): void {
  Object.defineProperty(window, 'vyotiq', {
    configurable: true,
    writable: true,
    value: {
      runFeedbackGet: vi.fn().mockResolvedValue({ ok: true, data: { entry: null } }),
      runFeedbackSet: vi.fn().mockResolvedValue({ ok: true, data: { entry: {} } }),
      ...over
    }
  })
}

beforeEach(() => {
  setBridge({})
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('useRunFeedback', () => {
  it('loads an existing verdict once for the run', async () => {
    const runFeedbackGet = vi
      .fn()
      .mockResolvedValue({ ok: true, data: { entry: { rating: 'down' } } })
    setBridge({ runFeedbackGet })

    const hook = mountHook({})
    await waitFor(() => expect(hook.current()?.value).toBe('down'))
    expect(runFeedbackGet).toHaveBeenCalledTimes(1)
    expect(runFeedbackGet).toHaveBeenCalledWith({ workspacePath: '/ws', runId: 'run-1' })
  })

  it('does not touch the bridge while the run is still going', () => {
    const runFeedbackGet = vi.fn()
    setBridge({ runFeedbackGet })

    const hook = mountHook({ enabled: false })

    expect(runFeedbackGet).not.toHaveBeenCalled()
    // No control is offered, so MessageList renders no thumbs at all.
    expect(hook.current()).toBeUndefined()
  })

  it('does not touch the bridge when there is no run', () => {
    const runFeedbackGet = vi.fn()
    setBridge({ runFeedbackGet })

    const hook = mountHook({ runId: null })

    expect(runFeedbackGet).not.toHaveBeenCalled()
    expect(hook.current()).toBeUndefined()
  })

  it('applies the verdict optimistically', async () => {
    let settle: (v: unknown) => void = () => undefined
    const runFeedbackSet = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        settle = resolve
      })
    )
    setBridge({ runFeedbackSet })

    const hook = mountHook({})
    await waitFor(() => expect(hook.current()).toBeTruthy())

    act(() => hook.current()?.onRate('up'))
    // Shown before the write lands — the point of the optimistic path.
    expect(hook.current()?.value).toBe('up')

    await act(async () => {
      settle({ ok: true, data: { entry: {} } })
    })
    expect(hook.current()?.value).toBe('up')
    expect(runFeedbackSet).toHaveBeenCalledWith({
      workspacePath: '/ws',
      runId: 'run-1',
      rating: 'up'
    })
  })

  it('rolls back and reports when the write is refused', async () => {
    const runFeedbackGet = vi
      .fn()
      .mockResolvedValue({ ok: true, data: { entry: { rating: 'up' } } })
    setBridge({
      runFeedbackGet,
      runFeedbackSet: vi.fn().mockResolvedValue({ ok: false, error: 'workspace closed' })
    })

    const hook = mountHook({})
    await waitFor(() => expect(hook.current()?.value).toBe('up'))

    await act(async () => {
      hook.current()?.onRate('down')
    })

    // Back to what the store actually holds, not the rejected verdict.
    expect(hook.current()?.value).toBe('up')
    expect(pushToastMock).toHaveBeenCalledWith(
      'Could not save feedback: workspace closed',
      'error'
    )
  })

  it('rolls back and reports when the write throws', async () => {
    setBridge({ runFeedbackSet: vi.fn().mockRejectedValue(new Error('ipc gone')) })

    const hook = mountHook({})
    await waitFor(() => expect(hook.current()).toBeTruthy())
    expect(hook.current()?.value).toBeNull()

    await act(async () => {
      hook.current()?.onRate('down' as RunFeedbackRating)
    })

    expect(hook.current()?.value).toBeNull()
    expect(pushToastMock).toHaveBeenCalledWith('Could not save feedback', 'error')
  })

  it('stays quiet when the read fails — an unreadable verdict is just unrated', async () => {
    setBridge({ runFeedbackGet: vi.fn().mockRejectedValue(new Error('unreadable')) })

    const hook = mountHook({})
    await waitFor(() => expect(hook.current()).toBeTruthy())

    expect(hook.current()?.value).toBeNull()
    expect(pushToastMock).not.toHaveBeenCalled()
  })
})
