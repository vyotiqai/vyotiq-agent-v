/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import { createChatStreamController } from '@renderer/lib/hooks/createChatStreamController'
import { parseDiffPreview, parseEditCardData } from '@renderer/features/chat/toolUi'

async function flushStreamPatches(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 150))
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

describe('createChatStreamController', () => {
  it('keeps UI suspended until disk catch-up finishes so live deltas are not clobbered', async () => {
    const diskPayload = {
      ok: true as const,
      data: {
        runId: 'r1',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'from-disk' }
        ]
      }
    }
    const loadRunEvents = vi.fn().mockResolvedValue({ ok: true, data: [] })
    const listActiveRuns = vi.fn().mockResolvedValue({
      ok: true,
      data: [{ runId: 'r1', invokeId: 1, workspacePath: '/ws' }]
    })
    let controller!: ReturnType<typeof createChatStreamController>
    const loadRun = vi.fn(async () => {
      // Catch-up must still be suspended so in-flight live deltas are dropped,
      // not applied and then wiped by hydrateFromDisk.
      expect(controller.uiSuspended).toBe(true)
      controller.handleEvent({ type: 'text_delta', runId: 'r1', text: ' during', invokeId: 1 })
      expect(
        controller.items.some((i) => i.kind === 'message' && String(i.content).includes('during'))
      ).toBe(false)
      return diskPayload
    })

    window.vyotiq = {
      loadRun,
      loadRunEvents,
      listActiveRuns
    }

    controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'running', invokeId: 1 })
    controller.handleEvent({ type: 'text_delta', runId: 'r1', text: 'before', invokeId: 1 })

    controller.setUiSuspended(true)
    controller.handleEvent({ type: 'text_delta', runId: 'r1', text: ' skipped', invokeId: 1 })
    expect(controller.items.some((i) => i.kind === 'message' && i.content === 'before skipped')).toBe(
      false
    )

    await controller.resumeUiIfNeeded()

    expect(controller.uiSuspended).toBe(false)
    expect(loadRun).toHaveBeenCalledWith('/ws', 'r1')
    expect(controller.items.some((i) => i.kind === 'message' && i.content === 'from-disk')).toBe(true)
    expect(
      controller.items.some((i) => i.kind === 'message' && String(i.content).includes('during'))
    ).toBe(false)
  })

  it('catches up from disk after UI suspend even when no stream events arrived', async () => {
    const loadRun = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        runId: 'r1',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'after-gate' }
        ]
      }
    })
    const loadRunEvents = vi.fn().mockResolvedValue({ ok: true, data: [] })
    const listActiveRuns = vi.fn().mockResolvedValue({
      ok: true,
      data: [{ runId: 'r1', invokeId: 1, workspacePath: '/ws' }]
    })
    // @ts-expect-error test bridge
    window.vyotiq = { loadRun, loadRunEvents, listActiveRuns }

    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'running', invokeId: 1 })
    controller.handleEvent({ type: 'text_delta', runId: 'r1', text: 'before', invokeId: 1 })
    controller.setUiSuspended(true)
    controller.markUiCatchUpNeeded()
    await controller.resumeUiIfNeeded()

    expect(loadRun).toHaveBeenCalledWith('/ws', 'r1')
    expect(controller.uiSuspended).toBe(false)
    expect(controller.items.some((i) => i.kind === 'message' && i.content === 'after-gate')).toBe(
      true
    )
  })

  it('suspends before disk catch-up even when the caller did not suspend first', async () => {
    const diskPayload = {
      ok: true as const,
      data: {
        runId: 'r1',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'from-disk' }
        ]
      }
    }
    const loadRunEvents = vi.fn().mockResolvedValue({ ok: true, data: [] })
    const listActiveRuns = vi.fn().mockResolvedValue({
      ok: true,
      data: [{ runId: 'r1', invokeId: 1, workspacePath: '/ws' }]
    })
    let controller!: ReturnType<typeof createChatStreamController>
    const loadRun = vi.fn(async () => {
      expect(controller.uiSuspended).toBe(true)
      controller.handleEvent({ type: 'text_delta', runId: 'r1', text: ' live', invokeId: 1 })
      expect(
        controller.items.some((i) => i.kind === 'message' && String(i.content).includes('live'))
      ).toBe(false)
      return diskPayload
    })

    // @ts-expect-error test bridge
    window.vyotiq = { loadRun, loadRunEvents, listActiveRuns }

    controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'running', invokeId: 1 })
    controller.markUiCatchUpNeeded()
    await controller.resumeUiIfNeeded()

    expect(controller.uiSuspended).toBe(false)
    expect(controller.items.some((i) => i.kind === 'message' && i.content === 'from-disk')).toBe(
      true
    )
  })

  it('does not unsuspend from a concurrent resume while disk catch-up is in flight', async () => {
    const diskPayload = {
      ok: true as const,
      data: {
        runId: 'r1',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'from-disk' }
        ]
      }
    }
    const loadRunEvents = vi.fn().mockResolvedValue({ ok: true, data: [] })
    const listActiveRuns = vi.fn().mockResolvedValue({
      ok: true,
      data: [{ runId: 'r1', invokeId: 1, workspacePath: '/ws' }]
    })
    let releaseLoad: (() => void) | undefined
    let sawLoad!: () => void
    const loadStarted = new Promise<void>((resolve) => {
      sawLoad = resolve
    })
    const loadRun = vi.fn(
      () =>
        new Promise<typeof diskPayload>((resolve) => {
          sawLoad()
          releaseLoad = () => resolve(diskPayload)
        })
    )

    // @ts-expect-error test bridge
    window.vyotiq = { loadRun, loadRunEvents, listActiveRuns }

    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'running', invokeId: 1 })
    controller.setUiSuspended(true)
    controller.markUiCatchUpNeeded()
    const catchUp = controller.resumeUiIfNeeded()
    await loadStarted
    expect(controller.uiSuspended).toBe(true)

    // WM onChatEvent calls resume on every visible event; must not unsuspend early.
    await controller.resumeUiIfNeeded()
    expect(controller.uiSuspended).toBe(true)
    controller.handleEvent({ type: 'text_delta', runId: 'r1', text: ' during', invokeId: 1 })
    expect(
      controller.items.some((i) => i.kind === 'message' && String(i.content).includes('during'))
    ).toBe(false)

    releaseLoad?.()
    await catchUp
    expect(controller.uiSuspended).toBe(false)
    expect(controller.items.some((i) => i.kind === 'message' && i.content === 'from-disk')).toBe(
      true
    )
  })
})

