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
  it('confirms before discarding queued follow-ups on stop', async () => {
    const chatCancel = vi.fn().mockResolvedValue({ ok: true, data: true })
    // @ts-expect-error test bridge
    window.vyotiq = { chatCancel }

    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'running' })
    controller.handleEvent({
      type: 'follow_up_queued',
      runId: 'r1',
      id: 'fu-1',
      position: 1,
      queueLength: 1,
      preview: 'Keep this request'
    })

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    try {
      await controller.stop()
      expect(confirm).toHaveBeenCalledWith('Stop this run and discard 1 queued follow-up?')
      expect(chatCancel).not.toHaveBeenCalled()
      expect(controller.pendingFollowUps).toHaveLength(1)

      confirm.mockReturnValue(true)
      await controller.stop()
      expect(chatCancel).toHaveBeenCalledWith('r1')
      expect(controller.pendingFollowUps).toHaveLength(0)
    } finally {
      confirm.mockRestore()
    }
  })

  it('stop during pending continuing start keeps the session and does not closeRun', async () => {
    let resolveStart!: (value: { ok: true; data: { runId: string; invokeId: number } }) => void
    const chatStart = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve
        })
    )
    const chatCancel = vi.fn().mockResolvedValue({ ok: true, data: undefined })
    // @ts-expect-error test bridge
    window.vyotiq = { ...(window.vyotiq as object), chatStart, chatCancel }

    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.hydrateTranscript([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' }
    ])

    const sendPromise = controller.send('next')
    await Promise.resolve()
    expect(controller.pendingRun || controller.running).toBe(true)

    await controller.stop()
    resolveStart({ ok: true, data: { runId: 'r1', invokeId: 42 } })
    const ok = await sendPromise

    expect(ok).toBe(true)
    expect(controller.runId).toBe('r1')
    expect(controller.running).toBe(false)
    expect(chatCancel).toHaveBeenCalledWith('r1')

    // A later send must still be able to continue the same run (not blacklisted).
    chatStart.mockResolvedValue({ ok: true, data: { runId: 'r1', invokeId: 43 } })
    const ok2 = await controller.send('again')
    expect(ok2).toBe(true)
    expect(chatStart).toHaveBeenLastCalledWith(
      expect.objectContaining({ runId: 'r1', incremental: true })
    )
  })
  it('stop with pending follow-ups does not wipe agentInstances', async () => {
    const chatCancel = vi.fn().mockResolvedValue({ ok: true, data: undefined })
    // @ts-expect-error test bridge
    window.vyotiq = { ...(window.vyotiq as object), chatCancel }

    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'running', invokeId: 1 })
    controller.handleEvent({
      type: 'agent_instance_update',
      runId: 'r1',
      parentRunId: 'r1',
      instanceRunId: 'child-keep',
      phase: 'started',
      goal: 'keep me',
      invokeId: 1
    })
    controller.handleEvent({
      type: 'follow_up_queued',
      runId: 'r1',
      id: 'fu-1',
      position: 1,
      queueLength: 1,
      preview: 'later',
      invokeId: 1
    })
    expect(controller.pendingFollowUps.length).toBe(1)
    expect(controller.agentInstances['child-keep']?.phase).toBe('started')

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await controller.stop()
    expect(confirm).toHaveBeenCalledWith('Stop this run and discard 1 queued follow-up?')
    expect(controller.pendingFollowUps.length).toBe(0)
    expect(controller.agentInstances['child-keep']?.phase).toBe('started')
    confirm.mockRestore()
  })
})
