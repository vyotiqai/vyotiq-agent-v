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
  it('coalesces concurrent loadToolContent calls into a single IPC', async () => {
    const loadToolResult = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ ok: true, data: { content: 'full body' } }), 20)
        )
    )
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

    // All three calls are issued in the same tick, while the mocked IPC is
    // still pending — they must share one in-flight promise.
    let contents: Array<string | null> = []
    await act(async () => {
      contents = await Promise.all([
        result.current.loadToolContent('c1'),
        result.current.loadToolContent('c1'),
        result.current.loadToolContent('c1')
      ])
    })

    expect(contents).toEqual(['full body', 'full body', 'full body'])
    expect(loadToolResult).toHaveBeenCalledTimes(1)
    expect(loadToolResult).toHaveBeenCalledWith('/ws', 'run-disk', 'c1')
  })

  it('does not re-IPC a load that already failed this session', async () => {
    const loadToolResult = vi.fn().mockResolvedValue({
      ok: false,
      error: 'IPC_CLIENT: load failed'
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

    let first: string | null = null
    await act(async () => {
      first = await result.current.loadToolContent('c1')
    })
    expect(first).toBeNull()
    expect(loadToolResult).toHaveBeenCalledTimes(1)
    // The warn-level failure path is preserved.
    expect(result.current.items.some((i) => i.kind === 'tool' && i.tool.contentTruncated)).toBe(
      false
    )

    let second: string | null = null
    await act(async () => {
      second = await result.current.loadToolContent('c1')
    })
    expect(second).toBeNull()
    expect(loadToolResult).toHaveBeenCalledTimes(1)
  })
})
