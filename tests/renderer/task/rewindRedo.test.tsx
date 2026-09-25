/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { RELOAD_RUN_EVENT, useRewindRedo } from '@renderer/features/task/rewindRedo'

afterEach(() => vi.restoreAllMocks())

describe('useRewindRedo', () => {
  it('offers Redo while main says it can, redoes, and asks App to read the record again', async () => {
    const rewindRedoStatus = vi.fn(async () => ({ ok: true as const, data: { available: true as const, files: 2, userMessageIndex: 2 } }))
    const redoRewind = vi.fn(async () => ({ ok: true as const, data: { messages: [] } }))
    window.vyotiq = { rewindRedoStatus, redoRewind } as unknown as typeof window.vyotiq
    const reloads: unknown[] = []
    const onReload = (e: Event): void => {
      reloads.push((e as CustomEvent).detail)
    }
    window.addEventListener(RELOAD_RUN_EVENT, onReload)

    const { result } = renderHook(() => useRewindRedo('/ws', 'run-1', 3, false))
    await waitFor(() => expect(result.current.redo).toEqual({ available: true, files: 2, userMessageIndex: 2 }))
    act(() => result.current.onRedo())
    await waitFor(() => expect(result.current.redo).toBeNull())
    expect(redoRewind).toHaveBeenCalledWith('/ws', 'run-1')
    expect(reloads).toEqual([{ workspacePath: '/ws', runId: 'run-1' }])
    window.removeEventListener(RELOAD_RUN_EVENT, onReload)
  })

  it('asks nothing while the task runs, and asks again when the record changes', async () => {
    const rewindRedoStatus = vi.fn(async () => ({ ok: true as const, data: { available: false as const, reason: 'none' as const } }))
    window.vyotiq = { rewindRedoStatus } as unknown as typeof window.vyotiq
    const { rerender } = renderHook(({ revision, live }) => useRewindRedo('/ws', 'run-1', revision, live), {
      initialProps: { revision: 1, live: true }
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(rewindRedoStatus).not.toHaveBeenCalled()
    rerender({ revision: 1, live: false })
    await waitFor(() => expect(rewindRedoStatus).toHaveBeenCalledTimes(1))
    rerender({ revision: 2, live: false })
    await waitFor(() => expect(rewindRedoStatus).toHaveBeenCalledTimes(2))
  })

  it('a Redo refused leaves it to main to say why, and checks again', async () => {
    const rewindRedoStatus = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: { available: true, files: 1, userMessageIndex: 0 } })
      .mockResolvedValue({ ok: true, data: { available: false, reason: 'files-changed' } })
    const redoRewind = vi.fn(async () => ({ ok: false as const, error: 'Something changed since the rewind, so Redo would overwrite it.' }))
    window.vyotiq = { rewindRedoStatus, redoRewind } as unknown as typeof window.vyotiq
    const { result } = renderHook(() => useRewindRedo('/ws', 'run-1', 1, false))
    await waitFor(() => expect(result.current.redo).not.toBeNull())
    act(() => result.current.onRedo())
    await waitFor(() => expect(result.current.redo).toBeNull())
    expect(rewindRedoStatus).toHaveBeenCalledTimes(2)
  })
})
