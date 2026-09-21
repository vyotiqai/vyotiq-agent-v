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

  it('clears approval only after respondToolApproval succeeds', async () => {
    const respondToolApproval = vi.fn().mockResolvedValue({ ok: true, data: true })
    window.vyotiq.respondToolApproval = respondToolApproval

    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('edit')
    })
    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      handler?.({
        type: 'tool_start',
        runId: 'run-1',
        toolCallId: 'c1',
        name: 'edit',
        summary: 'a.ts'
      })
      result.current.handleApprovalRequest({
        requestId: 'req-1',
        runId: 'run-1',
        toolCallId: 'c1',
        name: 'edit',
        summary: 'a.ts',
        mutating: true
      })
    })

    expect(
      result.current.items.some((i) => i.kind === 'tool' && i.approval?.requestId === 'req-1')
    ).toBe(true)

    await act(async () => {
      await result.current.respondToApproval('req-1', 'once')
    })

    expect(respondToolApproval).toHaveBeenCalledWith('req-1', 'once', 'run-1')
    expect(result.current.items.some((i) => i.kind === 'tool' && i.approval)).toBe(false)
  })

  it('keeps approval visible when respondToolApproval fails', async () => {
    const respondToolApproval = vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'approval expired' })
    window.vyotiq.respondToolApproval = respondToolApproval

    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('edit')
    })
    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      handler?.({
        type: 'tool_start',
        runId: 'run-1',
        toolCallId: 'c1',
        name: 'edit',
        summary: 'a.ts'
      })
      result.current.handleApprovalRequest({
        requestId: 'req-fail',
        runId: 'run-1',
        toolCallId: 'c1',
        name: 'edit',
        summary: 'a.ts',
        mutating: true
      })
    })

    await act(async () => {
      await expect(result.current.respondToApproval('req-fail', 'deny')).rejects.toThrow(
        /approval expired/
      )
    })

    expect(
      result.current.items.some((i) => i.kind === 'tool' && i.approval?.requestId === 'req-fail')
    ).toBe(true)
    // Card-local only — composer banner stays clear for approval IPC failures.
    expect(result.current.error).toBeNull()
  })

  it('keeps approval visible when respondToolApproval returns data false', async () => {
    const respondToolApproval = vi.fn().mockResolvedValue({ ok: true, data: false })
    window.vyotiq.respondToolApproval = respondToolApproval

    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('edit')
    })
    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      handler?.({
        type: 'tool_start',
        runId: 'run-1',
        toolCallId: 'c1',
        name: 'edit',
        summary: 'a.ts'
      })
      result.current.handleApprovalRequest({
        requestId: 'req-stale',
        runId: 'run-1',
        toolCallId: 'c1',
        name: 'edit',
        summary: 'a.ts',
        mutating: true
      })
    })

    await act(async () => {
      await expect(result.current.respondToApproval('req-stale', 'once')).rejects.toThrow(
        /not accepted/
      )
    })

    expect(
      result.current.items.some((i) => i.kind === 'tool' && i.approval?.requestId === 'req-stale')
    ).toBe(true)
  })

  it('clears pending question cards when a run is cancelled', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('ask')
    })
    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      result.current.handleQuestionRequest({
        requestId: 'q-cancel',
        runId: 'run-1',
        toolCallId: 'tq1',
        questions: [{ id: 'q1', prompt: 'Still waiting?', type: 'text' }]
      })
      handler?.({ type: 'status', runId: 'run-1', status: 'cancelled' })
    })

    expect(result.current.items.some((i) => i.kind === 'question')).toBe(false)
  })

  it('clears pending question when ask_question tool_result settles', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('ask')
    })
    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      handler?.({
        type: 'tool_start',
        runId: 'run-1',
        toolCallId: 'tq-settle',
        name: 'ask_question',
        summary: 'Pick?'
      })
      result.current.handleQuestionRequest({
        requestId: 'q-settle',
        runId: 'run-1',
        toolCallId: 'tq-settle',
        questions: [{ id: 'q1', prompt: 'Pick?', type: 'boolean' }]
      })
    })

    expect(result.current.items.some((i) => i.kind === 'question')).toBe(true)

    await act(async () => {
      handler?.({
        type: 'tool_result',
        runId: 'run-1',
        toolCallId: 'tq-settle',
        name: 'ask_question',
        summary: 'Pick?',
        ok: false,
        content: 'Interrupted'
      })
    })

    expect(result.current.items.some((i) => i.kind === 'question')).toBe(false)
  })

  it('shows a question card without a prior ask_question tool row', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('ask')
    })
    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      result.current.handleQuestionRequest({
        requestId: 'q-orphan',
        runId: 'run-1',
        toolCallId: 'tq-missing',
        questions: [{ id: 'q1', prompt: 'No tool row yet?', type: 'text' }]
      })
    })

    expect(
      result.current.items.some(
        (i) => i.kind === 'question' && i.question.requestId === 'q-orphan'
      )
    ).toBe(true)
    expect(result.current.items.some((i) => i.kind === 'tool')).toBe(false)
  })

  it('clears question only after respondAgentQuestion succeeds with data true', async () => {
    const respondAgentQuestion = vi.fn().mockResolvedValue({ ok: true, data: true })
    window.vyotiq.respondAgentQuestion = respondAgentQuestion

    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('ask')
    })
    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      result.current.handleQuestionRequest({
        requestId: 'q-1',
        runId: 'run-1',
        toolCallId: 'tq1',
        questions: [
          { id: 'q1', prompt: 'Pick one?', type: 'single', options: ['A', 'B'] }
        ]
      })
    })

    expect(result.current.items.some((i) => i.kind === 'question')).toBe(true)

    await act(async () => {
      await result.current.respondToQuestion('q-1', [{ questionId: 'q1', values: ['A'] }])
    })

    expect(respondAgentQuestion).toHaveBeenCalledWith(
      'q-1',
      [{ questionId: 'q1', values: ['A'] }],
      'run-1'
    )
    expect(result.current.items.some((i) => i.kind === 'question')).toBe(false)
  })

  it('keeps question visible when respondAgentQuestion returns data false', async () => {
    const respondAgentQuestion = vi.fn().mockResolvedValue({ ok: true, data: false })
    window.vyotiq.respondAgentQuestion = respondAgentQuestion

    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('ask')
    })
    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      result.current.handleQuestionRequest({
        requestId: 'q-stale',
        runId: 'run-1',
        toolCallId: 'tq1',
        questions: [{ id: 'q1', prompt: 'Still there?', type: 'text' }]
      })
    })

    await act(async () => {
      await expect(
        result.current.respondToQuestion('q-stale', [{ questionId: 'q1', values: ['yes'] }])
      ).rejects.toThrow(/not accepted/)
    })

    expect(
      result.current.items.some(
        (i) => i.kind === 'question' && i.question.requestId === 'q-stale'
      )
    ).toBe(true)
  })

  it('keeps pending question cards across stream_reset', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('ask')
    })
    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      result.current.handleQuestionRequest({
        requestId: 'q-keep',
        runId: 'run-1',
        toolCallId: 'tq1',
        questions: [{ id: 'q1', prompt: 'Survive retry?', type: 'text' }]
      })
      handler?.({ type: 'stream_reset', runId: 'run-1', step: 1 })
    })

    expect(
      result.current.items.some(
        (i) => i.kind === 'question' && i.question.requestId === 'q-keep'
      )
    ).toBe(true)
  })
})
