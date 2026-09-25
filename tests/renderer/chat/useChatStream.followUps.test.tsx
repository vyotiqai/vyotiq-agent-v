/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useChatStream } from './helpers/useChatStream'
import { createChatStreamController } from '@renderer/lib/hooks/createChatStreamController'
import { buildTranscriptRows } from '@renderer/features/chat/utils/transcriptRows'
import type { AgentEvent } from '@shared/ipc'

type Handler = (event: AgentEvent) => void

describe('useChatStream', () => {
  let handler: Handler | null = null
  const chatStart = vi.fn()
  const chatCancel = vi.fn()
  const chatFollowUp = vi.fn()
  const chatFollowUpRemove = vi.fn()
  const chatFollowUpUpdate = vi.fn()

  beforeEach(() => {
    handler = null
    chatStart.mockReset()
    chatCancel.mockReset()
    chatFollowUp.mockReset()
    chatFollowUpRemove.mockReset()
    chatFollowUpUpdate.mockReset()
    chatStart.mockResolvedValue({ ok: true, data: { runId: 'run-1', invokeId: 1 } })
    chatCancel.mockResolvedValue({ ok: true, data: true })
    chatFollowUp.mockResolvedValue({
      ok: true,
      data: { id: 'fu-1', position: 1, queueLength: 1 }
    })
    chatFollowUpRemove.mockResolvedValue({ ok: true, data: { removed: true, queueLength: 0 } })
    chatFollowUpUpdate.mockResolvedValue({ ok: true, data: { preview: 'updated', queueLength: 1 } })

    // @ts-expect-error test bridge
    window.vyotiq = {
      chatStart,
      chatCancel,
      chatFollowUp,
      chatFollowUpRemove,
      chatFollowUpUpdate,
      onChatEvent: (h: Handler) => {
        handler = h
        return () => {
          handler = null
        }
      }
    }
  })

  it('preserves attachments when editing a queued follow-up', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('start')
    })
    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running', invokeId: 1 })
    })

    await act(async () => {
      await result.current.send('see this', ['data:image/png;base64,abc'])
    })

    const followUpId = result.current.pendingFollowUps[0]?.id
    expect(followUpId).toBeTruthy()

    chatFollowUpUpdate.mockClear()
    await act(async () => {
      await result.current.editFollowUp?.(followUpId!, 'see that')
    })

    expect(chatFollowUpUpdate).toHaveBeenCalledWith({
      runId: 'run-1',
      id: followUpId,
      message: expect.objectContaining({
        role: 'user',
        content: [
          { type: 'text', text: 'see that' },
          { type: 'image_url', url: 'data:image/png;base64,abc' }
        ]
      })
    })
  })

  it('a steered instruction is queued and then sent now, as the row\'s Send now does', async () => {
    const chatFollowUpPromote = vi.fn(async () => ({ ok: true as const, data: { promoted: true } }))
    ;(window.vyotiq as unknown as { chatFollowUpPromote: typeof chatFollowUpPromote }).chatFollowUpPromote = chatFollowUpPromote
    const { result } = renderHook(() => useChatStream('/ws'))
    await act(async () => {
      await result.current.send('start')
    })
    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running', invokeId: 1 })
    })
    await act(async () => {
      await result.current.send('use the other API', undefined, undefined, { steer: true })
    })
    expect(chatFollowUp).toHaveBeenCalledTimes(1)
    expect(chatFollowUpPromote).toHaveBeenCalledWith({ runId: 'run-1', id: 'fu-1' })

    // Without steer it only queues.
    chatFollowUpPromote.mockClear()
    await act(async () => {
      await result.current.send('and then the docs')
    })
    expect(chatFollowUpPromote).not.toHaveBeenCalled()
  })

  it('surfaces runNotice when queued follow-ups are dropped', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('start')
    })
    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running', invokeId: 1 })
      await result.current.send('queued steer')
    })

    const followUpId = result.current.pendingFollowUps[0]?.id
    expect(followUpId).toBeTruthy()

    await act(async () => {
      handler?.({
        type: 'follow_up_dropped',
        runId: 'run-1',
        invokeId: 1,
        ids: [followUpId!],
        reason: 'network_interrupted'
      })
    })

    expect(result.current.pendingFollowUps).toEqual([])
    expect(result.current.runNotice).toBe(
      'Queued follow-up was dropped because the run ended.'
    )
  })

  it('keeps queued follow-ups visible on done until follow_up_applied arrives', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('start')
    })
    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running', invokeId: 1 })
      await result.current.send('queued steer')
    })

    const followUpId = result.current.pendingFollowUps[0]?.id
    expect(followUpId).toBeTruthy()

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'done', invokeId: 1 })
    })

    expect(result.current.running).toBe(false)
    expect(result.current.pendingFollowUps).toHaveLength(1)

    await act(async () => {
      handler?.({
        type: 'follow_up_applied',
        runId: 'run-1',
        invokeId: 1,
        ids: [followUpId!],
        messages: [{ role: 'user', content: 'queued steer' }]
      })
    })

    expect(result.current.pendingFollowUps).toEqual([])
    expect(
      result.current.messages.some((m) => m.role === 'user' && m.content === 'queued steer')
    ).toBe(true)
  })
})