describe('events that arrive during a catch-up', () => {
  it('applies the ones its snapshot does not hold, and only those', async () => {
    // The snapshot: the step that called c1 is on disk, its result is not yet.
    const loadRun = vi.fn(async () => {
      // Arrive while the snapshot loads.
      controller.handleEvent({ type: 'step_usage', runId: 'r1', step: 1, inputTokens: 5, outputTokens: 5, invokeId: 1, seq: 20 } as never)
      controller.handleEvent({ type: 'tool_result', runId: 'r1', toolCallId: 'c1', name: 'read', summary: 'a.ts', ok: true, content: 'body', invokeId: 1, seq: 31 })
      controller.handleEvent({ type: 'text_delta', runId: 'r1', text: 'old words', invokeId: 1, seq: 9 })
      controller.handleEvent({ type: 'text_delta', runId: 'r1', text: 'Next, ', invokeId: 1, seq: 32 })
      controller.handleEvent({ type: 'text_delta', runId: 'r1', text: 'the tests.', invokeId: 1, seq: 33 })
      return {
        ok: true as const,
        data: {
          runId: 'r1',
          messages: [
            { role: 'user', content: 'go' },
            { role: 'assistant', content: 'Reading.', toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }] }
          ]
        }
      }
    })
    const loadRunEvents = vi.fn().mockResolvedValue({
      ok: true,
      data: [
        { at: '2026-09-27T10:00:00.000Z', event: { type: 'assistant_message', runId: 'r1', content: 'Reading.', toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }], seq: 10 } },
        { at: '2026-09-27T10:00:01.000Z', event: { type: 'tool_start', runId: 'r1', toolCallId: 'c1', name: 'read', summary: 'a.ts', seq: 11 } },
        { at: '2026-09-27T10:00:01.500Z', event: { type: 'step_usage', runId: 'r1', step: 1, inputTokens: 5, outputTokens: 5, seq: 20 } }
      ]
    })
    const listActiveRuns = vi.fn().mockResolvedValue({ ok: true, data: [{ runId: 'r1', invokeId: 1, workspacePath: '/ws' }] })
    // @ts-expect-error test bridge
    window.vyotiq = { loadRun, loadRunEvents, listActiveRuns }

    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'running', invokeId: 1 })
    controller.setUiSuspended(true)
    controller.markUiCatchUpNeeded()
    await controller.resumeUiIfNeeded()
    await flushStreamPatches()

    expect(controller.uiSuspended).toBe(false)
    // The call that finished meanwhile is done, not left spinning.
    const row = controller.items.find((i) => i.kind === 'tool' && i.id === 'c1')
    expect(row?.kind === 'tool' ? [row.tool.status, row.tool.content] : null).toEqual(['done', 'body'])
    expect(controller.messages.filter((m) => m.role === 'tool')).toHaveLength(1)
    // Words from the step on disk are not repeated; the next step's are there, once.
    const words = controller.items.filter((i) => i.kind === 'message' && i.role === 'assistant').map((i) => (i.kind === 'message' ? i.content : ''))
    expect(words).toEqual(['Reading.', 'Next, the tests.'])
  })

  it('does not apply a step answer or a result the reloaded messages already hold', async () => {
    const onDisk = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'Done reading.', toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c1', toolName: 'read', content: 'body', ok: true }
    ]
    const loadRun = vi.fn(async () => {
      controller.handleEvent({ type: 'assistant_message', runId: 'r1', content: 'Done reading.', toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }], invokeId: 1, seq: 40 })
      controller.handleEvent({ type: 'tool_result', runId: 'r1', toolCallId: 'c1', name: 'read', summary: '', ok: true, content: 'body', invokeId: 1, seq: 41 })
      return { ok: true as const, data: { runId: 'r1', messages: onDisk } }
    })
    const loadRunEvents = vi.fn().mockResolvedValue({ ok: true, data: [] })
    const listActiveRuns = vi.fn().mockResolvedValue({ ok: true, data: [{ runId: 'r1', invokeId: 1, workspacePath: '/ws' }] })
    // @ts-expect-error test bridge
    window.vyotiq = { loadRun, loadRunEvents, listActiveRuns }

    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'running', invokeId: 1 })
    controller.setUiSuspended(true)
    controller.markUiCatchUpNeeded()
    await controller.resumeUiIfNeeded()
    await flushStreamPatches()

    expect(controller.messages).toHaveLength(3)
    expect(controller.items.filter((i) => i.kind === 'message' && i.role === 'assistant')).toHaveLength(1)
    expect(controller.items.filter((i) => i.kind === 'tool')).toHaveLength(1)
  })
})
