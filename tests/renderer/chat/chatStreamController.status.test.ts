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
  it('scopes network_wait reconnecting to the current turn only', async () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.hydrateTranscript([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply-1' },
      { role: 'user', content: 'second' }
    ])

    const priorAssistant = controller.items.find(
      (item) => item.kind === 'message' && item.role === 'assistant'
    )
    expect(priorAssistant?.kind).toBe('message')

    controller.handleEvent({ type: 'status', runId: 'r1', status: 'running', invokeId: 1 })
    controller.handleEvent({ type: 'text_delta', runId: 'r1', text: 'streaming', invokeId: 1 })
    await flushStreamPatches()

    const currentAssistant = controller.items.find(
      (item) => item.kind === 'message' && item.role === 'assistant' && item.content === 'streaming'
    )
    expect(currentAssistant?.kind).toBe('message')

    controller.handleEvent({
      type: 'network_wait',
      runId: 'r1',
      attempt: 1,
      maxAttempts: 5,
      retryInMs: 1000
    })

    const priorAfter = controller.items.find((item) => item.id === priorAssistant?.id)
    const currentAfter = controller.items.find((item) => item.id === currentAssistant?.id)
    expect(priorAfter?.kind === 'message' ? priorAfter.reconnecting : undefined).toBeFalsy()
    expect(currentAfter?.kind === 'message' ? currentAfter.reconnecting : undefined).toBe(true)
  })

  it("carries the provider's reason for a wait into networkWait state", () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r2' })
    controller.handleEvent({ type: 'status', runId: 'r2', status: 'running', invokeId: 1 })
    controller.handleEvent({
      type: 'network_wait',
      runId: 'r2',
      attempt: 7,
      maxAttempts: 0,
      retryInMs: 30000,
      code: 'PROVIDER_HTTP',
      message: '5-hour usage limit reached. Resets in 3hr 16min.'
    })

    // Without this the UI shows an unexplained retry loop for hours.
    expect(controller.networkWait?.message).toBe(
      '5-hour usage limit reached. Resets in 3hr 16min.'
    )
    expect(controller.networkWait?.code).toBe('PROVIDER_HTTP')
    expect(controller.networkWait?.maxAttempts).toBe(0)
  })

  it('leaves networkWait.message unset when the provider gave no reason', () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r3' })
    controller.handleEvent({ type: 'status', runId: 'r3', status: 'running', invokeId: 1 })
    controller.handleEvent({
      type: 'network_wait',
      runId: 'r3',
      attempt: 1,
      maxAttempts: 5,
      retryInMs: 1000
    })
    expect(controller.networkWait?.message).toBeUndefined()
  })


  it('skips advisory token_cost_hint from runNotice', () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })

    controller.handleEvent({
      type: 'token_cost_hint',
      runId: 'r1',
      kind: 'long_run_task_boundary',
      message: 'Long run — consider /clear between unrelated tasks.'
    })
    expect(controller.runNotice).toBeNull()
    expect(controller.costHint).toBe('Long run — consider /clear between unrelated tasks.')

    controller.handleEvent({
      type: 'token_cost_hint',
      runId: 'r1',
      kind: 'high_thinking_on_long_run',
      message: 'High thinking on a long run — consider Lower.'
    })
    expect(controller.runNotice).toBeNull()
    expect(controller.costHint).toBe('High thinking on a long run — consider Lower.')

    controller.handleEvent({ type: 'compaction_started', runId: 'r1', mode: 'auto' })
    expect(controller.compacting).toBe(true)
    expect(controller.runNotice).toBeNull()

    controller.handleEvent({
      type: 'compaction_verifying',
      runId: 'r1',
      summary: 'draft fold'
    })
    expect(controller.compacting).toBe(true)
    const verifying = controller.items.find((item) => item.kind === 'compaction')
    expect(verifying?.kind === 'compaction' ? verifying.verifyStatus : null).toBe('verifying')

    controller.handleEvent({
      type: 'compaction',
      runId: 'r1',
      summary: 'summarized',
      kind: 'summary',
      verified: true,
      verifyCoverage: 1
    })
    expect(controller.compacting).toBe(false)
    expect(controller.runNotice).toBeNull()
    const first = controller.items.find((item) => item.kind === 'compaction')
    expect(first?.kind === 'compaction' ? first.summary : null).toBe('summarized')
    expect(first?.kind === 'compaction' ? first.verifyStatus : null).toBe('verified')
    expect(first?.kind === 'compaction' ? first.at : null).toMatch(/^\d{4}-/)

    controller.handleEvent({
      type: 'compaction',
      runId: 'r1',
      summary: 'Another fold',
      kind: 'summary'
    })
    expect(controller.runNotice).toBeNull()
    expect(
      controller.items.filter((item) => item.kind === 'compaction').map((item) =>
        item.kind === 'compaction' ? item.summary : ''
      )
    ).toEqual(['summarized', 'Another fold'])
  })
  it('keeps the latest terminal outcome explicit for the transcript', () => {
    const cancelled = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    cancelled.handleEvent({ type: 'status', runId: 'r1', status: 'running' })
    expect(cancelled.turnStatus).toBeNull()
    cancelled.handleEvent({ type: 'status', runId: 'r1', status: 'cancelled' })
    expect(cancelled.turnStatus).toBe('cancelled')

    const failed = createChatStreamController({ workspacePath: '/ws', runId: 'r2' })
    failed.handleEvent({ type: 'status', runId: 'r2', status: 'running' })
    failed.handleEvent({ type: 'status', runId: 'r2', status: 'error' })
    expect(failed.turnStatus).toBe('error')

    const completed = createChatStreamController({ workspacePath: '/ws', runId: 'r3' })
    completed.handleEvent({ type: 'status', runId: 'r3', status: 'running' })
    completed.handleEvent({ type: 'status', runId: 'r3', status: 'done' })
    expect(completed.turnStatus).toBe('done')
  })

  it('marks a recovered run as interrupted when disk still says it was running', () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.hydrateTranscript([{ role: 'user', content: 'unfinished' }], [
      {
        at: '2026-08-12T00:00:00.000Z',
        event: { type: 'status', runId: 'r1', status: 'running' }
      }
    ])

    expect(controller.turnStatus).toBe('interrupted')
  })
  it('hydrate clears stale incomplete/error after a later successful turn', () => {
    const chatCancel = vi.fn().mockResolvedValue({ ok: true, data: undefined })
    // @ts-expect-error test bridge
    window.vyotiq = { ...(window.vyotiq as object), chatCancel }
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.loadTranscript(
      [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'partial' },
        { role: 'user', content: 'continue' },
        { role: 'assistant', content: 'done' }
      ],
      [
        {
          at: '2026-08-09T10:00:00.000Z',
          event: { type: 'status', runId: 'r1', status: 'running' }
        },
        {
          at: '2026-08-09T10:00:01.000Z',
          event: {
            type: 'incomplete',
            runId: 'r1',
            reason: 'max_steps',
            message: 'Stopped at step limit.'
          }
        },
        {
          at: '2026-08-09T10:00:02.000Z',
          event: { type: 'error', runId: 'r1', message: 'Boom', code: 'AGENT_LOOP' }
        },
        {
          at: '2026-08-09T10:00:03.000Z',
          event: { type: 'status', runId: 'r1', status: 'error' }
        },
        {
          at: '2026-08-09T10:01:00.000Z',
          event: { type: 'status', runId: 'r1', status: 'running' }
        },
        {
          at: '2026-08-09T10:01:05.000Z',
          event: { type: 'status', runId: 'r1', status: 'done' }
        }
      ]
    )
    expect(controller.incomplete).toBeNull()
    expect(controller.error).toBeNull()
  })
  it('applies agent_instance_update after parent turn ends (ignoreStreamEvents)', () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'running', invokeId: 1 })
    controller.handleEvent({
      type: 'agent_instance_update',
      runId: 'r1',
      parentRunId: 'r1',
      instanceRunId: 'child-1',
      phase: 'started',
      goal: 'work',
      invokeId: 1
    })
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'done', invokeId: 1 })
    expect(controller.agentInstances['child-1']?.phase).toBe('started')

    controller.handleEvent({
      type: 'agent_instance_update',
      runId: 'r1',
      parentRunId: 'r1',
      instanceRunId: 'child-1',
      phase: 'done',
      summary: 'ok'
    })
    expect(controller.agentInstances['child-1']?.phase).toBe('done')
    expect(controller.agentInstances['child-1']?.summary).toBe('ok')
  })

  it('applies agent_instance_update even when invokeId is superseded', async () => {
    const chatStart = vi.fn().mockResolvedValue({ ok: true, data: { runId: 'r1', invokeId: 2 } })
    // @ts-expect-error test bridge
    window.vyotiq = { ...(window.vyotiq as object), chatStart }

    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.hydrateTranscript([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' }
    ])
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'running', invokeId: 1 })
    controller.handleEvent({
      type: 'agent_instance_update',
      runId: 'r1',
      parentRunId: 'r1',
      instanceRunId: 'child-sup',
      phase: 'started',
      goal: 'work',
      invokeId: 1
    })
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'done', invokeId: 1 })

    // New parent turn supersedes invoke 1.
    const ok = await controller.send('follow up')
    expect(ok).toBe(true)
    expect(controller.agentInstances['child-sup']?.phase).toBe('started')

    // Stale invokeId on late child terminal must still update the card.
    controller.handleEvent({
      type: 'agent_instance_update',
      runId: 'r1',
      parentRunId: 'r1',
      instanceRunId: 'child-sup',
      phase: 'done',
      summary: 'finished after supersede',
      invokeId: 1
    })
    expect(controller.agentInstances['child-sup']?.phase).toBe('done')
    expect(controller.agentInstances['child-sup']?.summary).toBe('finished after supersede')
  })
})
