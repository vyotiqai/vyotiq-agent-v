/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  resetOfflineFlushLocksForTests,
  useOfflineSendQueue
} from '@renderer/lib/hooks/useOfflineSendQueue'
import {
  offlineQueueLength,
  resetOfflineQueueMemoryForTests
} from '@renderer/lib/hooks/offlineQueueStore'

const useNetworkStatus = vi.hoisted(() => vi.fn())

vi.mock('@renderer/lib/hooks/useNetworkStatus', () => ({
  useNetworkStatus
}))

const WORKSPACE = '/tmp/vyotiq-offline-hook'

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
  resetOfflineFlushLocksForTests()
  resetOfflineQueueMemoryForTests()
  useNetworkStatus.mockReturnValue({ online: true, offlineHint: null })
})

afterEach(() => {
  localStorage.clear()
  vi.useRealTimers()
  vi.clearAllMocks()
  resetOfflineFlushLocksForTests()
  resetOfflineQueueMemoryForTests()
})

describe('useOfflineSendQueue', () => {
  it('queues sends while offline and shows queued hint', async () => {
    useNetworkStatus.mockReturnValue({
      online: false,
      offlineHint: 'You appear to be offline. Agent runs will retry when connectivity returns.'
    })
    const onSend = vi.fn().mockResolvedValue(true)

    const { result } = renderHook(() => useOfflineSendQueue(WORKSPACE, onSend))

    await act(async () => {
      const queued = await result.current.sendWithOfflineQueue('hello offline')
      expect(queued).toBe(true)
    })

    expect(onSend).not.toHaveBeenCalled()
    expect(offlineQueueLength(WORKSPACE)).toBe(1)
    expect(result.current.offlineHint).toBe('1 message queued — will send when online')
  })

  it('retains an offline send in memory when persistence fails', async () => {
    useNetworkStatus.mockReturnValue({ online: false, offlineHint: 'offline' })
    const onSend = vi.fn().mockResolvedValue(true)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError')
    })

    const { result } = renderHook(() => useOfflineSendQueue(WORKSPACE, onSend))

    await act(async () => {
      expect(await result.current.sendWithOfflineQueue('retain this draft')).toBe(true)
    })

    expect(offlineQueueLength(WORKSPACE)).toBe(1)
    expect(onSend).not.toHaveBeenCalled()
  })

  it('flushes FIFO after online settle delay', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    useNetworkStatus.mockReturnValue({ online: false, offlineHint: 'offline' })

    const { result, rerender } = renderHook(() => useOfflineSendQueue(WORKSPACE, onSend))

    await act(async () => {
      await result.current.sendWithOfflineQueue('first')
      await result.current.sendWithOfflineQueue('second')
    })
    expect(offlineQueueLength(WORKSPACE)).toBe(2)

    useNetworkStatus.mockReturnValue({ online: true, offlineHint: null })
    rerender()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(onSend).toHaveBeenCalledTimes(2)
    expect(onSend.mock.calls[0]?.[0]?.text).toBe('first')
    expect(onSend.mock.calls[1]?.[0]?.text).toBe('second')
    expect(offlineQueueLength(WORKSPACE)).toBe(0)
    expect(result.current.offlineHint).toBeNull()
  })

  it('stops flushing when onSend returns false', async () => {
    const onSend = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true)

    localStorage.setItem(
      `vyotiq.offlineQueue.${encodeURIComponent(WORKSPACE)}`,
      JSON.stringify([
        { id: '1', text: 'stuck', queuedAt: new Date().toISOString() },
        { id: '2', text: 'later', queuedAt: new Date().toISOString() }
      ])
    )

    const { result } = renderHook(() => useOfflineSendQueue(WORKSPACE, onSend))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(onSend).toHaveBeenCalledTimes(1)
    expect(offlineQueueLength(WORKSPACE)).toBe(2)
    expect(result.current.offlineHint).toContain('2 messages queued')
  })

  it('clearOfflineQueueForWorkspace clears hint and storage', async () => {
    useNetworkStatus.mockReturnValue({ online: false, offlineHint: 'offline' })
    const onSend = vi.fn().mockResolvedValue(true)
    const { result } = renderHook(() => useOfflineSendQueue(WORKSPACE, onSend))

    await act(async () => {
      await result.current.sendWithOfflineQueue('queued')
    })
    expect(offlineQueueLength(WORKSPACE)).toBe(1)

    await act(async () => {
      result.current.clearOfflineQueueForWorkspace()
    })

    expect(offlineQueueLength(WORKSPACE)).toBe(0)
    expect(result.current.offlineHint).toBe('offline')
  })

  it('uses per-call deliver override when online', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    const deliver = vi.fn().mockResolvedValue(true)
    const { result } = renderHook(() => useOfflineSendQueue(WORKSPACE, onSend))

    await act(async () => {
      await result.current.sendWithOfflineQueue('pane send', undefined, undefined, undefined, deliver)
    })

    expect(deliver).toHaveBeenCalledWith('pane send', undefined, undefined, undefined)
    expect(onSend).not.toHaveBeenCalled()
  })

  it('does not double-flush when two hooks share a workspace', async () => {
    const onSendA = vi.fn().mockResolvedValue(true)
    const onSendB = vi.fn().mockResolvedValue(true)

    localStorage.setItem(
      `vyotiq.offlineQueue.${encodeURIComponent(WORKSPACE)}`,
      JSON.stringify([{ id: '1', text: 'once', queuedAt: new Date().toISOString() }])
    )

    renderHook(() => useOfflineSendQueue(WORKSPACE, onSendA))
    renderHook(() => useOfflineSendQueue(WORKSPACE, onSendB))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    const totalCalls = onSendA.mock.calls.length + onSendB.mock.calls.length
    expect(totalCalls).toBe(1)
    expect(offlineQueueLength(WORKSPACE)).toBe(0)
  })

  it('preserves runId binding when enqueueing offline', async () => {
    useNetworkStatus.mockReturnValue({ online: false, offlineHint: 'offline' })
    const onFlush = vi.fn().mockResolvedValue(true)
    const { result } = renderHook(() => useOfflineSendQueue(WORKSPACE, onFlush))

    await act(async () => {
      await result.current.sendWithOfflineQueue(
        'bound',
        undefined,
        undefined,
        undefined,
        undefined,
        { runId: 'run-42' }
      )
    })

    const raw = localStorage.getItem(`vyotiq.offlineQueue.${encodeURIComponent(WORKSPACE)}`)
    const parsed = JSON.parse(raw!) as Array<{ text: string; runId?: string | null }>
    expect(parsed[0]?.text).toBe('bound')
    expect(parsed[0]?.runId).toBe('run-42')
  })

  it('persists paneId and workspacePath with the queued send', async () => {
    useNetworkStatus.mockReturnValue({ online: false, offlineHint: 'offline' })
    const onFlush = vi.fn().mockResolvedValue(true)
    const { result } = renderHook(() => useOfflineSendQueue(WORKSPACE, onFlush))

    await act(async () => {
      await result.current.sendWithOfflineQueue(
        'pane-draft',
        undefined,
        undefined,
        undefined,
        undefined,
        { runId: null, paneId: 'pane-1', workspacePath: WORKSPACE }
      )
    })

    const raw = localStorage.getItem(`vyotiq.offlineQueue.${encodeURIComponent(WORKSPACE)}`)
    const parsed = JSON.parse(raw!) as Array<{
      text: string
      runId?: string | null
      paneId?: string
      workspacePath?: string
    }>
    expect(parsed[0]?.text).toBe('pane-draft')
    expect(parsed[0]?.runId).toBeNull()
    expect(parsed[0]?.paneId).toBe('pane-1')
    expect(parsed[0]?.workspacePath).toBe(WORKSPACE)
  })
})

