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
})
