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
  it('persists turn collapse across transcript remounts', () => {
    const controller = createChatStreamController({ workspacePath: '/ws' })

    expect(controller.collapsedTurnIndices).toEqual([])

    controller.toggleTurnCollapsed(0)
    expect(controller.collapsedTurnIndices).toEqual([0])

    controller.toggleTurnCollapsed(0)
    expect(controller.collapsedTurnIndices).toEqual([])

    controller.toggleTurnCollapsed(1)
    controller.toggleTurnCollapsed(2)
    expect(controller.collapsedTurnIndices).toEqual([1, 2])

    controller.reset()
    expect(controller.collapsedTurnIndices).toEqual([])
  })

  it('appends terminal_output_delta into a running terminal tool row', async () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })

    controller.handleEvent({
      type: 'tool_start',
      runId: 'r1',
      toolCallId: 'term-1',
      name: 'terminal',
      summary: 'echo hi'
    })
    controller.handleEvent({
      type: 'terminal_output_delta',
      runId: 'r1',
      toolCallId: 'term-1',
      text: 'hi\n',
      stream: 'stdout'
    })
    controller.handleEvent({
      type: 'terminal_output_delta',
      runId: 'r1',
      toolCallId: 'term-1',
      text: 'boom\n',
      stream: 'stderr'
    })
    await flushStreamPatches()

    const tool = controller.items.find((item) => item.kind === 'tool' && item.id === 'term-1')
    expect(tool?.kind).toBe('tool')
    if (tool?.kind !== 'tool') return
    expect(tool.tool.status).toBe('running')
    expect(tool.tool.content).toBe('hi\n\nstderr:\nboom\n')
  })

  it('batches rapid text_delta events into one items revision per frame', async () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'running', invokeId: 1 })

    const revisions: number[] = []
    const unsub = controller.subscribeItems(() => {
      revisions.push(controller.getItemsRevision())
    })

    controller.handleEvent({ type: 'text_delta', runId: 'r1', text: 'a', invokeId: 1 })
    controller.handleEvent({ type: 'text_delta', runId: 'r1', text: 'b', invokeId: 1 })
    controller.handleEvent({ type: 'text_delta', runId: 'r1', text: 'c', invokeId: 1 })
    await flushStreamPatches()

    unsub()
    expect(revisions.length).toBeLessThanOrEqual(2)
    expect(
      controller.items.some((item) => item.kind === 'message' && item.content === 'abc')
    ).toBe(true)
  })

  it('coalesces rapid tool_call_delta paints instead of one revision per chunk', async () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'running', invokeId: 1 })

    const revisions: number[] = []
    const unsub = controller.subscribeItems(() => {
      revisions.push(controller.getItemsRevision())
    })

    for (const argumentsDelta of ['{"path":"a.ts","diff":"', '@@\\n+', 'LIVE']) {
      controller.handleEvent({
        type: 'tool_call_delta',
        runId: 'r1',
        toolCallId: 'e-coalesce',
        name: 'edit',
        argumentsDelta
      })
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    expect(revisions.length).toBe(0)

    await flushStreamPatches()
    unsub()

    expect(revisions.length).toBe(1)
    const row = controller.items.find((item) => item.kind === 'tool' && item.id === 'e-coalesce')
    expect(row?.kind).toBe('tool')
    if (row?.kind !== 'tool') return
    expect(row.tool.argsPreview).toContain('LIVE')
  })

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

  it('pins the session model on first send so another session model change does not bleed in', async () => {
    let effective: { provider: 'openai' | 'anthropic'; model: string } = {
      provider: 'openai',
      model: 'gpt-a'
    }
    const chatStart = vi.fn().mockImplementation(async () => ({
      ok: true,
      data: { runId: 'r-pin', invokeId: chatStart.mock.calls.length }
    }))
    const chatCancel = vi.fn().mockResolvedValue({ ok: true, data: true })
    // @ts-expect-error test bridge
    window.vyotiq = { chatStart, chatCancel }

    const controller = createChatStreamController({
      workspacePath: '/ws',
      getDefaultProviderModel: () => effective
    })

    await controller.send('first turn')
    expect(chatStart).toHaveBeenCalledTimes(1)
    expect(chatStart).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'openai', model: 'gpt-a' })
    )
    expect(controller.providerModel).toEqual({ provider: 'openai', model: 'gpt-a' })

    controller.handleEvent({ type: 'status', runId: 'r-pin', status: 'done', invokeId: 1 })
    await flushStreamPatches()

    // A model change in a different session only moves the shared default.
    effective = { provider: 'anthropic', model: 'claude-b' }

    await controller.send('second turn')
    expect(chatStart).toHaveBeenCalledTimes(2)
    expect(chatStart).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: 'openai', model: 'gpt-a' })
    )

    // A change made in this session applies from its next turn.
    controller.setProviderModel('anthropic', 'claude-b')
    controller.handleEvent({ type: 'status', runId: 'r-pin', status: 'done', invokeId: 2 })
    await flushStreamPatches()
    await controller.send('third turn')
    expect(chatStart).toHaveBeenCalledTimes(3)
    expect(chatStart).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: 'anthropic', model: 'claude-b' })
    )
  })

  it('reset clears the session model pin back to the shared default', async () => {
    let effective: { provider: 'openai' | 'anthropic'; model: string } = {
      provider: 'openai',
      model: 'gpt-a'
    }
    const chatStart = vi.fn().mockImplementation(async () => ({
      ok: true,
      data: { runId: 'r-reset', invokeId: chatStart.mock.calls.length }
    }))
    const chatCancel = vi.fn().mockResolvedValue({ ok: true, data: true })
    // @ts-expect-error test bridge
    window.vyotiq = { chatStart, chatCancel }

    const controller = createChatStreamController({
      workspacePath: '/ws',
      getDefaultProviderModel: () => effective
    })

    await controller.send('first turn')
    expect(controller.providerModel).toEqual({ provider: 'openai', model: 'gpt-a' })

    controller.handleEvent({ type: 'status', runId: 'r-reset', status: 'done', invokeId: 1 })
    await flushStreamPatches()
    controller.reset()
    expect(controller.providerModel).toBeNull()

    effective = { provider: 'anthropic', model: 'claude-b' }
    await controller.send('fresh turn')
    expect(chatStart).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: 'anthropic', model: 'claude-b' })
    )
  })

  it('editAndResend truncates transcript and calls chatRewindAndStart', async () => {
    const chatRewindAndStart = vi.fn().mockResolvedValue({
      ok: true,
      data: { runId: 'r1', invokeId: 2 }
    })
    const chatCancel = vi.fn().mockResolvedValue({ ok: true, data: true })
    // @ts-expect-error test bridge
    window.vyotiq = { chatRewindAndStart, chatCancel }

    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.hydrateTranscript([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply-1' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'reply-2' }
    ])

    const ok = await controller.editAndResend(0, 'first edited')
    expect(ok).toBe(true)
    expect(chatRewindAndStart).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: '/ws',
        runId: 'r1',
        editMessageIndex: 0,
        editedUserMessage: expect.objectContaining({ role: 'user', content: 'first edited' })
      })
    )
    expect(controller.messages).toMatchObject([{ role: 'user', content: 'first edited' }])
    expect(controller.messages[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(controller.messages.some((m) => m.content === 'reply-2')).toBe(false)
    expect(controller.running).toBe(true)
    const editedUser = controller.items.find(
      (item) => item.kind === 'message' && item.role === 'user'
    )
    expect(editedUser?.kind === 'message' ? editedUser.at : undefined).toMatch(
      /^\d{4}-\d{2}-\d{2}T/
    )
  })

  it('editAndResend keeps prior user at timestamps for earlier turns', async () => {
    const chatRewindAndStart = vi.fn().mockResolvedValue({
      ok: true,
      data: { runId: 'r1', invokeId: 2 }
    })
    const chatCancel = vi.fn().mockResolvedValue({ ok: true, data: true })
    // @ts-expect-error test bridge
    window.vyotiq = { chatRewindAndStart, chatCancel }

    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.hydrateTranscript([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply-1' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'reply-2' }
    ])
    const firstUser = controller.items.find(
      (item) => item.kind === 'message' && item.role === 'user' && item.content === 'first'
    )
    expect(firstUser?.kind).toBe('message')
    if (firstUser?.kind === 'message') {
      firstUser.at = '2026-01-01T00:00:00.000Z'
    }

    const ok = await controller.editAndResend(2, 'second edited')
    expect(ok).toBe(true)
    const keptFirst = controller.items.find(
      (item) => item.kind === 'message' && item.role === 'user' && item.content === 'first'
    )
    expect(keptFirst?.kind === 'message' ? keptFirst.at : undefined).toBe(
      '2026-01-01T00:00:00.000Z'
    )
    const edited = controller.items.find(
      (item) => item.kind === 'message' && item.role === 'user' && item.content === 'second edited'
    )
    expect(edited?.kind === 'message' ? edited.at : undefined).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('editAndResend rolls back UI when chatRewindAndStart fails', async () => {
    const chatRewindAndStart = vi.fn().mockResolvedValue({
      ok: false,
      error: 'rewind failed'
    })
    const chatCancel = vi.fn().mockResolvedValue({ ok: true, data: true })
    // @ts-expect-error test bridge
    window.vyotiq = { chatRewindAndStart, chatCancel }

    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    const prior = [
      { role: 'user' as const, content: 'keep me' },
      { role: 'assistant' as const, content: 'stay' },
      { role: 'user' as const, content: 'edit me' },
      { role: 'assistant' as const, content: 'drop on success' }
    ]
    controller.hydrateTranscript(prior)

    const ok = await controller.editAndResend(2, 'edited')
    expect(ok).toBe(false)
    expect(controller.messages).toEqual(prior)
    expect(controller.error).toBe('rewind failed')
    expect(controller.running).toBe(false)
  })

  it('revertToUserMessage truncates transcript and calls chatRewind without starting run', async () => {
    const chatRewind = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'reply-1' }
        ],
        restored: ['a.ts'],
        skipped: []
      }
    })
    // @ts-expect-error test bridge
    window.vyotiq = { chatRewind }

    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.hydrateTranscript([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply-1' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'reply-2' }
    ])

    const ok = await controller.revertToUserMessage(0)
    expect(ok).toEqual({ restored: ['a.ts'], skipped: [] })
    expect(chatRewind).toHaveBeenCalledWith({
      workspacePath: '/ws',
      runId: 'r1',
      userMessageIndex: 0
    })
    expect(controller.messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply-1' }
    ])
    expect(controller.running).toBe(false)
    expect(controller.pendingRun).toBe(false)
  })

  it('revertToUserMessage rolls back UI when chatRewind fails', async () => {
    const chatRewind = vi.fn().mockResolvedValue({
      ok: false,
      error: 'rewind failed'
    })
    // @ts-expect-error test bridge
    window.vyotiq = { chatRewind }

    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    const prior = [
      { role: 'user' as const, content: 'first' },
      { role: 'assistant' as const, content: 'reply-1' },
      { role: 'user' as const, content: 'second' },
      { role: 'assistant' as const, content: 'reply-2' }
    ]
    controller.hydrateTranscript(prior)

    const ok = await controller.revertToUserMessage(0)
    expect(ok).toBe(false)
    expect(controller.messages).toEqual(prior)
    expect(controller.error).toBe('rewind failed')
  })

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

  it('clears stale overflow on applyManualCompaction', () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({
      type: 'context_usage',
      runId: 'r1',
      step: 2,
      estimatedTokens: 90_000,
      inputTokens: 90_000,
      contextWindow: 128_000,
      contentWindow: 85_000,
      compactionTrigger: 85_000,
      source: 'provider',
      overflow: true,
      layers: { system: 5_000, history: 70_000, tools: 5_000, buffer: 19_200 }
    })
    expect(controller.getContextUsage()?.overflow).toBe(true)

    controller.setCompacting(true)
    expect(controller.compacting).toBe(true)

    controller.applyManualCompaction({
      summary: 'Prior turns covered the auth refactor.',
      tokenEstimate: 800,
      estimatedTokens: 12_000,
      contextWindow: 128_000,
      contentWindow: 85_000
    })
    expect(controller.compacting).toBe(false)
    expect(controller.runNotice).toBeNull()
    const compactItem = controller.items.find((item) => item.kind === 'compaction')
    expect(compactItem?.kind === 'compaction' ? compactItem.summary : null).toBe(
      'Prior turns covered the auth refactor.'
    )
    expect(compactItem?.kind === 'compaction' ? compactItem.at : null).toMatch(/^\d{4}-/)
    const usage = controller.getContextUsage()
    expect(usage?.overflow).toBe(false)
    expect(usage?.used).toBe(12_000)
    expect(usage?.source).toBe('estimate')
  })

  it('does not keep idle hydrate compacting from a leftover compaction_started', () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.hydrateTranscript([{ role: 'user', content: 'hi' }], [
      {
        at: '2026-08-12T00:00:00.000Z',
        event: { type: 'compaction_started', runId: 'r1', mode: 'manual' }
      }
    ])
    expect(controller.compacting).toBe(false)
    expect(controller.runNotice).toBeNull()
    expect(controller.items.some((item) => item.kind === 'compaction')).toBe(false)
  })

  it('clears compacting and keeps a failed compact card when verification fails', () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({ type: 'compaction_started', runId: 'r1', mode: 'auto' })
    controller.handleEvent({
      type: 'compaction_verifying',
      runId: 'r1',
      summary: 'Forgot JWT'
    })
    controller.handleEvent({
      type: 'compaction_verify_retry',
      runId: 'r1',
      summary: 'Forgot JWT',
      failures: ['Missing decision: Use JWT']
    })
    expect(controller.compacting).toBe(true)
    controller.handleEvent({
      type: 'compaction_verify_failed',
      runId: 'r1',
      summary: 'Forgot JWT',
      failures: ['Missing decision: Use JWT']
    })
    expect(controller.compacting).toBe(false)
    const failed = controller.items.find((item) => item.kind === 'compaction')
    expect(failed?.kind === 'compaction' ? failed.verifyStatus : null).toBe('failed')
    expect(failed?.kind === 'compaction' ? failed.verifyFailures : null).toEqual([
      'Missing decision: Use JWT'
    ])
  })

  it('clears compacting on terminal status after an in-flight fold', () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'running' })
    controller.handleEvent({ type: 'compaction_started', runId: 'r1', mode: 'auto' })
    expect(controller.compacting).toBe(true)
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'cancelled' })
    expect(controller.compacting).toBe(false)
    expect(controller.runNotice).toBeNull()
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

  it('settles a verifying compact card when the run is cancelled', () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'running' })
    controller.handleEvent({ type: 'compaction_started', runId: 'r1', mode: 'auto' })
    controller.handleEvent({
      type: 'compaction_verifying',
      runId: 'r1',
      summary: 'draft fold'
    })
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'cancelled' })
    expect(controller.compacting).toBe(false)
    const compact = controller.items.find((item) => item.kind === 'compaction')
    expect(compact?.kind === 'compaction' ? compact.verifyStatus : null).toBe('failed')
    expect(compact?.kind === 'compaction' ? compact.id : null).not.toBe('compaction:in-flight')
    expect(compact?.kind === 'compaction' ? compact.verifyFailures : null).toEqual([
      'Summary was not applied.'
    ])
  })

  it('clears stale verifyFailures when a later verifying event has none', () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({ type: 'compaction_started', runId: 'r1', mode: 'auto' })
    controller.handleEvent({
      type: 'compaction_verify_retry',
      runId: 'r1',
      summary: 'draft',
      failures: ['Missing decision: Use JWT']
    })
    controller.handleEvent({
      type: 'compaction_verifying',
      runId: 'r1',
      summary: 'draft'
    })
    const live = controller.items.find((item) => item.kind === 'compaction')
    expect(live?.kind === 'compaction' ? live.verifyStatus : null).toBe('verifying')
    expect(live?.kind === 'compaction' ? live.verifyFailures : undefined).toBeUndefined()
  })

  it('keeps a failed compact card when a later verified fold uses the same summary', () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({
      type: 'compaction_verify_failed',
      runId: 'r1',
      summary: 'Same text',
      failures: ['Missing decision: Use JWT']
    })
    controller.handleEvent({
      type: 'compaction',
      runId: 'r1',
      summary: 'Same text',
      kind: 'summary',
      verified: true,
      verifyCoverage: 1
    })
    const cards = controller.items.filter((item) => item.kind === 'compaction')
    expect(cards).toHaveLength(2)
    expect(cards.map((item) => (item.kind === 'compaction' ? item.verifyStatus : null))).toEqual([
      'failed',
      'verified'
    ])
  })

  it('hydrates compact success as a transcript summary item, not runNotice', () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.hydrateTranscript([{ role: 'user', content: 'hi' }], [
      {
        at: '2026-08-12T00:00:00.000Z',
        event: { type: 'compaction_started', runId: 'r1', mode: 'auto' }
      },
      {
        at: '2026-08-12T00:00:01.000Z',
        event: { type: 'compaction', runId: 'r1', summary: 'folded history of auth work', kind: 'summary' }
      }
    ])
    expect(controller.compacting).toBe(false)
    expect(controller.runNotice).toBeNull()
    const compactItem = controller.items.find((item) => item.kind === 'compaction')
    expect(compactItem?.kind === 'compaction' ? compactItem.summary : null).toBe(
      'folded history of auth work'
    )
  })

  it('merges unresolved writes_checkpoint rows on hydrate', async () => {
    const listActiveRuns = vi.fn().mockResolvedValue({ ok: true, data: [] })
    const loadRun = vi.fn().mockResolvedValue({
      ok: true,
      data: { messages: [], status: 'done' }
    })
    const loadRunEvents = vi.fn().mockResolvedValue({
      ok: true,
      data: [
        {
          at: '2026-01-01T00:00:00.000Z',
          event: {
            type: 'writes_checkpoint',
            runId: 'r1',
            checkpointId: 'cp-old',
            files: [{ path: 'a.ts', action: 'modified', undoable: true }]
          }
        },
        {
          at: '2026-01-02T00:00:00.000Z',
          event: {
            type: 'writes_checkpoint',
            runId: 'r1',
            checkpointId: 'cp-new',
            files: [{ path: 'b.ts', action: 'modified', undoable: true }]
          }
        }
      ]
    })
    // @ts-expect-error test bridge
    window.vyotiq.listActiveRuns = listActiveRuns
    // @ts-expect-error test bridge
    window.vyotiq.loadRun = loadRun
    // @ts-expect-error test bridge
    window.vyotiq.loadRunEvents = loadRunEvents

    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    await controller.syncFromDisk('r1')

    expect(controller.writeCheckpoint?.checkpointId).toBe('cp-new')
    expect(controller.writeCheckpoint?.files.map((f) => f.path).sort()).toEqual(['a.ts', 'b.ts'])
    expect(controller.runId).toBe('r1')
  })

  it('preserves session runId when chatStart fails on a continuing run', async () => {
    vi.useFakeTimers()
    try {
      const chatStart = vi.fn().mockResolvedValue({ ok: false, error: 'boom' })
      // @ts-expect-error test bridge
      window.vyotiq = { ...(window.vyotiq as object), chatStart }

      const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
      controller.hydrateTranscript([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'yo' }
      ])

      const sendPromise = controller.send('next')
      await vi.runAllTimersAsync()
      const ok = await sendPromise
      expect(ok).toBe(false)
      expect(controller.runId).toBe('r1')
      expect(controller.running).toBe(false)
      expect(controller.error).toBe('boom')
      expect(controller.turnUsage).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('surfaces chatStart error text without rewriting it', async () => {
    vi.useFakeTimers()
    try {
      const chatStart = vi.fn().mockResolvedValue({
        ok: false,
        error: 'Provider unavailable',
        code: 'PROVIDER_ERROR'
      })
      // @ts-expect-error test bridge
      window.vyotiq = { ...(window.vyotiq as object), chatStart }

      const controller = createChatStreamController({ workspacePath: '/ws' })
      const sendPromise = controller.send('hello')
      await vi.runAllTimersAsync()
      const ok = await sendPromise
      expect(ok).toBe(false)
      expect(controller.error).toBe('Provider unavailable')
      expect(controller.errorCode).toBe('PROVIDER_ERROR')
      expect(controller.turnUsage).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

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

  it('hydrate clears stale incomplete/error after a later successful turn', () => {
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

  it('streams edit argsPreview so parseDiffPreview grows before JSON closes', async () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'running', invokeId: 1 })

    const full = JSON.stringify({
      path: 'src/live.ts',
      diff: ['@@', '-old', '+first', '+second', '+third'].join('\n')
    })
    // Chunk like a provider: small JSON fragments that stay invalid until the end.
    const chunks = [full.slice(0, 28), full.slice(28, 48), full.slice(48, 70), full.slice(70)]
    expect(chunks.join('')).toBe(full)

    controller.handleEvent({
      type: 'tool_start',
      runId: 'r1',
      toolCallId: 'edit-live',
      name: 'edit',
      summary: ''
    })

    let prev = 0
    for (const argumentsDelta of chunks) {
      controller.handleEvent({
        type: 'tool_call_delta',
        runId: 'r1',
        toolCallId: 'edit-live',
        name: 'edit',
        argumentsDelta
      })
      await flushStreamPatches()

      const row = controller.items.find((item) => item.kind === 'tool' && item.id === 'edit-live')
      expect(row?.kind).toBe('tool')
      if (row?.kind !== 'tool') return
      expect(row.tool.status).toBe('running')
      expect(row.tool.argsPreview?.length).toBeGreaterThan(0)

      const lines = parseDiffPreview(row.tool)
      expect(lines.length).toBeGreaterThanOrEqual(prev)
      prev = lines.length
    }

    expect(prev).toBeGreaterThanOrEqual(3)
    const finalRow = controller.items.find((item) => item.kind === 'tool' && item.id === 'edit-live')
    expect(finalRow?.kind).toBe('tool')
    if (finalRow?.kind !== 'tool') return
    expect(finalRow.tool.argsPreview).toBe(full)
    const finalLines = parseDiffPreview(finalRow.tool)
    expect(finalLines.some((l) => l.kind === 'add' && l.text === 'third')).toBe(true)
    expect(finalLines.some((l) => l.kind === 'del' && l.text === 'old')).toBe(true)
  })

  it('path-only argsPreview stays empty for parseDiffPreview until diff opens', async () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'running', invokeId: 1 })
    controller.handleEvent({
      type: 'tool_call_delta',
      runId: 'r1',
      toolCallId: 'edit-path',
      name: 'edit',
      argumentsDelta: ''
    })
    await flushStreamPatches()
    controller.handleEvent({
      type: 'tool_call_delta',
      runId: 'r1',
      toolCallId: 'edit-path',
      name: 'edit',
      argumentsDelta: '{"path":"src/live-stream.ts"'
    })
    await flushStreamPatches()

    const pathOnly = controller.items.find((item) => item.kind === 'tool' && item.id === 'edit-path')
    expect(pathOnly?.kind).toBe('tool')
    if (pathOnly?.kind !== 'tool') return
    expect(parseDiffPreview(pathOnly.tool)).toEqual([])
    expect(parseEditCardData(pathOnly.tool).path).toBe('src/live-stream.ts')

    controller.handleEvent({
      type: 'tool_call_delta',
      runId: 'r1',
      toolCallId: 'edit-path',
      name: 'edit',
      argumentsDelta: ',"diff":"@@\\n+LIVE_EARLY'
    })
    await flushStreamPatches()
    const mid = controller.items.find((item) => item.kind === 'tool' && item.id === 'edit-path')
    expect(mid?.kind).toBe('tool')
    if (mid?.kind !== 'tool') return
    expect(parseDiffPreview(mid.tool).some((l) => l.text === 'LIVE_EARLY')).toBe(true)
  })

  it('keeps full streaming edit args so late lines paint past the 4000-char cap', async () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'running', invokeId: 1 })
    const pad = 'x'.repeat(4500)
    controller.handleEvent({
      type: 'tool_call_delta',
      runId: 'r1',
      toolCallId: 'edit-big',
      name: 'edit',
      argumentsDelta: `{"path":"big.ts","contents":"${pad}`
    })
    await flushStreamPatches()
    controller.handleEvent({
      type: 'tool_call_delta',
      runId: 'r1',
      toolCallId: 'edit-big',
      name: 'edit',
      argumentsDelta: 'LATE_STREAM_MARK'
    })
    await flushStreamPatches()
    const row = controller.items.find((item) => item.kind === 'tool' && item.id === 'edit-big')
    expect(row?.kind).toBe('tool')
    if (row?.kind !== 'tool') return
    expect(row.tool.argsPreview?.includes('LATE_STREAM_MARK')).toBe(true)
    expect(parseDiffPreview(row.tool).some((l) => l.text.includes('LATE_STREAM_MARK'))).toBe(true)
  })

  it('does not duplicate argsPreview when a growing full JSON blob is re-sent', async () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'running', invokeId: 1 })
    const full1 = '{"path":"a.ts","diff":"'
    const full2 = '{"path":"a.ts","diff":"@@\\n+LIVE'
    controller.handleEvent({
      type: 'tool_call_delta',
      runId: 'r1',
      toolCallId: 'edit-cum',
      name: 'edit',
      argumentsDelta: full1
    })
    await flushStreamPatches()
    controller.handleEvent({
      type: 'tool_call_delta',
      runId: 'r1',
      toolCallId: 'edit-cum',
      name: 'edit',
      argumentsDelta: full2
    })
    await flushStreamPatches()
    const row = controller.items.find((item) => item.kind === 'tool' && item.id === 'edit-cum')
    expect(row?.kind).toBe('tool')
    if (row?.kind !== 'tool') return
    expect(row.tool.argsPreview).toBe(full2)
    expect(parseDiffPreview(row.tool).some((l) => l.text === 'LIVE')).toBe(true)
  })

  it('paints contents when a complete path-only JSON is replaced by path+contents', async () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'running', invokeId: 1 })
    controller.handleEvent({
      type: 'tool_call_delta',
      runId: 'r1',
      toolCallId: 'edit-snap',
      name: 'edit',
      argumentsDelta: '{"path":"plan.md"}'
    })
    await flushStreamPatches()
    const pathOnly = controller.items.find((item) => item.kind === 'tool' && item.id === 'edit-snap')
    expect(pathOnly?.kind).toBe('tool')
    if (pathOnly?.kind !== 'tool') return
    expect(parseDiffPreview(pathOnly.tool)).toEqual([])

    controller.handleEvent({
      type: 'tool_call_delta',
      runId: 'r1',
      toolCallId: 'edit-snap',
      name: 'edit',
      argumentsDelta: '{"path":"plan.md","contents":"# Plan\\nLIVE_LINE"}'
    })
    await flushStreamPatches()
    const withBody = controller.items.find((item) => item.kind === 'tool' && item.id === 'edit-snap')
    expect(withBody?.kind).toBe('tool')
    if (withBody?.kind !== 'tool') return
    expect(withBody.tool.argsPreview).toContain('LIVE_LINE')
    expect(parseDiffPreview(withBody.tool).some((l) => l.text === 'LIVE_LINE')).toBe(true)
  })

  it('demotes in-progress todo markers when the run reaches a terminal status', async () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'running', invokeId: 1 })
    controller.handleEvent({
      type: 'tool_start',
      runId: 'r1',
      toolCallId: 'todo1',
      name: 'todo_write'
    })
    controller.handleEvent({
      type: 'tool_result',
      runId: 'r1',
      toolCallId: 'todo1',
      name: 'todo_write',
      ok: true,
      summary: '1 task',
      content: '0/1 complete\n[~] (1) Ship'
    })
    await flushStreamPatches()

    controller.handleEvent({ type: 'status', runId: 'r1', status: 'done', invokeId: 1 })
    await flushStreamPatches()

    const todo = controller.items.find((item) => item.kind === 'tool' && item.id === 'todo1')
    expect(todo?.kind).toBe('tool')
    if (todo?.kind !== 'tool') return
    expect(todo.tool.content).toContain('[ ] (1) Ship')
    expect(todo.tool.content).not.toContain('[~]')
  })

  it('replaces streamed thinking with thinking_done snapshot instead of concatenating', async () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'running', invokeId: 1 })
    controller.handleEvent({ type: 'thinking_delta', runId: 'r1', text: 'AB', invokeId: 1 })
    await flushStreamPatches()
    controller.handleEvent({ type: 'thinking_done', runId: 'r1', text: 'ABC', invokeId: 1 })
    await flushStreamPatches()

    const message = controller.items.find((item) => item.kind === 'message')
    expect(message?.kind).toBe('message')
    if (message?.kind !== 'message') return
    expect(message.thinking).toBe('ABC')
    expect(message.thinking).not.toContain('AB\n\nABC')
    expect(message.thinkingStreaming).toBe(false)
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

  it('hydrates per-turn usage and starts a new slot on follow_up_applied', () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.hydrateTranscript(
      [
        { role: 'user', content: 'one', at: '2026-08-18T10:00:00.000Z' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'two', at: '2026-08-18T10:01:00.000Z' }
      ],
      [
        {
          at: '2026-08-18T10:00:05.000Z',
          event: {
            type: 'step_usage',
            runId: 'r1',
            step: 1,
            inputTokens: 100,
            outputTokens: 10,
            billedCost: 0.01
          }
        },
        {
          at: '2026-08-18T10:01:05.000Z',
          event: {
            type: 'step_usage',
            runId: 'r1',
            step: 2,
            inputTokens: 80,
            outputTokens: 8
          }
        }
      ]
    )
    expect(controller.turnUsage).toHaveLength(2)
    expect(controller.turnUsage[0]?.billedInputTokens).toBe(100)
    expect(controller.turnUsage[0]?.stepsWithCostReport).toBe(1)
    expect(controller.turnUsage[1]?.billedInputTokens).toBe(80)
    expect(controller.turnUsage[1]?.stepsWithCostReport).toBe(0)

    controller.handleEvent({
      type: 'follow_up_applied',
      runId: 'r1',
      ids: ['fu-1'],
      messages: [{ role: 'user', content: 'three', at: '2026-08-18T10:02:00.000Z' }]
    })
    expect(controller.turnUsage).toHaveLength(3)

    controller.handleEvent({
      type: 'step_usage',
      runId: 'r1',
      step: 3,
      inputTokens: 15,
      outputTokens: 1
    })
    expect(controller.turnUsage[2]?.billedInputTokens).toBe(15)
    expect(controller.turnUsage[1]?.billedInputTokens).toBe(80)
  })

  it('does not render a synthetic protocol turn from follow_up_applied', () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.hydrateTranscript([{ role: 'user', content: 'one' }], [])
    expect(controller.items.some((i) => i.kind === 'message' && i.role === 'user')).toBe(true)

    controller.handleEvent({
      type: 'follow_up_applied',
      runId: 'r1',
      ids: ['fu-goal'],
      messages: [
        {
          role: 'user',
          content: '[Goal continue] Continue the active goal until it is complete.',
          synthetic: true
        }
      ]
    })
    // The protocol turn joins model history but never renders as a user bubble.
    expect(
      controller.items.some(
        (i) => i.kind === 'message' && String(i.content).includes('Goal continue')
      )
    ).toBe(false)
    expect(controller.messages.some((m) => String(m.content).includes('Goal continue'))).toBe(true)
  })

  it('keeps hydrated run step totals when a later step_usage arrives', () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.hydrateTranscript(
      [
        { role: 'user', content: 'one', at: '2026-08-18T10:00:00.000Z' },
        { role: 'assistant', content: 'a1' }
      ],
      [
        {
          at: '2026-08-18T10:00:05.000Z',
          event: {
            type: 'step_usage',
            runId: 'r1',
            step: 1,
            inputTokens: 100,
            outputTokens: 10
          }
        }
      ]
    )
    expect(controller.getContextUsage()?.stepUsage.billedInputTokens ?? 0).toBe(0)

    controller.handleEvent({
      type: 'step_usage',
      runId: 'r1',
      step: 2,
      inputTokens: 15,
      outputTokens: 1
    })
    expect(controller.turnUsage[0]?.billedInputTokens).toBe(115)
    expect(controller.getContextUsage()?.stepUsage.billedInputTokens).toBe(115)
  })
})