describe('onboarding before offline enqueue', () => {
  it('does not enqueue when onboarding gate stashes before offline wrapper runs', async () => {
    useNetworkStatus.mockReturnValue({ online: false, offlineHint: 'offline' })
    const deliver = vi.fn().mockResolvedValue(true)
    const { result } = renderHook(() => useOfflineSendQueue(WORKSPACE, deliver))

    let onboardingDone = false
    const pending: {
      text: string
      deliver: typeof result.current.sendWithOfflineQueue
    } | null = { text: '', deliver: result.current.sendWithOfflineQueue }

    const gateThenOffline = async (text: string) => {
      if (!onboardingDone) {
        pending.text = text
        pending.deliver = (t, i, f, e) => result.current.sendWithOfflineQueue(t, i, f, e)
        return false
      }
      return result.current.sendWithOfflineQueue(text)
    }

    await act(async () => {
      const ok = await gateThenOffline('blocked offline')
      expect(ok).toBe(false)
    })

    expect(offlineQueueLength(WORKSPACE)).toBe(0)
    expect(deliver).not.toHaveBeenCalled()

    onboardingDone = true
    await act(async () => {
      await pending!.deliver(pending!.text)
    })

    expect(offlineQueueLength(WORKSPACE)).toBe(1)
    expect(deliver).not.toHaveBeenCalled()
  })
})
