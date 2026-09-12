import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  askQuestionThroughRenderer,
  AGENT_QUESTION_HEARTBEAT_MS,
  cancelPendingQuestions,
  listPendingAgentQuestions,
  registerQuestionSender,
  resetAgentQuestionForTests,
  resolveAgentQuestion,
  rejectAgentQuestion
} from '@main/agent/agentQuestion'
import type { AgentQuestionRequest } from '@shared/ipc'

const REQUEST: AgentQuestionRequest = {
  requestId: 'req-1',
  runId: 'run-1',
  toolCallId: 'tool-1',
  questions: [{ id: 'q1', prompt: 'Which approach?', type: 'text' }]
}

const ANSWER = [{ questionId: 'q1', values: ['Option A'] }]

describe('agentQuestion', () => {
  beforeEach(() => {
    resetAgentQuestionForTests()
  })

  it('denies when no window is listening rather than hanging', async () => {
    await expect(
      askQuestionThroughRenderer(REQUEST, new AbortController().signal)
    ).rejects.toThrow(/none is listening/i)
  })

  it('rides the renderer round trip', async () => {
    const seen: AgentQuestionRequest[] = []
    registerQuestionSender('run-1', (request) => {
      seen.push(request)
    })

    const answers = askQuestionThroughRenderer(REQUEST, new AbortController().signal)
    await Promise.resolve()
    expect(seen).toHaveLength(1)
    expect(seen[0]!.questions[0]!.prompt).toBe('Which approach?')

    expect(resolveAgentQuestion({ requestId: 'req-1', runId: 'run-1', answers: ANSWER })).toBe(true)
    await expect(answers).resolves.toEqual(ANSWER)
  })

  it('releases a waiting prompt when the run is cancelled', async () => {
    registerQuestionSender('run-1', () => {})
    const controller = new AbortController()
    const pending = askQuestionThroughRenderer(REQUEST, controller.signal)
    await Promise.resolve()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('releases prompts left over when a run ends', async () => {
    registerQuestionSender('run-1', () => {})
    const pending = askQuestionThroughRenderer(REQUEST, new AbortController().signal)
    await Promise.resolve()
    cancelPendingQuestions('run-1')
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('lists pending questions for remount restore', async () => {
    const seen: AgentQuestionRequest[] = []
    registerQuestionSender('run-1', (request) => {
      seen.push(request)
    })
    const pending = askQuestionThroughRenderer(REQUEST, new AbortController().signal)
    await Promise.resolve()
    expect(listPendingAgentQuestions('run-1')).toEqual([REQUEST])
    expect(listPendingAgentQuestions('other')).toEqual([])

    // Re-registering re-pushes still-pending questions.
    registerQuestionSender('run-1', (request) => {
      seen.push(request)
    })
    expect(seen).toHaveLength(2)

    expect(
      resolveAgentQuestion({
        requestId: 'req-1',
        runId: 'run-1',
        answers: [{ questionId: 'q1', values: ['yes'] }]
      })
    ).toBe(true)
    await expect(pending).resolves.toEqual([{ questionId: 'q1', values: ['yes'] }])
    expect(listPendingAgentQuestions('run-1')).toEqual([])
  })

  it('rejects resolve when runId does not match pending entry', async () => {
    registerQuestionSender('run-1', () => {})
    const pending = askQuestionThroughRenderer(REQUEST, new AbortController().signal)
    await Promise.resolve()
    expect(
      resolveAgentQuestion({
        requestId: 'req-1',
        runId: 'other-run',
        answers: [{ questionId: 'q1', values: ['no'] }]
      })
    ).toBe(false)
    expect(
      resolveAgentQuestion({
        requestId: 'req-1',
        runId: 'run-1',
        answers: [{ questionId: 'q1', values: ['yes'] }]
      })
    ).toBe(true)
    await expect(pending).resolves.toEqual([{ questionId: 'q1', values: ['yes'] }])
  })

  it('sanitizes answers against the asked form', async () => {
    registerQuestionSender('run-1', () => {})
    const form: AgentQuestionRequest = {
      requestId: 'req-2',
      runId: 'run-1',
      toolCallId: 'tool-2',
      questions: [
        { id: 'pick', prompt: 'Pick one', type: 'single', options: ['a', 'b'] },
        { id: 'many', prompt: 'Pick many', type: 'multi', options: ['x', 'y'] }
      ]
    }
    const pending = askQuestionThroughRenderer(form, new AbortController().signal)
    await Promise.resolve()
    expect(
      resolveAgentQuestion({
        requestId: 'req-2',
        runId: 'run-1',
        answers: [
          { questionId: 'pick', values: ['  a  ', 'b'] },
          { questionId: 'unknown', values: ['nope'] },
          { questionId: 'many', values: ['x', '', '  '] }
        ]
      })
    ).toBe(true)
    // single keeps the first trimmed value; unknown ids and empty values drop
    await expect(pending).resolves.toEqual([
      { questionId: 'pick', values: ['a'] },
      { questionId: 'many', values: ['x'] }
    ])
  })

  it('treats an all-invalid answer set as a skip', async () => {
    registerQuestionSender('run-1', () => {})
    const pending = askQuestionThroughRenderer(REQUEST, new AbortController().signal)
    await Promise.resolve()
    expect(
      resolveAgentQuestion({
        requestId: 'req-1',
        runId: 'run-1',
        answers: [{ questionId: 'nope', values: ['x'] }]
      })
    ).toBe(true)
    await expect(pending).resolves.toEqual([])
  })

  it('rejects invalid IPC payload immediately instead of waiting for timeout', async () => {
    registerQuestionSender('run-1', () => {})
    const pending = askQuestionThroughRenderer(REQUEST, new AbortController().signal)
    await Promise.resolve()
    expect(
      rejectAgentQuestion({
        requestId: 'req-1',
        runId: 'run-1',
        reason: 'questions required'
      })
    ).toBe(true)
    await expect(pending).rejects.toThrow(/AGENT_QUESTION_INVALID|invalid agent question/i)
  })

  it('rejects by runId alone when requestId is missing from malformed payload', async () => {
    registerQuestionSender('run-1', () => {})
    const pending = askQuestionThroughRenderer(REQUEST, new AbortController().signal)
    await Promise.resolve()
    expect(
      rejectAgentQuestion({
        runId: 'run-1',
        reason: 'Invalid agent question payload'
      })
    ).toBe(true)
    await expect(pending).rejects.toThrow(/AGENT_QUESTION_INVALID|invalid agent question/i)
  })

  it('rejects by requestId alone when runId is missing from malformed payload', async () => {
    registerQuestionSender('run-1', () => {})
    const pending = askQuestionThroughRenderer(REQUEST, new AbortController().signal)
    await Promise.resolve()
    expect(
      rejectAgentQuestion({
        requestId: 'req-1',
        reason: 'Invalid agent question payload'
      })
    ).toBe(true)
    await expect(pending).rejects.toThrow(/AGENT_QUESTION_INVALID|invalid agent question/i)
  })

  it('returns false for reject-by-runId when nothing is pending', () => {
    expect(rejectAgentQuestion({ runId: 'run-1', reason: 'orphan' })).toBe(false)
  })

  it('waits indefinitely for the user answer (no auto-deny timeout)', async () => {
    vi.useFakeTimers()
    try {
      registerQuestionSender('run-1', () => {})
      const pending = askQuestionThroughRenderer(REQUEST, new AbortController().signal)
      // No answer timeout (run-stopping cap removed): advancing past the old
      // 15-minute auto-deny must NOT settle the question.
      await vi.advanceTimersByTimeAsync(900_000 + 1)
      let settled = false
      void pending.then(() => {
        settled = true
      })
      await Promise.resolve()
      expect(settled).toBe(false)
      expect(resolveAgentQuestion({ requestId: 'req-1', runId: 'run-1', answers: ANSWER })).toBe(
        true
      )
      await expect(pending).resolves.toEqual(ANSWER)
    } finally {
      vi.useRealTimers()
    }
  })

  it('emits a debug heartbeat while waiting and clears on resolve', async () => {
    vi.useFakeTimers()
    const debug = vi.fn()
    const info = vi.fn()
    const { setLoggerBackend, getLoggerBackend } = await import('@shared/logger')
    const prev = getLoggerBackend()
    setLoggerBackend({
      log: (level, message, fields) => {
        if (level === 'debug') debug(message, fields)
        if (level === 'info') info(message, fields)
      }
    })
    try {
      registerQuestionSender('run-1', () => {})
      const pending = askQuestionThroughRenderer(REQUEST, new AbortController().signal)
      await Promise.resolve()
      expect(info).toHaveBeenCalledWith(
        'Agent question waiting for user',
        expect.objectContaining({ code: 'AGENT_QUESTION_WAIT', correlationId: 'run-1', id: 'req-1' })
      )
      await vi.advanceTimersByTimeAsync(AGENT_QUESTION_HEARTBEAT_MS)
      expect(debug).toHaveBeenCalledWith(
        'Agent question still waiting',
        expect.objectContaining({ code: 'AGENT_QUESTION_WAIT', id: 'req-1' })
      )
      expect(resolveAgentQuestion({ requestId: 'req-1', runId: 'run-1', answers: ANSWER })).toBe(
        true
      )
      await expect(pending).resolves.toEqual(ANSWER)
      debug.mockClear()
      await vi.advanceTimersByTimeAsync(AGENT_QUESTION_HEARTBEAT_MS)
      expect(debug).not.toHaveBeenCalled()
    } finally {
      setLoggerBackend(prev)
      vi.useRealTimers()
    }
  })
})
