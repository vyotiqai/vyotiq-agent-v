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
    window.vyotiq.loadRun = loadRun
    window.vyotiq.loadRunEvents = loadRunEvents
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
})
