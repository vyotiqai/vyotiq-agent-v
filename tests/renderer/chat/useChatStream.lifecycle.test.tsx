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
    window.vyotiq.listActiveRuns = listActiveRuns
    window.vyotiq.loadRun = loadRun
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
