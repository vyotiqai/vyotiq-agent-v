import type {
  AgentQuestionAnswer,
  AgentQuestionRequest,
  AgentQuestionResponse
} from '../../shared/ipc'
import { logger } from '../../shared/logger'
import { sanitizeQuestionAnswers } from '../../shared/utils/agentQuestionForm'
import { dismissLifecycleNotification } from '../notifications/bus'
import { needsYouDedupeKey } from '../../shared/ipc'

export type QuestionSender = (request: AgentQuestionRequest) => void

/** Debug heartbeat while a question is parked waiting for the user (5 min — a parked prompt is expected, not an incident). */
export const AGENT_QUESTION_HEARTBEAT_MS = 300_000

/** One sender per run: question prompts belong to the window that started it. */
const senders = new Map<string, QuestionSender>()
const pending = new Map<
  string,
  {
    resolve: (answers: AgentQuestionAnswer[]) => void
    /** Clears abort listeners then rejects — used by cancelPendingQuestions. */
    cancel: (err: Error) => void
    runId: string
    invokeId?: number
    request: AgentQuestionRequest
  }
>()

function abortQuestionError(): Error {
  const err = new Error('Aborted')
  err.name = 'AbortError'
  return err
}

/**
 * Register (or replace) the window that receives question prompts for a run.
 * Re-pushes any still-pending questions so a remounted renderer can show cards.
 */
export function registerQuestionSender(runId: string, sender: QuestionSender): () => void {
  senders.set(runId, sender)
  for (const entry of pending.values()) {
    if (entry.runId === runId) sender(entry.request)
  }
  return () => {
    if (senders.get(runId) === sender) senders.delete(runId)
  }
}

/** Pending question payloads still waiting on the user for this run. */
export function listPendingAgentQuestions(runId: string): AgentQuestionRequest[] {
  const out: AgentQuestionRequest[] = []
  for (const entry of pending.values()) {
    if (entry.runId === runId) out.push(entry.request)
  }
  return out
}

/** Returns false when the request is unknown or runId does not match. */
export function resolveAgentQuestion(response: AgentQuestionResponse): boolean {
  const entry = pending.get(response.requestId)
  if (!entry) return false
  if (entry.runId !== response.runId) return false
  const answers = sanitizeQuestionAnswers(entry.request.questions, response.answers)
  entry.resolve(answers)
  dismissLifecycleNotification(needsYouDedupeKey(response.runId))
  return true
}

function invalidQuestionPayloadError(reason?: string): Error {
  const detail = reason?.trim()
  const message = detail
    ? `AGENT_QUESTION_INVALID: ${detail}`
    : 'AGENT_QUESTION_INVALID: Invalid agent question payload.'
  const err = new Error(message)
  err.name = 'AgentQuestionInvalidError'
  return err
}

/** Resolve runId for a pending question when preload only extracted requestId. */
export function pendingQuestionRunId(requestId: string): string | undefined {
  return pending.get(requestId)?.runId
}

/**
 * Preload invokes when AgentQuestionRequestSchema fails — rejects the pending
 * ask_question wait immediately instead of timing out after ~15 minutes.
 * Looks up by requestId when present; otherwise rejects pending for runId.
 */
export function rejectAgentQuestion(payload: {
  requestId?: string
  runId?: string
  reason?: string
}): boolean {
  if (payload.requestId) {
    const entry = pending.get(payload.requestId)
    if (!entry) return false
    if (payload.runId && entry.runId !== payload.runId) return false
    logger.warn('Agent question rejected — invalid IPC payload', {
      scope: 'agent',
      code: 'AGENT_QUESTION_INVALID',
      correlationId: entry.runId,
      id: payload.requestId,
      reason: payload.reason
    })
    entry.cancel(invalidQuestionPayloadError(payload.reason))
    return true
  }

  if (!payload.runId) return false

  let rejected = false
  for (const [requestId, entry] of pending) {
    if (entry.runId !== payload.runId) continue
    logger.warn('Agent question rejected — invalid IPC payload', {
      scope: 'agent',
      code: 'AGENT_QUESTION_INVALID',
      correlationId: payload.runId,
      id: requestId,
      reason: payload.reason
    })
    entry.cancel(invalidQuestionPayloadError(payload.reason))
    rejected = true
  }
  if (!rejected) {
    logger.warn('Agent question reject found no pending entry', {
      scope: 'agent',
      code: 'AGENT_QUESTION_INVALID',
      correlationId: payload.runId,
      reason: payload.reason
    })
  }
  return rejected
}

