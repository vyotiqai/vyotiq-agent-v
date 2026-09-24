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

  it('editAndResend sends the original target at as targetUserAt, not the fresh edit timestamp', async () => {
    const chatRewindAndStart = vi.fn().mockResolvedValue({
      ok: true,
      data: { runId: 'r1', invokeId: 2 }
    })
    const chatCancel = vi.fn().mockResolvedValue({ ok: true, data: true })
    // @ts-expect-error test bridge
    window.vyotiq = { chatRewindAndStart, chatCancel }

    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.hydrateTranscript([
      { role: 'user', content: 'first', at: '2026-01-01T00:00:00.000Z' },
      { role: 'assistant', content: 'reply-1' },
      { role: 'user', content: 'second', at: '2026-01-02T00:00:00.000Z' },
      { role: 'assistant', content: 'reply-2' }
    ])

    const ok = await controller.editAndResend(2, 'second edited')
    expect(ok).toBe(true)
    expect(chatRewindAndStart).toHaveBeenCalledWith(
      expect.objectContaining({
        editMessageIndex: 2,
        // Main resolves this against messages.jsonl; the edited message's fresh
        // `at` does not exist on disk and would fail the rewind.
        targetUserAt: '2026-01-02T00:00:00.000Z'
      })
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
        skipped: [],
        edited: ['b.ts']
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
    // The file changed since the agent wrote it comes back as left alone.
    expect(ok).toEqual({ restored: ['a.ts'], skipped: [], edited: ['b.ts'] })
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

  it('retries a transient chatStart failure but not a settled refusal', async () => {
    vi.useFakeTimers()
    try {
      const transient = vi.fn().mockResolvedValue({ ok: false, error: 'boom' })
      // @ts-expect-error test bridge
      window.vyotiq = { ...(window.vyotiq as object), chatStart: transient }
      const a = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
      const transientSend = a.send('hello')
      await vi.runAllTimersAsync()
      await transientSend
      expect(transient).toHaveBeenCalledTimes(3)

      // A binding refusal is a fact about the run: the same payload gets the
      // same answer, so re-sending it only repeats the error in the log.
      const settled = vi.fn().mockResolvedValue({
        ok: false,
        error: 'Existing run teammate binding cannot be changed',
        code: 'run_binding_immutable'
      })
      // @ts-expect-error test bridge
      window.vyotiq = { ...(window.vyotiq as object), chatStart: settled }
      const b = createChatStreamController({ workspacePath: '/ws', runId: 'r2' })
      const settledSend = b.send('hello')
      await vi.runAllTimersAsync()
      await settledSend
      expect(settled).toHaveBeenCalledTimes(1)
      expect(b.errorCode).toBe('run_binding_immutable')
    } finally {
      vi.useRealTimers()
    }
  })

  // A refusal that states a settled fact is just as true 500ms later; retrying
  // it three times only delays the error the user needed on the first attempt.
  // Unclassified failures (no code) still retry — see shouldRetryChatStart.
  it('does not retry a named deterministic refusal', async () => {
    const chatStart = vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'Workspace is not open', code: 'workspace_not_open' })
    const chatCancel = vi.fn().mockResolvedValue({ ok: true, data: true })
    // @ts-expect-error test bridge
    window.vyotiq = { chatStart, chatCancel }

    const controller = createChatStreamController({ workspacePath: '/ws' })
    await controller.send('hello')

    expect(chatStart).toHaveBeenCalledTimes(1)
  })

  it('does not retry a settled binding refusal', async () => {
    const chatStart = vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'bound elsewhere', code: 'run_binding_immutable' })
    const chatCancel = vi.fn().mockResolvedValue({ ok: true, data: true })
    // @ts-expect-error test bridge
    window.vyotiq = { chatStart, chatCancel }

    const controller = createChatStreamController({ workspacePath: '/ws' })
    await controller.send('hello')

    expect(chatStart).toHaveBeenCalledTimes(1)
  })

  it('clears the refused teammate binding so the next send is not refused again', async () => {
    const chatStart = vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'bound elsewhere', code: 'run_binding_immutable' })
    const chatCancel = vi.fn().mockResolvedValue({ ok: true, data: true })
    // @ts-expect-error test bridge
    window.vyotiq = { chatStart, chatCancel }

    const onAgentProfileRefused = vi.fn()
    const controller = createChatStreamController({
      workspacePath: '/ws',
      getAgentProfileId: () => 'auditer',
      onAgentProfileRefused
    })
    await controller.send('hello')

    expect(onAgentProfileRefused).toHaveBeenCalledTimes(1)
  })

  it('still retries a run that is only transiently busy', async () => {
    const chatStart = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'Run is already active', code: 'run_active' })
      .mockResolvedValue({ ok: true, data: { runId: 'r-busy', invokeId: 1 } })
    const chatCancel = vi.fn().mockResolvedValue({ ok: true, data: true })
    // @ts-expect-error test bridge
    window.vyotiq = { chatStart, chatCancel }

    const controller = createChatStreamController({ workspacePath: '/ws' })
    await controller.send('hello')

    expect(chatStart).toHaveBeenCalledTimes(2)
  })
})
