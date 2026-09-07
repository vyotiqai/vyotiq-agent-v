/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useChatStream } from '@renderer/lib/hooks/useChatStream'
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

  it('clears state when workspace changes', async () => {
    const { result, rerender } = renderHook(
      ({ ws }: { ws: string | null }) => useChatStream(ws),
      { initialProps: { ws: '/a' as string | null } }
    )

    await act(async () => {
      await result.current.send('hello')
    })
    expect(result.current.items.length).toBeGreaterThan(0)

    rerender({ ws: '/b' })
    expect(result.current.items).toEqual([])
    expect(result.current.messages).toEqual([])
  })

  it('includes tool history in the next chatStart payload', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('use tools')
    })

    await act(async () => {
      handler?.({
        type: 'assistant_message',
        runId: 'run-1',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }]
      })
      handler?.({
        type: 'tool_result',
        runId: 'run-1',
        toolCallId: 'c1',
        name: 'read',
        summary: 'a.ts',
        ok: true,
        content: 'body'
      })
      handler?.({
        type: 'assistant_message',
        runId: 'run-1',
        content: 'done'
      })
      handler?.({ type: 'status', runId: 'run-1', status: 'done' })
    })

    chatStart.mockClear()
    chatStart.mockResolvedValue({ ok: true, data: { runId: 'run-1', invokeId: 1 } })

    await act(async () => {
      await result.current.send('follow up')
    })

    const payload = chatStart.mock.calls[0][0]
    expect(payload.runId).toBe('run-1')
    expect(payload.incremental).toBe(true)
    expect(payload.newMessages).toHaveLength(1)
    expect(payload.newMessages[0]).toMatchObject({ role: 'user', content: 'follow up' })
    expect(result.current.messages.some((m) => m.role === 'tool')).toBe(true)
    expect(
      result.current.messages.some(
        (m) => m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0
      )
    ).toBe(true)
  })

  it('routes send to chatFollowUp while a run is active', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('start')
    })
    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running', invokeId: 1 })
    })
    expect(result.current.running).toBe(true)

    chatStart.mockClear()
    await act(async () => {
      await result.current.send('steer now')
    })

    expect(chatStart).not.toHaveBeenCalled()
    expect(chatFollowUp).toHaveBeenCalledWith({
      runId: 'run-1',
      message: expect.objectContaining({ role: 'user', content: 'steer now' })
    })
    expect(result.current.pendingFollowUps.some((e) => e.preview === 'steer now')).toBe(true)
    expect(
      result.current.messages.some((m) => m.role === 'user' && m.content === 'steer now')
    ).toBe(false)
    expect(result.current.running).toBe(true)
  })

  it('places tools after a mid-run continue bubble, not above it', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('first')
    })
    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running', invokeId: 1 })
      handler?.({
        type: 'assistant_message',
        runId: 'run-1',
        invokeId: 1,
        content: '',
        toolCalls: [{ id: 't-old', name: 'read', arguments: '{"path":"a.ts"}' }]
      })
      handler?.({
        type: 'tool_start',
        runId: 'run-1',
        invokeId: 1,
        toolCallId: 't-old',
        name: 'read',
        summary: 'a.ts'
      })
      handler?.({
        type: 'tool_result',
        runId: 'run-1',
        invokeId: 1,
        toolCallId: 't-old',
        name: 'read',
        summary: 'a.ts',
        ok: true,
        content: 'ok'
      })
    })

    await act(async () => {
      await result.current.send('continue')
    })

    await act(async () => {
      handler?.({
        type: 'follow_up_applied',
        runId: 'run-1',
        invokeId: 1,
        ids: ['fu-1'],
        messages: [{ role: 'user', content: 'continue' }]
      })
    })

    const continueIdx = result.current.items.findIndex(
      (item) => item.kind === 'message' && item.role === 'user' && item.content === 'continue'
    )
    expect(continueIdx).toBeGreaterThanOrEqual(0)

    await act(async () => {
      handler?.({
        type: 'tool_start',
        runId: 'run-1',
        invokeId: 1,
        toolCallId: 't-new',
        name: 'read',
        summary: 'b.ts'
      })
    })

    const newToolIdx = result.current.items.findIndex(
      (item) => item.kind === 'tool' && (item.id === 't-new' || item.tool.id === 't-new')
    )
    expect(newToolIdx).toBeGreaterThan(continueIdx)

    const rows = buildTranscriptRows(result.current.items, { running: true })
    const continueTurn = rows.find(
      (row) => row.kind === 'user' && row.item.content === 'continue'
    )?.turnIndex
    const newActivity = rows.find(
      (row) =>
        row.kind === 'activity' &&
        row.tools.some((t) => t.id === 't-new' || t.tool.id === 't-new')
    )
    expect(continueTurn).toBeDefined()
    expect(newActivity?.turnIndex).toBe(continueTurn)
  })

  it('queues cancel when stop races chatStart', async () => {
    let resolveStart: (v: unknown) => void = () => undefined
    chatStart.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve
        })
    )

    const { result } = renderHook(() => useChatStream('/ws'))

    let sendPromise: Promise<void>
    await act(async () => {
      sendPromise = result.current.send('late')
    })

    await act(async () => {
      await result.current.stop()
    })

    await act(async () => {
      resolveStart({ ok: true, data: { runId: 'late-run' } })
      await sendPromise!
    })

    await waitFor(() => {
      expect(chatCancel).toHaveBeenCalledWith('late-run')
    })
  })

  it('cancels when reset races chatStart before runId exists', async () => {
    let resolveStart: (v: unknown) => void = () => undefined
    chatStart.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve
        })
    )

    const { result } = renderHook(() => useChatStream('/ws'))

    let sendPromise: Promise<void>
    await act(async () => {
      sendPromise = result.current.send('reset-race')
    })

    await act(async () => {
      result.current.reset()
    })

    expect(result.current.items).toEqual([])
    expect(result.current.running).toBe(false)

    await act(async () => {
      resolveStart({ ok: true, data: { runId: 'orphan-run' } })
      await sendPromise!
    })

    await waitFor(() => {
      expect(chatCancel).toHaveBeenCalledWith('orphan-run')
    })
    expect(result.current.running).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('rolls back optimistic turn when chatStart fails', async () => {
    chatStart.mockResolvedValue({ ok: false, error: 'start failed' })
    const { result } = renderHook(() => useChatStream('/ws'))

    let ok = true
    await act(async () => {
      ok = await result.current.send('lost message')
    })

    expect(ok).toBe(false)
    expect(result.current.running).toBe(false)
    expect(result.current.error).toBe('start failed')
    expect(result.current.items).toEqual([])
    expect(result.current.messages).toEqual([])
  })

  it('ignores late events after a run finishes', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('hi')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      handler?.({ type: 'text_delta', runId: 'run-1', text: 'hello' })
      handler?.({ type: 'assistant_message', runId: 'run-1', content: 'hello' })
      handler?.({ type: 'status', runId: 'run-1', status: 'done' })
    })

    const count = result.current.items.length

    await act(async () => {
      handler?.({ type: 'text_delta', runId: 'run-1', text: ' LATE' })
      handler?.({ type: 'error', runId: 'run-1', message: 'should ignore' })
    })

    expect(result.current.items).toHaveLength(count)
    expect(result.current.error).toBeNull()
    expect(result.current.running).toBe(false)
  })

  it('merges tool_start into an existing tool_call_delta row', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('read')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      handler?.({
        type: 'tool_call_delta',
        runId: 'run-1',
        toolCallId: 'c1',
        name: 'read',
        argumentsDelta: '{"path":"a.ts"}'
      })
      handler?.({
        type: 'tool_start',
        runId: 'run-1',
        toolCallId: 'c1',
        name: 'read',
        summary: 'a.ts'
      })
    })

    const tools = result.current.items.filter((i) => i.kind === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({
      kind: 'tool',
      id: 'c1',
      tool: {
        name: 'read',
        summary: 'a.ts',
        status: 'running',
        argsPreview: '{"path":"a.ts"}'
      }
    })
  })

  it('loadTranscript preserves tool rows from messages', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      result.current.loadTranscript([
        { role: 'user', content: 'read file' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }]
        },
        { role: 'tool', toolCallId: 'c1', toolName: 'read', content: 'contents' },
        { role: 'assistant', content: 'here you go' }
      ])
    })

    expect(result.current.items.map((i) => i.kind)).toEqual(['message', 'tool', 'message'])
    const tool = result.current.items[1]
    expect(tool).toMatchObject({
      kind: 'tool',
      tool: { name: 'read', summary: 'a.ts', status: 'done', content: 'contents' }
    })
  })

  it('cancels an active run when loading a transcript', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('active')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
    })

    await act(async () => {
      result.current.loadTranscript([{ role: 'user', content: 'prior' }])
    })

    expect(chatCancel).toHaveBeenCalledWith('run-1')
    expect(result.current.running).toBe(false)
    expect(result.current.items).toHaveLength(1)
    expect(result.current.items[0]).toMatchObject({ role: 'user', content: 'prior' })
  })

  it('hydrateTranscript does not clobber an active run', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('active')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
    })
    chatCancel.mockClear()

    await act(async () => {
      result.current.hydrateTranscript([
        { role: 'user', content: 'restored' },
        { role: 'assistant', content: 'ok' }
      ])
    })

    expect(chatCancel).not.toHaveBeenCalled()
    expect(result.current.running).toBe(true)
    expect(result.current.runId).toBe('run-1')
    expect(result.current.items[0]).toMatchObject({ role: 'user', content: 'active' })
    expect(result.current.items.some((i) => i.kind === 'message' && i.content === 'restored')).toBe(
      false
    )
  })

  it('hydrateTranscript loads messages when the controller is idle', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      result.current.hydrateTranscript([
        { role: 'user', content: 'restored' },
        { role: 'assistant', content: 'ok' }
      ])
    })

    expect(result.current.running).toBe(false)
    expect(result.current.items.map((i) => (i.kind === 'message' ? i.content : i.kind))).toEqual([
      'restored',
      'ok'
    ])
  })

  it('restores error banner from persisted error events when idle', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      result.current.hydrateTranscript([{ role: 'user', content: 'x' }], [
        {
          at: '2026-07-24T12:00:00.000Z',
          event: { type: 'error', runId: 'run-1', message: 'Provider exploded', code: 'PROVIDER_STREAM' }
        }
      ])
    })

    expect(result.current.error).toBe('Provider exploded')
  })

  it('does not restore a dismissed error banner on rehydrate', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      result.current.hydrateTranscript([{ role: 'user', content: 'x' }], [
        {
          at: '2026-07-24T12:00:00.000Z',
          event: {
            type: 'error',
            runId: 'run-1',
            message: 'Provider exploded',
            code: 'PROVIDER_STREAM'
          }
        }
      ])
    })

    expect(result.current.error).toBe('Provider exploded')

    await act(async () => {
      result.current.clearError()
    })
    expect(result.current.error).toBeNull()

    await act(async () => {
      result.current.hydrateTranscript([{ role: 'user', content: 'x' }], [
        {
          at: '2026-07-24T12:00:00.000Z',
          event: {
            type: 'error',
            runId: 'run-1',
            message: 'Provider exploded',
            code: 'PROVIDER_STREAM'
          }
        }
      ])
    })

    expect(result.current.error).toBeNull()
  })

  it('sets a fallback error when status is error without an error event', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('fail')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      handler?.({ type: 'status', runId: 'run-1', status: 'error' })
    })

    expect(result.current.running).toBe(false)
    expect(result.current.error).toBe('Failed')
  })

  it('ignores orphan stream events after loadTranscript races chatStart', async () => {
    let resolveStart: (v: unknown) => void = () => undefined
    chatStart.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve
        })
    )

    const { result } = renderHook(() => useChatStream('/ws'))

    let sendPromise: Promise<void>
    await act(async () => {
      sendPromise = result.current.send('race')
    })

    await act(async () => {
      result.current.loadTranscript([{ role: 'user', content: 'loaded' }])
    })

    expect(result.current.items).toHaveLength(1)
    expect(result.current.items[0]).toMatchObject({ content: 'loaded' })

    await act(async () => {
      handler?.({ type: 'text_delta', runId: 'orphan-run', text: 'leak' })
      resolveStart({ ok: true, data: { runId: 'orphan-run' } })
      await sendPromise!
    })

    await waitFor(() => {
      expect(chatCancel).toHaveBeenCalledWith('orphan-run')
    })
    expect(result.current.items).toHaveLength(1)
    expect(result.current.items[0]).toMatchObject({ content: 'loaded' })
  })

  it('marks orphan running tools failed when a run is cancelled', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('tools')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      handler?.({
        type: 'tool_call_delta',
        runId: 'run-1',
        toolCallId: 'c1',
        name: 'read',
        argumentsDelta: '{"path":"a.ts"}'
      })
      handler?.({ type: 'status', runId: 'run-1', status: 'cancelled' })
    })

    const tool = result.current.items.find((i) => i.kind === 'tool')
    expect(tool).toMatchObject({
      kind: 'tool',
      tool: { status: 'fail', content: 'Cancelled' }
    })
  })

  it('marks orphan running tools failed when a run errors', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('tools')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      handler?.({
        type: 'tool_call_delta',
        runId: 'run-1',
        toolCallId: 'c1',
        name: 'read',
        argumentsDelta: '{"path":"a.ts"}'
      })
      handler?.({ type: 'status', runId: 'run-1', status: 'error' })
    })

    const tool = result.current.items.find((i) => i.kind === 'tool')
    expect(tool).toMatchObject({
      kind: 'tool',
      tool: { status: 'fail', content: 'Interrupted' }
    })
  })

  it('places assistant text before tools when tool deltas arrive first', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('read with preamble')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
    })

    await act(async () => {
      handler?.({
        type: 'tool_call_delta',
        runId: 'run-1',
        toolCallId: 'c1',
        name: 'read',
        argumentsDelta: '{"path":"a.ts"}'
      })
    })

    await act(async () => {
      handler?.({ type: 'text_delta', runId: 'run-1', text: 'Reading now.' })
    })

    await act(async () => {
      handler?.({
        type: 'assistant_message',
        runId: 'run-1',
        content: 'Reading now.',
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }]
      })
    })

    expect(result.current.items.map((i) => i.kind)).toEqual(['message', 'message', 'tool'])
    const assistant = result.current.items[1]
    expect(assistant).toMatchObject({
      kind: 'message',
      role: 'assistant',
      content: 'Reading now.'
    })
  })

  it('appends next-iteration text after completed tools instead of reshuffling', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('multi step')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      handler?.({ type: 'text_delta', runId: 'run-1', text: 'First look.' })
      handler?.({
        type: 'assistant_message',
        runId: 'run-1',
        content: 'First look.',
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }]
      })
      handler?.({
        type: 'tool_start',
        runId: 'run-1',
        toolCallId: 'c1',
        name: 'read',
        summary: 'a.ts'
      })
      handler?.({
        type: 'tool_result',
        runId: 'run-1',
        toolCallId: 'c1',
        name: 'read',
        summary: 'a.ts',
        ok: true,
        content: 'ok'
      })
      handler?.({ type: 'text_delta', runId: 'run-1', text: 'Next batch.' })
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })

    expect(result.current.items.map((i) => i.kind)).toEqual([
      'message',
      'message',
      'tool',
      'message'
    ])
    expect(result.current.items[1]).toMatchObject({ content: 'First look.' })
    expect(result.current.items[2]).toMatchObject({ kind: 'tool' })
    expect(result.current.items[3]).toMatchObject({ content: 'Next batch.' })
  })

  it('inserts tools directly after their assistant turn, not at the timeline tail', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('multi step')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      handler?.({ type: 'text_delta', runId: 'run-1', text: 'First look.' })
      handler?.({
        type: 'assistant_message',
        runId: 'run-1',
        content: 'First look.',
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }]
      })
      handler?.({
        type: 'tool_start',
        runId: 'run-1',
        toolCallId: 'c1',
        name: 'read',
        summary: 'a.ts'
      })
      handler?.({
        type: 'tool_result',
        runId: 'run-1',
        toolCallId: 'c1',
        name: 'read',
        summary: 'a.ts',
        ok: true,
        content: 'ok'
      })
      handler?.({ type: 'text_delta', runId: 'run-1', text: 'Next batch.' })
      handler?.({
        type: 'assistant_message',
        runId: 'run-1',
        content: 'Next batch.',
        toolCalls: [{ id: 'c2', name: 'read', arguments: '{"path":"b.ts"}' }]
      })
    })

    expect(result.current.items.map((i) => (i.kind === 'message' ? i.content : i.tool.summary))).toEqual([
      'multi step',
      'First look.',
      'a.ts',
      'Next batch.',
      'b.ts'
    ])
  })

  it('does not mark live tools failed when next-iteration text streams', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('list files')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      handler?.({
        type: 'tool_call_delta',
        runId: 'run-1',
        toolCallId: 'pending_0',
        name: 'terminal',
        argumentsDelta: '{"command":"dir"}'
      })
      handler?.({ type: 'text_delta', runId: 'run-1', text: 'First pass.' })
      handler?.({
        type: 'assistant_message',
        runId: 'run-1',
        content: 'First pass.',
        toolCalls: [{ id: 'c1', name: 'terminal', arguments: '{"command":"dir"}' }]
      })
      handler?.({
        type: 'tool_result',
        runId: 'run-1',
        toolCallId: 'c1',
        name: 'terminal',
        summary: 'dir',
        ok: true,
        content: 'listed'
      })
      handler?.({
        type: 'tool_call_delta',
        runId: 'run-1',
        toolCallId: 'pending_1',
        name: 'read',
        argumentsDelta: '{"path":"a.ts"}'
      })
      handler?.({ type: 'text_delta', runId: 'run-1', text: 'Second pass.' })
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })

    const live = result.current.items.find(
      (i) => i.kind === 'tool' && i.tool.name === 'read' && i.tool.status === 'running'
    )
    expect(live).toBeTruthy()
    if (live?.kind === 'tool') {
      expect(live.tool.status).toBe('running')
    }
  })

  it('merges pending tool_call_delta rows when assistant_message arrives', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('read')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      handler?.({ type: 'text_delta', runId: 'run-1', text: 'Reading.' })
      handler?.({
        type: 'tool_call_delta',
        runId: 'run-1',
        toolCallId: 'pending_0',
        name: 'read',
        argumentsDelta: '{"path":"a.ts"}'
      })
      handler?.({
        type: 'assistant_message',
        runId: 'run-1',
        content: 'Reading.',
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }]
      })
    })

    const tools = result.current.items.filter((i) => i.kind === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({
      id: 'c1',
      tool: { id: 'c1', name: 'read', summary: 'a.ts', status: 'running' }
    })
  })

  it('prunes orphan edit deltas when assistant_message only keeps other tools', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('audit')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      handler?.({
        type: 'tool_call_delta',
        runId: 'run-1',
        toolCallId: 'pending_0',
        name: 'edit',
        argumentsDelta: '{"edits":[{"path":"api/page.tsx","contents":"x"}]}'
      })
      handler?.({
        type: 'assistant_message',
        runId: 'run-1',
        content: 'tool {"edits":[{"path":"api/page.tsx","contents":"x"}]}\nChecking routes.',
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"routes.ts"}' }]
      })
      handler?.({
        type: 'tool_start',
        runId: 'run-1',
        toolCallId: 'c1',
        name: 'read',
        summary: 'routes.ts'
      })
      handler?.({
        type: 'tool_result',
        runId: 'run-1',
        toolCallId: 'c1',
        name: 'read',
        summary: 'routes.ts',
        ok: true,
        content: 'ok'
      })
    })

    const tools = result.current.items.filter((i) => i.kind === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({
      id: 'c1',
      tool: { name: 'read', status: 'done' }
    })
    const assistant = result.current.items.find(
      (i) => i.kind === 'message' && i.role === 'assistant'
    )
    expect(assistant?.kind === 'message' ? assistant.content : null).toBe('Checking routes.')
  })

  it('prunes real-id orphan tools when assistant_message has no toolCalls', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('audit')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      handler?.({
        type: 'tool_call_delta',
        runId: 'run-1',
        toolCallId: 'orphan-real',
        name: 'read',
        argumentsDelta: '{"path":"ghost.ts"}'
      })
      handler?.({
        type: 'assistant_message',
        runId: 'run-1',
        content: 'No tools this step.'
      })
    })

    expect(result.current.items.some((i) => i.kind === 'tool')).toBe(false)
    const assistant = result.current.items.find(
      (i) => i.kind === 'message' && i.role === 'assistant'
    )
    expect(assistant?.kind === 'message' ? assistant.content : null).toBe('No tools this step.')
  })

  it('does not render in-progress leaked tool JSON as streaming assistant text', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('audit')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      handler?.({
        type: 'text_delta',
        runId: 'run-1',
        text: 'Checking routes.\ntool {"path":"routes.ts"'
      })
    })

    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })

    const assistant = result.current.items.find(
      (i) => i.kind === 'message' && i.role === 'assistant'
    )
    expect(assistant?.kind === 'message' ? assistant.content : null).toBe('Checking routes.')
  })

  it('scrubs pending leaked tool text before flush when tool_call_delta arrives', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('audit')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      // Schedule text without waiting for RAF so it stays in pendingTextDelta.
      handler?.({
        type: 'text_delta',
        runId: 'run-1',
        text: 'tool {"path":"routes.ts"}'
      })
      handler?.({
        type: 'tool_call_delta',
        runId: 'run-1',
        toolCallId: 'c1',
        name: 'read',
        argumentsDelta: '{"path":"routes.ts"}'
      })
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })

    const assistant = result.current.items.find(
      (i) => i.kind === 'message' && i.role === 'assistant'
    )
    const tools = result.current.items.filter((i) => i.kind === 'tool')
    expect(assistant?.kind === 'message' ? assistant.content : '').toBe('')
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({
      tool: { name: 'read', status: 'running' }
    })
  })

  it('does not stack later assistant text before orphaned live tools', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('list files')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      handler?.({
        type: 'tool_call_delta',
        runId: 'run-1',
        toolCallId: 'pending_0',
        name: 'terminal',
        argumentsDelta: '{"command":"dir"}'
      })
      handler?.({ type: 'text_delta', runId: 'run-1', text: 'First pass.' })
      handler?.({
        type: 'assistant_message',
        runId: 'run-1',
        content: 'First pass.',
        toolCalls: [{ id: 'c1', name: 'terminal', arguments: '{"command":"dir"}' }]
      })
      handler?.({
        type: 'tool_start',
        runId: 'run-1',
        toolCallId: 'c1',
        name: 'terminal',
        summary: 'dir'
      })
      handler?.({
        type: 'tool_result',
        runId: 'run-1',
        toolCallId: 'c1',
        name: 'terminal',
        summary: 'dir',
        ok: true,
        content: 'listed'
      })
      handler?.({
        type: 'tool_call_delta',
        runId: 'run-1',
        toolCallId: 'pending_1',
        name: 'read',
        argumentsDelta: '{}'
      })
      handler?.({ type: 'text_delta', runId: 'run-1', text: 'Second pass.' })
      handler?.({
        type: 'assistant_message',
        runId: 'run-1',
        content: 'Second pass.',
        toolCalls: [{ id: 'c2', name: 'read', arguments: '{}' }]
      })
      handler?.({ type: 'text_delta', runId: 'run-1', text: 'Third pass.' })
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })

    const kinds = result.current.items.map((i) => i.kind)
    const firstToolIdx = kinds.indexOf('tool')
    const secondAssistantIdx = result.current.items.findIndex(
      (i) => i.kind === 'message' && i.role === 'assistant' && i.content === 'Second pass.'
    )
    const thirdAssistantIdx = result.current.items.findIndex(
      (i) => i.kind === 'message' && i.role === 'assistant' && i.content === 'Third pass.'
    )

    expect(firstToolIdx).toBeGreaterThan(-1)
    expect(secondAssistantIdx).toBeGreaterThan(firstToolIdx)
    expect(thirdAssistantIdx).toBeGreaterThan(firstToolIdx)
    expect(result.current.items.map((i) => (i.kind === 'message' ? i.content : i.kind))).toEqual([
      'list files',
      'First pass.',
      'tool',
      'tool',
      'Second pass.',
      'Third pass.'
    ])
  })

  it('keeps multi-tool steps interleaved across iterations', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('analyze codebase')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      handler?.({ type: 'text_delta', runId: 'run-1', text: 'Reading configs.' })
      handler?.({
        type: 'assistant_message',
        runId: 'run-1',
        content: 'Reading configs.',
        toolCalls: [
          { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' },
          { id: 'c2', name: 'read', arguments: '{"path":"b.ts"}' }
        ]
      })
      handler?.({
        type: 'tool_start',
        runId: 'run-1',
        toolCallId: 'c1',
        name: 'read',
        summary: 'a.ts'
      })
      handler?.({
        type: 'tool_start',
        runId: 'run-1',
        toolCallId: 'c2',
        name: 'read',
        summary: 'b.ts'
      })
      handler?.({
        type: 'tool_result',
        runId: 'run-1',
        toolCallId: 'c1',
        name: 'read',
        summary: 'a.ts',
        ok: true,
        content: 'a'
      })
      handler?.({
        type: 'tool_result',
        runId: 'run-1',
        toolCallId: 'c2',
        name: 'read',
        summary: 'b.ts',
        ok: true,
        content: 'b'
      })
      handler?.({ type: 'text_delta', runId: 'run-1', text: 'Exploring sources.' })
      handler?.({
        type: 'assistant_message',
        runId: 'run-1',
        content: 'Exploring sources.',
        toolCalls: [{ id: 'c3', name: 'search', arguments: '{"query":".kt"}' }]
      })
      handler?.({
        type: 'tool_start',
        runId: 'run-1',
        toolCallId: 'c3',
        name: 'search',
        summary: '.kt'
      })
    })

    expect(result.current.items.map((i) => (i.kind === 'message' ? i.content : i.tool.summary))).toEqual([
      'analyze codebase',
      'Reading configs.',
      'a.ts',
      'b.ts',
      'Exploring sources.',
      '.kt'
    ])
    const secondTool = result.current.items[2]
    expect(secondTool.kind).toBe('tool')
    if (secondTool.kind === 'tool') {
      expect(secondTool.groupTiming?.endedAt).toBeTypeOf('number')
    }
    const thirdIterationTool = result.current.items[5]
    expect(thirdIterationTool).toMatchObject({ kind: 'tool', id: 'c3' })
    if (thirdIterationTool.kind === 'tool') {
      expect(thirdIterationTool.groupTiming?.startedAt).toBeTypeOf('number')
      expect(thirdIterationTool.groupTiming?.startedAt).toBeGreaterThanOrEqual(
        secondTool.kind === 'tool' ? (secondTool.groupTiming?.startedAt ?? 0) : 0
      )
    }
  })

  it('migrates pending tool rows when canonical ids arrive', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('read')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      handler?.({
        type: 'tool_call_delta',
        runId: 'run-1',
        toolCallId: 'pending_0',
        name: 'read',
        argumentsDelta: '{"path":"a.ts"}'
      })
      handler?.({
        type: 'tool_start',
        runId: 'run-1',
        toolCallId: 'call-real',
        name: 'read',
        summary: 'a.ts'
      })
    })

    const tools = result.current.items.filter((i) => i.kind === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({
      id: 'call-real',
      tool: {
        id: 'call-real',
        name: 'read',
        summary: 'a.ts',
        status: 'running',
        argsPreview: '{"path":"a.ts"}'
      }
    })
  })

  it('migrates parallel pending tool rows by pending index', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('parallel tools')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      handler?.({
        type: 'tool_call_delta',
        runId: 'run-1',
        toolCallId: 'pending_0',
        name: 'read',
        argumentsDelta: '{"path":"a.ts"}'
      })
      handler?.({
        type: 'tool_call_delta',
        runId: 'run-1',
        toolCallId: 'pending_1',
        name: 'read',
        argumentsDelta: '{"path":"b.ts"}'
      })
      handler?.({
        type: 'tool_start',
        runId: 'run-1',
        toolCallId: 'call-a',
        name: 'read',
        summary: 'a.ts'
      })
      handler?.({
        type: 'tool_start',
        runId: 'run-1',
        toolCallId: 'call-b',
        name: 'read',
        summary: 'b.ts'
      })
    })

    const tools = result.current.items.filter((i) => i.kind === 'tool')
    expect(tools).toHaveLength(2)
    expect(tools[0]).toMatchObject({
      id: 'call-a',
      tool: { id: 'call-a', summary: 'a.ts', argsPreview: '{"path":"a.ts"}' }
    })
    expect(tools[1]).toMatchObject({
      id: 'call-b',
      tool: { id: 'call-b', summary: 'b.ts', argsPreview: '{"path":"b.ts"}' }
    })
  })

  it('keeps each step reasoning inline before its tools', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('refactor')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      handler?.({ type: 'thinking_delta', runId: 'run-1', text: 'First I read the surrounding module.' })
      handler?.({
        type: 'assistant_message',
        runId: 'run-1',
        content: '',
        thinking: 'First I read the surrounding module.',
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }]
      })
      handler?.({
        type: 'tool_result',
        runId: 'run-1',
        toolCallId: 'c1',
        name: 'read',
        summary: 'a.ts',
        ok: true,
        content: 'body'
      })
      handler?.({ type: 'thinking_delta', runId: 'run-1', text: 'Now I edit the exported helper.' })
      handler?.({
        type: 'assistant_message',
        runId: 'run-1',
        content: '',
        thinking: 'Now I edit the exported helper.',
        toolCalls: [{ id: 'c2', name: 'edit', arguments: '{"path":"a.ts"}' }]
      })
      handler?.({
        type: 'tool_result',
        runId: 'run-1',
        toolCallId: 'c2',
        name: 'edit',
        summary: 'a.ts',
        ok: true,
        content: 'ok'
      })
      handler?.({ type: 'assistant_message', runId: 'run-1', content: 'Refactored.' })
      handler?.({ type: 'status', runId: 'run-1', status: 'done' })
    })

    const thinkingRows = result.current.items.filter((i) => i.kind === 'message' && i.thinking)
    expect(thinkingRows.map((row) => row.kind === 'message' && row.thinking)).toEqual([
      'First I read the surrounding module.',
      'Now I edit the exported helper.'
    ])

    const shape = result.current.items.map((item) =>
      item.kind === 'tool' ? `tool:${item.tool.name}` : item.thinking || item.content
    )
    expect(shape).toEqual([
      'refactor',
      'First I read the surrounding module.',
      'tool:read',
      'Now I edit the exported helper.',
      'tool:edit',
      'Refactored.'
    ])

    // Turn summary rides the end of work; closing answer follows.
    expect(buildTranscriptRows(result.current.items).map((row) => row.kind)).toEqual([
      'user',
      'thinking',
      'activity',
      'thinking',
      'card',
      'turn',
      'text'
    ])
  })

  it('renders narration, reasoning and a command while the run is still live', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('audit it')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      handler?.({ type: 'thinking_delta', runId: 'run-1', text: 'Start with the router module next.' })
      handler?.({
        type: 'assistant_message',
        runId: 'run-1',
        content: '',
        thinking: 'Start with the router module next.',
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }]
      })
      handler?.({
        type: 'tool_result',
        runId: 'run-1',
        toolCallId: 'c1',
        name: 'read',
        summary: 'a.ts',
        ok: true,
        content: 'body'
      })
      handler?.({ type: 'text_delta', runId: 'run-1', text: 'The table is built up front.' })
      handler?.({
        type: 'assistant_message',
        runId: 'run-1',
        content: 'The table is built up front.',
        toolCalls: [{ id: 'c2', name: 'terminal', arguments: '{"command":"npm test"}' }]
      })
      handler?.({
        type: 'tool_start',
        runId: 'run-1',
        toolCallId: 'c2',
        name: 'terminal',
        summary: 'npm test'
      })
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })

    const rows = buildTranscriptRows(result.current.items)
    expect(rows.map((row) => row.kind)).toEqual([
      'user',
      'thinking',
      'activity',
      'text',
      'card',
      'turn'
    ])
    const narration = rows.find((row) => row.kind === 'text')
    expect(narration?.kind === 'text' && narration.item.content).toBe(
      'The table is built up front.'
    )
    const command = rows.find((row) => row.kind === 'card' && row.item.tool.name === 'terminal')
    expect(command?.kind === 'card' && command.item.tool.status).toBe('running')
  })

  it('completes the live row when a tool_result id drifts from its tool_start', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('read')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      handler?.({
        type: 'tool_start',
        runId: 'run-1',
        toolCallId: 'call-start',
        name: 'read',
        summary: 'a.ts'
      })
      handler?.({
        type: 'tool_result',
        runId: 'run-1',
        toolCallId: 'call-drifted',
        name: 'read',
        summary: 'a.ts',
        ok: true,
        content: 'body'
      })
    })

    const tools = result.current.items.filter((i) => i.kind === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({
      id: 'call-drifted',
      tool: { id: 'call-drifted', name: 'read', status: 'done', content: 'body' }
    })
  })

  it('promotes presentation after a nameless first tool_call_delta', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('run tests')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      handler?.({
        type: 'tool_call_delta',
        runId: 'run-1',
        toolCallId: 'pending_0',
        argumentsDelta: ''
      })
      handler?.({
        type: 'tool_call_delta',
        runId: 'run-1',
        toolCallId: 'pending_0',
        name: 'terminal',
        argumentsDelta: '{"command":"npm test"}'
      })
      handler?.({
        type: 'assistant_message',
        runId: 'run-1',
        content: '',
        toolCalls: [{ id: 'c1', name: 'terminal', arguments: '{"command":"npm test"}' }]
      })
      handler?.({
        type: 'tool_start',
        runId: 'run-1',
        toolCallId: 'c1',
        name: 'terminal',
        summary: 'npm test'
      })
    })

    const tool = result.current.items.find((i) => i.kind === 'tool')
    expect(tool?.kind === 'tool' ? tool.tool.presentation : null).toBe('prominent')
    const rows = buildTranscriptRows(result.current.items)
    expect(rows.some((row) => row.kind === 'card')).toBe(true)
  })

  it('does not attach a drifted tool_result to the wrong parallel same-name row', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('read both')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      handler?.({
        type: 'tool_start',
        runId: 'run-1',
        toolCallId: 'r1',
        name: 'read',
        summary: 'a.ts'
      })
      handler?.({
        type: 'tool_start',
        runId: 'run-1',
        toolCallId: 'r2',
        name: 'read',
        summary: 'b.ts'
      })
      handler?.({
        type: 'tool_result',
        runId: 'run-1',
        toolCallId: 'unknown-id',
        name: 'read',
        summary: 'b.ts',
        ok: true,
        content: 'b-body'
      })
    })

    const tools = result.current.items.filter((i) => i.kind === 'tool')
    expect(tools).toHaveLength(2)
    expect(tools[0]).toMatchObject({
      id: 'r1',
      tool: { name: 'read', summary: 'a.ts', status: 'running' }
    })
    expect(tools[1]).toMatchObject({
      id: 'unknown-id',
      tool: { name: 'read', summary: 'b.ts', status: 'done', content: 'b-body' }
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'done' })
    })
    expect(
      result.current.items.filter((i) => i.kind === 'tool' && i.tool.status === 'running')
    ).toHaveLength(0)
  })

  it('FIFO-completes the oldest same-name row when tool_result id and summary are ambiguous', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('read both')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      handler?.({
        type: 'tool_start',
        runId: 'run-1',
        toolCallId: 'r1',
        name: 'read',
        summary: 'file.ts'
      })
      handler?.({
        type: 'tool_start',
        runId: 'run-1',
        toolCallId: 'r2',
        name: 'read',
        summary: 'file.ts'
      })
      handler?.({
        type: 'tool_result',
        runId: 'run-1',
        toolCallId: 'drifted',
        name: 'read',
        summary: 'file.ts',
        ok: true,
        content: 'first-body'
      })
    })

    const tools = result.current.items.filter((i) => i.kind === 'tool')
    expect(tools).toHaveLength(2)
    expect(tools[0]).toMatchObject({
      id: 'drifted',
      tool: { name: 'read', summary: 'file.ts', status: 'done', content: 'first-body' }
    })
    expect(tools[1]).toMatchObject({
      id: 'r2',
      tool: { name: 'read', summary: 'file.ts', status: 'running' }
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'done' })
    })
    expect(
      result.current.items.filter((i) => i.kind === 'tool' && i.tool.status === 'running')
    ).toHaveLength(0)
  })

  it('exposes pendingRun while chatStart is in flight', async () => {
    let resolveStart: (v: unknown) => void = () => undefined
    chatStart.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve
        })
    )

    const { result } = renderHook(() => useChatStream('/ws'))

    let sendPromise: Promise<void>
    await act(async () => {
      sendPromise = result.current.send('starting')
    })

    expect(result.current.pendingRun).toBe(true)
    expect(result.current.runId).toBeNull()

    await act(async () => {
      resolveStart({ ok: true, data: { runId: 'run-1', invokeId: 1 } })
      await sendPromise!
    })

    expect(result.current.pendingRun).toBe(false)
    expect(result.current.runId).toBe('run-1')
  })

  it('ignores stale terminal from a prior turn after follow-up send starts', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('first')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      handler?.({ type: 'assistant_message', runId: 'run-1', content: 'done' })
      handler?.({ type: 'status', runId: 'run-1', status: 'done' })
    })

    expect(result.current.running).toBe(false)

    chatStart.mockResolvedValue({ ok: true, data: { runId: 'run-1', invokeId: 1 } })

    await act(async () => {
      await result.current.send('follow up')
    })

    expect(result.current.running).toBe(true)

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'done' })
    })

    expect(result.current.running).toBe(true)

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      handler?.({
        type: 'tool_start',
        runId: 'run-1',
        toolCallId: 'c2',
        name: 'terminal',
        summary: 'dir'
      })
      handler?.({
        type: 'tool_result',
        runId: 'run-1',
        toolCallId: 'c2',
        name: 'terminal',
        summary: 'dir',
        ok: true,
        content: 'listed'
      })
      handler?.({ type: 'assistant_message', runId: 'run-1', content: 'here' })
      handler?.({ type: 'status', runId: 'run-1', status: 'done' })
    })

    expect(result.current.running).toBe(false)
    const liveTool = result.current.items.find(
      (i) => i.kind === 'tool' && i.tool.status === 'running'
    )
    expect(liveTool).toBeUndefined()
  })

  it('keeps the live turn streaming when a prior invoke terminates late', async () => {
    chatStart.mockResolvedValue({ ok: true, data: { runId: 'run-1', invokeId: 1 } })
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('first')
    })
    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running', invokeId: 1 })
      handler?.({ type: 'assistant_message', runId: 'run-1', content: 'done', invokeId: 1 })
      handler?.({ type: 'status', runId: 'run-1', status: 'done', invokeId: 1 })
    })
    expect(result.current.running).toBe(false)

    chatStart.mockResolvedValue({ ok: true, data: { runId: 'run-1', invokeId: 2 } })
    await act(async () => {
      await result.current.send('follow up')
    })

    // The live turn is already past `running`, which is what defeats a sequence-only guard.
    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running', invokeId: 2 })
      handler?.({
        type: 'tool_start',
        runId: 'run-1',
        toolCallId: 'c9',
        name: 'read',
        summary: 'a.ts',
        invokeId: 2
      })
      handler?.({ type: 'status', runId: 'run-1', status: 'done', invokeId: 1 })
    })

    expect(result.current.running).toBe(true)
    expect(
      result.current.items.some((i) => i.kind === 'tool' && i.tool.status === 'running')
    ).toBe(true)

    await act(async () => {
      handler?.({
        type: 'tool_result',
        runId: 'run-1',
        toolCallId: 'c9',
        name: 'read',
        summary: 'a.ts',
        ok: true,
        content: 'body',
        invokeId: 2
      })
      handler?.({ type: 'assistant_message', runId: 'run-1', content: 'here', invokeId: 2 })
      handler?.({ type: 'status', runId: 'run-1', status: 'done', invokeId: 2 })
    })

    expect(result.current.running).toBe(false)
    expect(
      result.current.items.some((i) => i.kind === 'tool' && i.tool.status === 'running')
    ).toBe(false)
    expect(
      result.current.items.some((i) => i.kind === 'tool' && i.tool.status === 'done')
    ).toBe(true)
  })

  it('passes the same runId on follow-up send', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('first')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      handler?.({ type: 'assistant_message', runId: 'run-1', content: 'ok' })
      handler?.({ type: 'status', runId: 'run-1', status: 'done' })
    })

    chatStart.mockClear()
    chatStart.mockResolvedValue({ ok: true, data: { runId: 'run-1', invokeId: 1 } })

    await act(async () => {
      await result.current.send('follow up')
    })

    expect(chatStart).toHaveBeenCalledWith(
      expect.objectContaining({
        incremental: true,
        newMessages: [expect.objectContaining({ role: 'user', content: 'follow up' })],
        runId: 'run-1',
        workspacePath: '/ws'
      })
    )
    expect(result.current.runId).toBe('run-1')
  })

  it('creates a tool row from tool_result when no prior delta or start', async () => {
    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('tool only')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
      handler?.({
        type: 'tool_result',
        runId: 'run-1',
        toolCallId: 'c1',
        name: 'read',
        summary: 'a.ts',
        ok: true,
        content: 'body'
      })
    })

    const tool = result.current.items.find((i) => i.kind === 'tool')
    expect(tool).toMatchObject({
      kind: 'tool',
      id: 'c1',
      tool: { name: 'read', summary: 'a.ts', status: 'done', content: 'body' }
    })
  })

  it('recovers from disk when chatCancel returns not found', async () => {
    const listActiveRuns = vi.fn()
    const loadRun = vi.fn()
    const loadRunEvents = vi.fn()
    chatCancel.mockResolvedValue({ ok: false, error: 'Run not found' })
    listActiveRuns.mockResolvedValue({ ok: true, data: [] })
    loadRun.mockResolvedValue({
      ok: true,
      data: {
        runId: 'run-1',
        messages: [{ role: 'user', content: 'prior' }, { role: 'assistant', content: 'done' }]
      }
    })
    loadRunEvents.mockResolvedValue({ ok: true, data: [] })

    // @ts-expect-error test bridge
    window.vyotiq = {
      chatStart,
      chatCancel,
      chatFollowUp,
      chatFollowUpRemove,
      listActiveRuns,
      loadRun,
      loadRunEvents,
      onChatEvent: (h: Handler) => {
        handler = h
        return () => {
          handler = null
        }
      }
    }

    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.send('active')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-1', status: 'running' })
    })

    await act(async () => {
      await result.current.stop()
    })

    await waitFor(() => {
      expect(result.current.running).toBe(false)
    })
    expect(loadRun).toHaveBeenCalledWith('/ws', 'run-1')
    expect(result.current.error).toBeNull()
    expect(result.current.items.some((i) => i.kind === 'message' && i.content === 'done')).toBe(true)
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

  it('clears approval only after respondToolApproval succeeds', async () => {
    const respondToolApproval = vi.fn().mockResolvedValue({ ok: true, data: true })
    // @ts-expect-error test bridge
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
    // @ts-expect-error test bridge
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
    // @ts-expect-error test bridge
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
    // @ts-expect-error test bridge
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
    // @ts-expect-error test bridge
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

  it('forwards mode_changed to onAgentModeChange', () => {
    const onAgentModeChange = vi.fn()
    const controller = createChatStreamController({
      workspacePath: '/ws',
      runId: 'run-1',
      onAgentModeChange
    })
    controller.handleEvent({ type: 'mode_changed', runId: 'run-1', mode: 'plan' })
    expect(onAgentModeChange).toHaveBeenCalledWith('plan')
    controller.dispose()
  })

  it('syncs composer mode from successful switch_mode tool_result', () => {
    const onAgentModeChange = vi.fn()
    const controller = createChatStreamController({
      workspacePath: '/ws',
      runId: 'run-1',
      onAgentModeChange
    })
    controller.handleEvent({
      type: 'tool_start',
      runId: 'run-1',
      toolCallId: 'tc-mode',
      name: 'switch_mode',
      summary: 'agent'
    })
    controller.handleEvent({
      type: 'tool_result',
      runId: 'run-1',
      toolCallId: 'tc-mode',
      name: 'switch_mode',
      summary: 'agent',
      ok: true,
      content: 'Mode switched from plan to agent.'
    })
    expect(onAgentModeChange).toHaveBeenCalledWith('agent')
    controller.dispose()
  })

  it('keeps runId after syncFromDisk so tool loads and later sends stay on the same session', async () => {
    const loadToolResult = vi.fn().mockResolvedValue({
      ok: true,
      data: { content: 'full body' }
    })
    const loadRun = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        messages: [
          { role: 'user', content: 'read' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }]
          },
          { role: 'tool', toolCallId: 'c1', toolName: 'read', content: 'snip' }
        ]
      }
    })
    const loadRunEvents = vi.fn().mockResolvedValue({ ok: true, data: [] })
    // @ts-expect-error test bridge
    window.vyotiq.loadRun = loadRun
    // @ts-expect-error test bridge
    window.vyotiq.loadRunEvents = loadRunEvents
    // @ts-expect-error test bridge
    window.vyotiq.loadToolResult = loadToolResult

    const { result } = renderHook(() => useChatStream('/ws'))

    await act(async () => {
      await result.current.syncFromDisk('run-disk')
    })

    expect(result.current.runId).toBe('run-disk')

    let content: string | null = null
    await act(async () => {
      content = await result.current.loadToolContent('c1')
    })

    expect(loadToolResult).toHaveBeenCalledWith('/ws', 'run-disk', 'c1')
    expect(content).toBe('full body')
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

  it('does not reattach a run after terminal status while main unwinds', async () => {
    const listActiveRuns = vi.fn()
    const loadRun = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'done' }
        ]
      }
    })
    const loadRunEvents = vi.fn().mockResolvedValue({ ok: true, data: [] })
    // @ts-expect-error test bridge
    window.vyotiq.listActiveRuns = listActiveRuns
    // @ts-expect-error test bridge
    window.vyotiq.loadRun = loadRun
    // @ts-expect-error test bridge
    window.vyotiq.loadRunEvents = loadRunEvents

    const controller = createChatStreamController({
      workspacePath: '/ws',
      runId: 'run-1'
    })

    controller.handleEvent({ type: 'status', runId: 'run-1', status: 'running', invokeId: 1 })
    controller.handleEvent({ type: 'status', runId: 'run-1', status: 'done', invokeId: 1 })
    expect(controller.running).toBe(false)
    expect(controller.runTerminalTick).toBe(1)

    listActiveRuns.mockResolvedValue({
      ok: true,
      data: [{ runId: 'run-1', workspacePath: '/ws', invokeId: 1, pendingFollowUps: [] }]
    })

    await act(async () => {
      await controller.reattachActiveRun('run-1')
    })

    expect(loadRun).toHaveBeenCalledWith('/ws', 'run-1')
    expect(controller.running).toBe(false)
    controller.dispose()
  })
})