/**
 * Cancelling a run must not leave question prompts waiting forever.
 * When `invokeId` is set, only that turn's prompts are cleared.
 */
export function cancelPendingQuestions(runId: string, invokeId?: number): void {
  for (const [, entry] of pending) {
    if (entry.runId !== runId) continue
    if (invokeId !== undefined && entry.invokeId !== invokeId) continue
    entry.cancel(abortQuestionError())
  }
  dismissLifecycleNotification(needsYouDedupeKey(runId))
}

/** Dismiss open question cards without aborting the run (empty answers, same as timeout). */
export function dismissPendingQuestions(runId: string, invokeId?: number): void {
  for (const [, entry] of pending) {
    if (entry.runId !== runId) continue
    if (invokeId !== undefined && entry.invokeId !== invokeId) continue
    entry.resolve([])
  }
}

export function askQuestionThroughRenderer(
  request: AgentQuestionRequest,
  signal: AbortSignal,
  invokeId?: number
): Promise<AgentQuestionAnswer[]> {
  const sender = senders.get(request.runId)
  if (!sender) {
    logger.warn('Agent question required but no window is listening', {
      scope: 'agent',
      code: 'AGENT_QUESTION',
      correlationId: request.runId
    })
    return Promise.reject(
      new Error(
        'ask_question requires an app window but none is listening. Reopen Vyotiq and retry.'
      )
    )
  }

  return new Promise<AgentQuestionAnswer[]>((resolve, reject) => {
    // No answer timeout (run-stopping cap removed — user decision): the
    // question waits indefinitely for the user; abort/cancel still applies.
    let heartbeatId: ReturnType<typeof setInterval> | undefined
    let settled = false
    const clearWaiters = (): void => {
      if (heartbeatId !== undefined) {
        clearInterval(heartbeatId)
        heartbeatId = undefined
      }
      signal.removeEventListener('abort', onAbort)
    }
    const settle = (answers: AgentQuestionAnswer[]): void => {
      if (settled || !pending.has(request.requestId)) return
      settled = true
      pending.delete(request.requestId)
      clearWaiters()
      resolve(answers)
    }
    const cancel = (err: Error): void => {
      if (settled || !pending.has(request.requestId)) return
      settled = true
      pending.delete(request.requestId)
      clearWaiters()
      reject(err)
    }
    function onAbort(): void {
      cancel(abortQuestionError())
    }
    if (signal.aborted) {
      reject(abortQuestionError())
      return
    }
    pending.set(request.requestId, {
      resolve: settle,
      cancel,
      runId: request.runId,
      invokeId,
      request
    })
    signal.addEventListener('abort', onAbort, { once: true })
    logger.info('Agent question waiting for user', {
      scope: 'agent',
      code: 'AGENT_QUESTION_WAIT',
      correlationId: request.runId,
      id: request.requestId
    })
    heartbeatId = setInterval(() => {
      if (!pending.has(request.requestId)) return
      logger.debug('Agent question still waiting', {
        scope: 'agent',
        code: 'AGENT_QUESTION_WAIT',
        correlationId: request.runId,
        id: request.requestId
      })
    }, AGENT_QUESTION_HEARTBEAT_MS)
    sender(request)
  })
}

/** Test helper — wipe senders and pending prompts between cases. */
export function resetAgentQuestionForTests(): void {
  senders.clear()
  pending.clear()
}
