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

  it('closes thinking when answer text starts streaming', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('hi')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      handler?.({ type: 'thinking_delta', runId: 'run-1', text: 'Greeting the user.' })
    })

    await waitFor(() => {
      const assistant = result.current.items.find(
        (i) => i.kind === 'message' && i.role === 'assistant'
      )
      expect(assistant?.kind === 'message' && assistant.thinkingStreaming).toBe(true)
    })

    await act(async () => {
      handler?.({ type: 'text_delta', runId: 'run-1', text: 'Hello' })
    })

    await waitFor(() => {
      const assistant = result.current.items.find(
        (i) => i.kind === 'message' && i.role === 'assistant'
      )
      expect(assistant?.kind === 'message' && assistant.thinkingStreaming).toBe(false)
      expect(assistant?.kind === 'message' && assistant.streaming).toBe(true)
    })
  })

  it('closes thinking when tool calls start streaming', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('read file')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      handler?.({ type: 'thinking_delta', runId: 'run-1', text: 'I will read the file next.' })
    })

    await waitFor(() => {
      const assistant = result.current.items.find(
        (i) => i.kind === 'message' && i.role === 'assistant'
      )
      expect(assistant?.kind === 'message' && assistant.thinkingStreaming).toBe(true)
    })

    await act(async () => {
      handler?.({
        type: 'tool_call_delta',
        runId: 'run-1',
        toolCallId: 'pending_0',
        name: 'read',
        argumentsDelta: '{"path":"a.ts"}'
      })
    })

    await waitFor(() => {
      const assistant = result.current.items.find(
        (i) => i.kind === 'message' && i.role === 'assistant'
      )
      expect(assistant?.kind === 'message' && assistant.thinkingStreaming).toBe(false)
    })
  })

  it('drops live tool rows and clears streamed text on stream_reset', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('retry me')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      handler?.({ type: 'text_delta', runId: 'run-1', text: 'doomed' })
      handler?.({
        type: 'tool_call_delta',
        runId: 'run-1',
        toolCallId: 'pending_0',
        name: 'read',
        argumentsDelta: '{"path":"a.ts"}'
      })
    })

    await waitFor(() => {
      expect(
        result.current.items.some((i) => i.kind === 'tool' && i.tool.status === 'running')
      ).toBe(true)
    })

    await act(async () => {
      handler?.({ type: 'stream_reset', runId: 'run-1', step: 1 })
    })

    expect(
      result.current.items.some((i) => i.kind === 'tool' && i.tool.status === 'running')
    ).toBe(false)
    const assistant = result.current.items.find(
      (i) => i.kind === 'message' && i.role === 'assistant'
    )
    if (assistant?.kind === 'message') {
      expect(assistant.content).toBe('')
      expect(assistant.reconnecting).toBe(true)
      expect(assistant.streaming).toBe(false)
      expect(assistant.thinkingStreaming).toBe(false)
    }
  })
})
