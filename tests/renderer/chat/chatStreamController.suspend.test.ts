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

    // @ts-expect-error test bridge
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
