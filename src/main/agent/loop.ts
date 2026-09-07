import { randomUUID } from 'crypto'
import type {
  AgentEvent,
  AgentInteractionMode,
  ChatMessage,
  IncompleteReason,
  ModelInfo,
  ProviderId
} from '../../shared/ipc'
import { DEFAULT_SETTINGS } from '../../shared/ipc'
import { contentDisplayText, contentToText } from '../../shared/ipc'
import { runGoalFromUserText, findAbsolutePathsInText, outsideWorkspacePathGuidance, stubPastSkillInvocationsInMessages } from '../../shared/slashCommands'
import { resolveProviderChatBaseUrl, seedModelsFor } from '../../shared/providers'
import { formatError, isAbortError } from '../../shared/errors'
import { logger, logErrorSummary } from '../../shared/logger'
import { workspaceIdFromPath } from '../../shared/workspaceId'
import {
  MAX_STREAM_ATTEMPTS,
  isRetriableStreamFailure,
  isTransientHttpFailure,
  runWithStreamRetryGen,
  shouldRetryStreamErrorChunk,
  shouldRetryThrownStreamError,
  sleepStreamRetryBackoff,
  streamRetryBackoffMsFor as streamRetryBackoffMs
} from './streamRetry'
import { isRetriableProviderMessage } from './providers/fetchWithRetry'
import { providerHttpErrorCode } from './providers/httpErrors'
import { circuitKeyProvider, isCircuitOpenError } from './circuitBreaker'
import {
  QUOTA_EXHAUSTED_STOP_CODE,
  isQuotaExhaustedMessage,
  parseQuotaResetHorizon,
  quotaExhaustedStopMessage
} from './quotaGate'
import { isNetworkFailureCode, iterateNetworkWait, resolveOfflineWaitMs } from './networkMonitor'
import { isStreamIdleTimeoutError } from './providers/sse'
import { resolveEffectiveSettings } from '../../shared/effectiveSettings'
import { resolveServiceTier } from '../../shared/domain/modelSelection'
import { stripToolShapedAssistantText } from '../../shared/transcript'
import { createApprovalGate } from './toolApproval'
import { persistAlwaysAllow } from './toolApprovalStore'
import { getSecret, hasStoredSecretBlob, secretStatus } from '@main/settings/secrets'
import { getSettings } from '@main/settings/settings'
import { findWorkspaceSettingsOverride, readWorkspacesState } from '@main/workspace/workspaces'
import { preflightChatProviderAuth } from './providers/preflight'
import {
  assembleContext,
  buildSessionEnvSection,
  contentWindow,
  contextWindowFor,
  applyFoldedMessagesWatermark,
  buildStepToolCatalog,
  shouldTriggerAutoCompact,
  type CompactionRecord
} from './context'
import { autoCompactLlmEvents } from './compactRun'
import {
  DEFAULT_AUTO_COMPACT_THRESHOLD_RATIO,
  proactiveCompactThresholdTokens
} from '../../shared/domain/contextBudget'
import { executeStepToolCalls } from './executeStepTools'
import { mergeOpenAiCompatToolArgDelta } from './toolArgWire'
import { mergeStreamedToolName } from '../../shared/utils/toolName'
import { loadHarness } from './harness'
import {
  combineLoopHints,
  loopHintForCompactionFailure,
  loopHintForCompactionVerifyFailed,
  loopHintForConsecutiveToolFailures,
  loopHintAfterCompaction,
  loopHintForIdenticalStepStreak,
  loopHintForMcpNotInCatalogFailFast,
  loopStopDecision,
  nextConsecutiveToolFailureSteps,
  nextToolFailureStreak,
  stepFailureSignature,
  MAX_TRUNCATION_CONTINUES,
  MAX_EMPTY_RESPONSE_CONTINUES,
  MAX_STEPS_PER_TURN,
  MCP_NOT_IN_CATALOG_FAIL_FAST_THRESHOLD,
  nextIdenticalStepStreak,
  runBudgetStopMessage,
  runNoticeForContextAboveSoftTrigger,
  seedKnownPathsFromMessages,
  seedMutationPathsFromMessages,
  stepToolCallsFingerprint,
  summarizeRecentToolFailure,
  type LoopStop
} from './loopPolicy'
import { disposeTerminalSessionsForInvoke } from './tools/terminalSessions'
import { getProvider } from './providers'
import { resolveModelInfo } from './modelResolve'
import { requestMaxOutputTokens } from './providers/requestLimits'
import type { ProviderReasoningState } from '../../shared/reasoning'
import {
  catalogThinkingAllowed,
  isScriptCorruptedReasoning,
  parseProviderReasoningState,
  quarantineReasoningState,
  thinkingFromReasoningState
} from '../../shared/reasoning'
import type { StopReason, TokenUsage, ToolCall } from './providers/types'
import {
  cancelRun,
  clearFollowUps,
  clearRunAbort,
  takeNextFollowUp,
  takeNextReadyFollowUp,
  hasPendingFollowUps,
  hasReadyFollowUps,
  isCurrentInvoke,
  markRunTurnComplete,
  peekFollowUps,
  registerRunAbort,
  tryBeginRunClosing,
  reopenRunTurn,
  resetActiveRunsForTests,
  setStreamInterrupt,
  streamSignalFor,
  setLateWriteCheckpoint,
  setLateFollowUpDropped,
  takePendingMode
} from './runRegistry'
import { saveFollowUps, syncFollowUpsToDisk } from './followUpStore'
import { clearLoopCheckpoint, loadLoopCheckpoint, saveLoopCheckpoint } from './loopCheckpoint'
import { LOOP_CHECKPOINT_VERSION, type LoopCheckpoint } from '../../shared/ipc/schemas/agent'
import {
  appendEvent,
  appendMessage,
  ensureUserMessageAt,
  createRun,
  loadCompaction,
  loadEventsAsync,
  loadStepUsageTotalsAsync,
  loadMessages,
  loadWorkingMessagesForFold,
  loadStatus,
  runExists,
  readContract,
  readContractAsync,
  readPlanAsync,
  readPlanRawAsync,
  resumeRun,
  saveCompaction,
  syncMessagesAsync,
  updateStatus,
  flushEventAppends,
  flushMessageAppends,
  takeEventAppendFailureNotice,
  takeMessageAppendFailureNotice,
  flushStatusWrites,
  loadMessagesAsync,
  patchLatestTodoWriteMessage,
  GOAL_SECTION_RE
} from './state'
import { enqueueMessageRewrite } from './messageAppendQueue'
import { atomicWriteFile } from '../storage/atomicWrite'
import { writeRunReceiptBestEffort } from './runReceipt'
import { writeTrajectoryArtifactsBestEffort } from './runTrajectory'
import {
  emptyStepUsageTotals,
  mergeStepUsageTotals,
  stepUsageFromEvent,
  type StepUsageTotals
} from '../../shared/utils/runTelemetry'
import {
  billedCacheHitRate,
  classifyTokenCostHotspot,
  countKeptToolResultChars,
  evaluateTokenCostWarnings,
  LARGE_STEP_INPUT_THRESHOLD,
  pushRecentLargeCacheHit,
  stepCacheHitRate,
  topToolsByCallCount
} from '../../shared/utils/tokenCost'
import { finalizeTodosOnRunEnd, formatTodosContextSection, readTodos } from './tools/todo'
import { createGoal, formatActiveGoalSection, readGoal, bumpGoalContinueCount } from './runGoal'
import { emitGoalUpdate } from './goalEvents'
import {
  formatGoalContinueMessage,
  parseGoalInvocation,
  shouldAutoContinueActiveGoal
} from '../../shared/goalRuntime'
import { toolResultEventForIpc, toolResultEventForPersistence } from '../../shared/utils/toolResultIpc'
import { AGENT_TOOLS } from './types'
import { canonicalizeAgentToolName } from './schemas/tools'
import {
  getMcpServerStatus,
  isGitMcpNotARepoError,
  listMcpToolDefinitions,
  parseMcpToolName,
  setMcpStdioWorkspace,
  syncMcpServers
} from './mcp'
import { resolveEffectiveMcpServers, resolveMcpServersForSessionMap, mcpSessionMapFingerprint } from '../marketplace/resolve'
import { buildSkillsSection, loadEnabledSkills, loadPluginRules } from './skills'
import { beginWriteCheckpoint, finalizeWriteCheckpoint } from './checkpoints'
import { isMcpToolPermitted } from '../../shared/utils/mcpToolPolicy'
import { mcpAuthAllowedForWorkspace } from '../../shared/mcpApps'
import {
  filterToolDefsForMode,
  filterToolDefsForCodeIndex,
  modeSectionMarkdown
} from './tools/modePolicy'
import { dedupeToolCalls, ensureToolCallIds } from './dedupeToolCalls'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { resolveRunDir } from '../storage/paths'
import { isSafeInstanceWorktreePath } from '../git/instanceWorktree'
import { ensurePlanStub } from './planArtifacts'
import { isPlanDraftReady, scorePlanQuality } from '../../shared/planQuality'

export { cancelRun, clearRunAbort, registerRunAbort, resetActiveRunsForTests }

/** Index of the last user message in `messages`, or undefined if none. */
function lastUserMessageIndex(messages: ChatMessage[]): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return i
  }
  return undefined
}

/**
 * Full-transcript index of the latest user message. Write-checkpoint anchors are
 * consumed by rewindWritesFrom against FULL messages.jsonl indices (the renderer
 * sends editMessageIndex from the stitched transcript), so after mid-run
 * compaction the working-set index must be offset by the folded watermark or
 * rewinds would skip restoring the turn's writes.
 */
function lastUserAnchorIndex(messages: ChatMessage[], foldedMessages: number): number | undefined {
  const workingIndex = lastUserMessageIndex(messages)
  if (workingIndex === undefined) return undefined
  return workingIndex + Math.max(0, foldedMessages)
}

function loopHintWhenContextStillLarge(
  estimatedTokens: number,
  proactiveThreshold: number
): string | undefined {
  return estimatedTokens >= proactiveThreshold
    ? runNoticeForContextAboveSoftTrigger()
    : undefined
}

/**
 * Share of the content window history must regrow before proactive auto-compaction
 * is worth retrying. Guards against re-folding an unchanged tail every step.
 */
const AUTO_COMPACT_MIN_REGROWTH_RATIO = 0.1



const CONTEXT_OVERFLOW_VERIFY_FAILED =
  'Context still exceeds the model window. Compaction produced a summary that failed verification and was not applied. Start a new chat or compact manually.'

const INCOMPLETE_MESSAGES: Record<Exclude<IncompleteReason, never>, string> = {
  truncated: 'The model hit its output token limit before finishing this turn.',
  empty_response: 'The model returned an empty response.',
  filtered: 'The provider stopped the response because of a content filter.',
  context_overflow:
    'Context still exceeds the model window after compaction. Start a new chat or compact manually.',
  network_interrupted: 'Connection lost. Retry when back online.',
  circuit_open:
    'Temporarily paused after repeated provider failures. Nothing is retried automatically — use Continue or Retry in the chat to resume once the provider is reachable.',
  provider_error: 'The provider returned an error. Review the error details, then retry.',
  goal_wait:
    'Goal is still active. Two finishes without tools — waiting for you to continue or mark complete.'
}

/** True when two messages are the same role + normalized text (resume dedupe). */
function messagesContentEqual(a: ChatMessage, b: ChatMessage): boolean {
  if (a.role !== b.role) return false
  return contentToText(a.content).trim() === contentToText(b.content).trim()
}

/**
 * Drop leading `newMessages` that were already persisted on disk (e.g. retry
 * after chatStart wrote the user turn then failed mid-stream).
 *
 * With `persistedMessageCount` the overlap is positional: the client reports
 * how many of its messages are already on disk, so a genuinely repeated
 * identical user message (a new turn) is never silently dropped. Callers
 * without a count fall back to content-suffix matching.
 */
function dedupeNewMessagesAgainstDisk(
  diskMessages: ChatMessage[],
  newMessages: ChatMessage[],
  persistedCount?: number
): ChatMessage[] {
  if (persistedCount != null) {
    const known = Math.min(Math.max(0, persistedCount), diskMessages.length)
    const overlap = diskMessages.length - known
    const count = Math.min(overlap, newMessages.length)
    if (count <= 0) return newMessages
    const diskStart = diskMessages.length - count
    const aligned = newMessages
      .slice(0, count)
      .every((message, index) => messagesContentEqual(diskMessages[diskStart + index]!, message))
    return aligned ? newMessages.slice(count) : newMessages
  }
  const maxOverlap = Math.min(diskMessages.length, newMessages.length)
  for (let count = maxOverlap; count > 0; count--) {
    const diskStart = diskMessages.length - count
    const matches = newMessages
      .slice(0, count)
      .every((message, index) => messagesContentEqual(diskMessages[diskStart + index]!, message))
    if (matches) return newMessages.slice(count)
  }
  return newMessages
}

/**
 * Classify a turn that produced no tool calls. `undefined` means the model
 * genuinely finished; anything else means it was cut short. Thinking is not a
 * user-visible answer, so a reasoning-only turn must retry rather than appear
 * to have completed successfully.
 */
function classifyIncompleteTurn(
  stopReason: StopReason | undefined,
  assistantText: string
): IncompleteReason | undefined {
  const hasVisibleAnswer = Boolean(assistantText.trim())
  if (stopReason === 'length') return 'truncated'
  if (stopReason === 'content_filter') return 'filtered'
  // tool_calls with zero parsed tools usually means truncated/malformed deltas,
  // not a genuinely empty model response.
  if (stopReason === 'tool_calls') return 'truncated'
  if (stopReason === 'error') {
    // Only label as empty when no answer was produced; partial text is truncated.
    if (!hasVisibleAnswer) return 'empty_response'
    return 'truncated'
  }
  // Providers sometimes emit `unknown` for truncated/interrupted streams.
  if (stopReason === 'unknown') {
    if (!hasVisibleAnswer) return 'empty_response'
    return 'truncated'
  }
  if (!hasVisibleAnswer) return 'empty_response'
  return undefined
}

/** Wait for connectivity and backoff before restarting a provider stream attempt. */
async function* yieldStreamRetryWait(
  runId: string,
  invokeId: number,
  step: number,
  streamAttempt: number,
  signal: AbortSignal,
  runDir: string | undefined,
  errorCode: string
): AsyncGenerator<AgentEvent, void, unknown> {
  try {
    for await (const retryInMs of iterateNetworkWait({
      signal,
      maxWaitMs: resolveOfflineWaitMs(getSettings())
    })) {
      const waitEv: AgentEvent = {
        type: 'network_wait',
        runId,
        invokeId,
        attempt: streamAttempt,
        maxAttempts: MAX_STREAM_ATTEMPTS,
        retryInMs,
        code: errorCode,
        step
      }
      if (runDir) appendEvent(runDir, waitEv)
      yield waitEv
    }
  } catch (err) {
    if (isAbortError(err)) throw err
  }

  const backoffMs = streamRetryBackoffMs(errorCode, streamAttempt)
  const backoffEv: AgentEvent = {
    type: 'network_wait',
    runId,
    invokeId,
    attempt: streamAttempt,
    maxAttempts: MAX_STREAM_ATTEMPTS,
    retryInMs: backoffMs,
    code: errorCode,
    step
  }
  if (runDir) appendEvent(runDir, backoffEv)
  yield backoffEv
  await sleepStreamRetryBackoff(signal, streamAttempt, backoffMs)
}

async function* yieldNetworkInterruptedTerminal(
  runId: string,
  invokeId: number,
  step: number,
  runDir: string | undefined,
  messages: ChatMessage[],
  assistantText: string,
  thinkingText: string,
  stepReasoningState: ProviderReasoningState | undefined,
  toolCalls: ToolCall[],
  streamedToolCalls: Map<string, ToolCall>,
  errorMessage: string,
  errorCode: string,
  flushWriteCheckpoint: () => Generator<AgentEvent, void, unknown>,
  writeStatus: (patch: { status: 'error'; error: string; resumable?: true }) => void,
  incompleteReason: Extract<
    IncompleteReason,
    'network_interrupted' | 'circuit_open' | 'provider_error'
  > = 'network_interrupted'
): AsyncGenerator<AgentEvent, void, unknown> {
  if (!runDir) return
  yield* flushPartialAssistant(
    runId,
    runDir,
    messages,
    assistantText,
    thinkingText,
    stepReasoningState,
    toolCalls,
    streamedToolCalls,
    step,
    'interrupted'
  )
  const incompleteEv: AgentEvent = {
    type: 'incomplete',
    runId,
    invokeId,
    reason: incompleteReason,
    step,
    message: INCOMPLETE_MESSAGES[incompleteReason]
  }
  appendEvent(runDir, incompleteEv)
  yield incompleteEv
  // Keep the queued follow-ups on disk — the run stops resumable, and a
  // Continue / auto-resume re-applies the queue instead of discarding it.
  yield* dropPendingFollowUps(runId, runDir, 'resumable_preserved', { preserveOnDisk: true })
  yield* emitTerminalRunError({
    runId,
    invokeId,
    runDir,
    message: errorMessage,
    code: errorCode,
    resumable: true,
    flushWriteCheckpoint,
    writeStatus
  })
}

/**
 * Shared quota-exhaustion terminal path (same contract at both stream-failure
 * sites): flush partial output, drop queued follow-ups — a quota resume is a
 * user "continue", not an automatic replay — and stop the run non-resumably.
 */
function* yieldQuotaExhaustedTerminal(
  runId: string,
  invokeId: number,
  step: number,
  runDir: string | undefined,
  messages: ChatMessage[],
  assistantText: string,
  thinkingText: string,
  stepReasoningState: ProviderReasoningState | undefined,
  toolCalls: ToolCall[],
  streamedToolCalls: Map<string, ToolCall>,
  quotaResetHorizon: string | null,
  flushWriteCheckpoint: () => Generator<AgentEvent, void, unknown>,
  writeStatus: (patch: { status: 'error'; error: string; resumable?: true }) => void
): Generator<AgentEvent, void, unknown> {
  if (!runDir) return
  yield* flushPartialAssistant(
    runId,
    runDir,
    messages,
    assistantText,
    thinkingText,
    stepReasoningState,
    toolCalls,
    streamedToolCalls,
    step,
    'interrupted'
  )
  yield* emitTerminalRunError({
    runId,
    invokeId,
    runDir,
    message: quotaExhaustedStopMessage(quotaResetHorizon),
    code: QUOTA_EXHAUSTED_STOP_CODE,
    dropFollowUpsReason: 'quota_exhausted',
    flushWriteCheckpoint,
    writeStatus
  })
}

export function createRunId(): string {
  return randomUUID()
}

function lastReasoningState(messages: ChatMessage[]): ProviderReasoningState | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    const state = parseProviderReasoningState(m.reasoningState)
    if (state) return state
  }
  return undefined
}

/** Persist and emit one user follow-up drained from the run registry.
 * @returns true when an entry was applied (callers close the turn otherwise). */
function* applyDrainedFollowUps(
  runId: string,
  runDir: string,
  messages: ChatMessage[],
  mode: 'ready' | 'next' = 'ready'
): Generator<AgentEvent, boolean> {
  const entry = mode === 'next' ? takeNextFollowUp(runId) : takeNextReadyFollowUp(runId)
  if (!entry) return false
  const message = ensureUserMessageAt(entry.message)
  messages.push(message)
  appendMessage(runDir, message)
  const ev: AgentEvent = {
    type: 'follow_up_applied',
    runId,
    ids: [entry.id],
    messages: [message]
  }
  appendEvent(runDir, ev)
  yield ev
  // Serialize the followups.json rewrite behind the queued messages.jsonl
  // append: the entry is already removed from the registry, so a crash between
  // the disk-queue rewrite and the append-chain flush would otherwise lose the
  // acknowledged follow-up from BOTH stores.
  const remaining = peekFollowUps(runId)
  void enqueueMessageRewrite(runDir, () => {
    saveFollowUps(runDir, remaining)
  })
  return true
}

/** Seed plan.md with the Goal / Steps / Done when stub — at run start and on mid-run switch to Plan. */
function seedPlanStubIfMissing(runDir: string): void {
  ensurePlanStub(runDir)
}

/**
 * Apply composer mode from chatFollowUp before the next model/tool catalog step.
 * Returns the mode when it changed so the caller can update its local agentMode.
 */
function* applyPendingModeChange(
  runId: string,
  runDir: string,
  invokeId: number,
  currentMode: AgentInteractionMode,
  writeStatus: (patch: Parameters<typeof updateStatus>[1]) => void
): Generator<AgentEvent, AgentInteractionMode> {
  const pending = takePendingMode(runId)
  if (pending == null || pending === currentMode) return currentMode
  writeStatus({ mode: pending })
  if (pending === 'plan') seedPlanStubIfMissing(runDir)
  const ev: AgentEvent = {
    type: 'mode_changed',
    runId,
    mode: pending,
    invokeId
  }
  appendEvent(runDir, ev)
  yield ev
  return pending
}

/** Notify UI and clear queued follow-ups that will never be applied. */
function* dropPendingFollowUps(
  runId: string,
  runDir: string | null | undefined,
  reason: string,
  opts?: { preserveOnDisk?: boolean }
): Generator<AgentEvent> {
  const pending = peekFollowUps(runId)
  if (pending.length === 0) {
    clearFollowUps(runId)
    return
  }
  const ids = pending.map((entry) => entry.id)
  clearFollowUps(runId)
  if (opts?.preserveOnDisk) {
    // Resumable stop: keep followups.json so a Continue / auto-resume re-applies
    // the queue. No dropped event — the tasks are preserved, not discarded.
    if (runDir) saveFollowUps(runDir, pending)
    return
  }
  if (runDir) syncFollowUpsToDisk(runDir, runId)
  const dropped: AgentEvent = {
    type: 'follow_up_dropped',
    runId,
    ids,
    reason
  }
  if (runDir) appendEvent(runDir, dropped)
  yield dropped
}

/**
 * Surface the first mid-run messages.jsonl append failure as a run error event.
 * @returns true when a failure was emitted (caller should stop the run).
 */
function* emitMessageAppendFailureNotice(
  runId: string,
  runDir: string,
  invokeId: number
): Generator<AgentEvent, boolean> {
  const err = takeMessageAppendFailureNotice(runDir)
  if (!err) return false
  const message = `Failed to persist a chat message: ${formatError(err)}`
  logger.error(message, {
    scope: 'agent',
    code: 'PERSIST',
    correlationId: runId,
    err
  })
  const ev: AgentEvent = { type: 'error', runId, invokeId, message, code: 'PERSIST' }
  appendEvent(runDir, ev)
  yield ev
  yield* dropPendingFollowUps(runId, runDir, 'PERSIST')
  return true
}

/**
 * Surface the first mid-run events.jsonl append failure as a run error event.
 * @returns true when a failure was emitted (caller should stop the run).
 */
function* emitEventAppendFailureNotice(
  runId: string,
  runDir: string,
  invokeId: number
): Generator<AgentEvent, boolean> {
  const err = takeEventAppendFailureNotice(runDir)
  if (!err) return false
  const message = `Failed to persist a run event: ${formatError(err)}`
  logger.error(message, {
    scope: 'agent',
    code: 'PERSIST',
    correlationId: runId,
    err
  })
  const ev: AgentEvent = { type: 'error', runId, invokeId, message, code: 'PERSIST' }
  appendEvent(runDir, ev)
  yield ev
  yield* dropPendingFollowUps(runId, runDir, 'PERSIST')
  return true
}

/**
 * Shared terminal-error close path so every failure site flushes the write
 * checkpoint in the same order (error → checkpoint → status).
 * Pass `emitErrorEvent: false` when the caller already yielded the error event
 * (e.g. append-failure notices).
 */
function* emitTerminalRunError(opts: {
  runId: string
  invokeId: number
  runDir: string | null | undefined
  message: string
  code?: string
  emitErrorEvent?: boolean
  dropFollowUpsReason?: string
  /**
   * Keep the queued follow-ups for the next continue instead of orphan-dropping
   * them in the run finally. Used by stops whose own message invites a
   * "continue" (runaway-step ceiling, budget exhaustion) — the user's queued
   * tasks must survive to be applied by that continue.
   */
  preserveFollowUps?: boolean
  /** When true, skip flushWriteCheckpoint (caller already flushed). */
  skipCheckpoint?: boolean
  /** Mark the run resumable so a later resume restores the loop checkpoint. */
  resumable?: boolean
  flushWriteCheckpoint: () => Generator<AgentEvent, void, unknown>
  writeStatus: (patch: { status: 'error'; error: string; resumable?: true }) => void
}): Generator<AgentEvent, void, unknown> {
  const { runId, invokeId, runDir, message, code, flushWriteCheckpoint, writeStatus } = opts
  const emitError = opts.emitErrorEvent !== false && code != null
  if (opts.dropFollowUpsReason) {
    yield* dropPendingFollowUps(runId, runDir, opts.dropFollowUpsReason)
  } else if (opts.preserveFollowUps) {
    yield* dropPendingFollowUps(runId, runDir, 'run_ended', { preserveOnDisk: true })
  }
  if (emitError) {
    yield { type: 'error', runId, invokeId, message, code }
  }
  if (!opts.skipCheckpoint) {
    yield* flushWriteCheckpoint()
  }
  yield { type: 'status', runId, invokeId, status: 'error' }
  writeStatus({ status: 'error', error: message, ...(opts.resumable ? { resumable: true } : {}) })
  if (runDir) {
    if (emitError) {
      appendEvent(runDir, { type: 'error', runId, invokeId, message, code })
    }
    appendEvent(runDir, { type: 'status', runId, invokeId, status: 'error' })
  }
}

/**
 * Normalize streamed + completed tool calls (finished step or interrupted flush).
 */
function bestMergedToolArguments(a: string, b: string): string {
  const ab = mergeOpenAiCompatToolArgDelta(a, b).arguments
  const ba = mergeOpenAiCompatToolArgDelta(b, a).arguments
  return ab.length >= ba.length ? ab : ba
}

function resolveStepToolCalls(
  completed: ToolCall[],
  streamed: Map<string, ToolCall>,
  step: number
): ToolCall[] {
  const streamedList = [...streamed.values()].filter((call) => call.name && call.name !== 'tool')
  const streamedById = new Map(streamedList.map((call) => [call.id, call]))

  let base: ToolCall[]
  if (completed.length > 0) {
    const completedIds = new Set<string>()
    base = completed.map((tc) => {
      completedIds.add(tc.id)
      const fromStream = streamedById.get(tc.id)
      if (!fromStream?.arguments) return tc
      const args = bestMergedToolArguments(fromStream.arguments, tc.arguments || '')
      return { ...tc, arguments: args }
    })
    for (const sc of streamedList) {
      if (!completedIds.has(sc.id)) base.push(sc)
    }
  } else {
    base = streamedList
  }

  return ensureToolCallIds(dedupeToolCalls(base), { step, prefix: 'call' }).map((call) => {
    const name = canonicalizeAgentToolName(call.name)
    return name === call.name ? call : { ...call, name }
  })
}

function accumulateStreamedToolDelta(
  streamed: Map<string, ToolCall>,
  toolCallId: string,
  delta: { name?: string; arguments?: string }
): void {
  const existing = streamed.get(toolCallId) ?? { id: toolCallId, name: '', arguments: '' }
  // Same merge rule as the provider layer: hosts that re-send the full name per
  // delta must not glue into `get_weatherget_weather` (visible on interrupt/
  // cancel flushes where no completed tool_call chunk corrects it).
  if (delta.name) existing.name = mergeStreamedToolName(existing.name, delta.name)
  if (delta.arguments) {
    existing.arguments = mergeOpenAiCompatToolArgDelta(existing.arguments, delta.arguments).arguments
  }
  streamed.set(toolCallId, existing)
}

/** Cadence for durable in-flight assistant snapshots (crash-recovery granularity). */
const STREAM_SNAPSHOT_INTERVAL_MS = 1500

function* flushPartialAssistant(
  runId: string,
  runDir: string,
  messages: ChatMessage[],
  assistantText: string,
  thinkingText: string,
  reasoningState: ProviderReasoningState | undefined,
  completedToolCalls: ToolCall[],
  streamedToolCalls: Map<string, ToolCall>,
  step: number,
  interruption: 'cancelled' | 'interrupted'
): Generator<AgentEvent> {
  const quarantined = quarantineReasoningState(reasoningState)
  if (quarantined !== reasoningState) logReasoningQuarantine(runId, step)
  reasoningState = quarantined
  const toolCalls = resolveStepToolCalls(completedToolCalls, streamedToolCalls, step)
  const scrubbedText = stripToolShapedAssistantText(assistantText)
  if (!scrubbedText && !thinkingText && toolCalls.length === 0) return

  const stub = interruption === 'cancelled' ? 'Cancelled' : 'Interrupted'
  const mappedCalls = toolCalls.map((t) => ({
    id: t.id,
    name: t.name,
    arguments: t.arguments
  }))
  // Same single-copy rule as the main persist paths: reasoningState carries the
  // payload; `thinking` stays only when the payload has no recoverable text.
  const assistant: ChatMessage = {
    role: 'assistant',
    content: scrubbedText,
    ...(!thinkingFromReasoningState(reasoningState) && thinkingText
      ? { thinking: thinkingText }
      : {}),
    ...(reasoningState ? { reasoningState } : {}),
    ...(mappedCalls.length ? { toolCalls: mappedCalls } : {})
  }
  messages.push(assistant)
  appendMessage(runDir, assistant)
  const assistantEv: AgentEvent = {
    type: 'assistant_message',
    runId,
    content: scrubbedText,
    ...(thinkingText ? { thinking: thinkingText } : {}),
    ...(mappedCalls.length ? { toolCalls: mappedCalls } : {})
  }
  appendEvent(runDir, assistantEv)
  yield assistantEv

  for (const call of toolCalls) {
    const unfinished: ChatMessage = {
      role: 'tool',
      toolCallId: call.id,
      toolName: call.name,
      content: stub,
      ok: false
    }
    messages.push(unfinished)
    appendMessage(runDir, unfinished)
    const resultEv = {
      type: 'tool_result' as const,
      runId,
      toolCallId: call.id,
      name: call.name,
      summary: interruption,
      ok: false,
      content: stub
    }
    appendEvent(runDir, toolResultEventForPersistence(resultEv))
    yield toolResultEventForIpc(resultEv)
  }
}

/** Quarantine a glitched reasoning payload before persist/replay; warn once. */
function logReasoningQuarantine(runId: string, step: number): void {
  logger.warn('Quarantined script-corrupted reasoning block', {
    scope: 'agent',
    code: 'REASONING_QUARANTINED',
    correlationId: runId,
    step
  })
}

/**
 * Rebuild an in-flight assistant answer from the last durable stream_snapshot
 * after a hard kill. During a healthy stream the assistant message reaches
 * messages.jsonl only at step end, so a power loss / SIGKILL mid-stream leaves
 * the answer the user watched only in events.jsonl snapshots. Appends the
 * snapshot text as an assistant message when:
 *  - the snapshot is the last one and no terminal status event follows it
 *    (orderly interrupt/error paths always append status after flushing), and
 *  - the transcript does not already contain that text (the step's own persist
 *    may have landed before the crash; snapshots repeat the full buffer).
 */
async function reconstructStreamSnapshotAssistant(
  runDir: string,
  runId: string,
  messages: ChatMessage[]
): Promise<void> {
  if (messages.length === 0) return
  const events = await loadEventsAsync(runDir, runId, { limit: 400 })
  let snapshot: string | null = null
  let terminalAfterSnapshot = false
  for (const row of events) {
    const ev = row.event as { type?: unknown; text?: unknown; status?: unknown } | null
    if (!ev || typeof ev !== 'object') continue
    if (ev.type === 'stream_snapshot' && typeof ev.text === 'string' && ev.text.trim()) {
      snapshot = ev.text
      terminalAfterSnapshot = false
      continue
    }
    if (
      snapshot &&
      ev.type === 'status' &&
      (ev.status === 'done' || ev.status === 'cancelled' || ev.status === 'error')
    ) {
      terminalAfterSnapshot = true
    }
  }
  if (!snapshot || terminalAfterSnapshot) return
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'assistant') continue
    const content = message.content
    if (typeof content === 'string' && (content === snapshot || content.includes(snapshot))) {
      return
    }
    break
  }
  const recovered: ChatMessage = { role: 'assistant', content: snapshot }
  messages.push(recovered)
  appendMessage(runDir, recovered)
  appendEvent(runDir, { type: 'assistant_message', runId, content: snapshot })
}

export async function* runAgent(input: {
  runId: string
  messages?: ChatMessage[]
  newMessages?: ChatMessage[]
  /** Client-reported count of its messages already persisted on disk (index-based resume dedupe). */
  persistedMessageCount?: number
  workspacePath: string
  resume?: boolean
  /** Ask / Plan / Agent — defaults to agent when omitted. */
  mode?: AgentInteractionMode
  focusedFile?: string | null
}): AsyncGenerator<AgentEvent> {
  const globalSettings = getSettings()
  const workspaces = readWorkspacesState()
  const override = findWorkspaceSettingsOverride(workspaces, input.workspacePath)
  const effective = resolveEffectiveSettings(globalSettings, override)
  const settings = { ...DEFAULT_SETTINGS, ...globalSettings, ...effective }
  let agentMode: AgentInteractionMode = input.mode ?? 'agent'
  const workspace = input.workspacePath
  const runId = input.runId
  const { controller, invokeId } = registerRunAbort(runId, workspace)

  // Entire body in try/finally so early returns (missing key, etc.) always clear the abort map.
  // Storage / session paths stay on `workspace`. File tools may use an instance worktree.
  let toolWorkspace = workspace
  let runDir: string | null = null
  let checkpointFlushed = false
  let runExitedNormally = false
  let messages: ChatMessage[] = []
  let costTotals: StepUsageTotals = emptyStepUsageTotals()
  let compactionCountThisRun = 0
  let costLogProvider: ProviderId | string = settings.provider
  let costLogModel = settings.model
  /** Agent step counter — declared early so interim receipt can close over it. */
  let step = 0
  /** Last step that flushed an interim receipt.json (start writes at step 0). */
  let lastReceiptPersistedStep = 0
  const RECEIPT_PERSIST_EVERY_STEPS = 5
  const flushStepArtifacts = async (): Promise<void> => {
    if (!runDir || !isCurrentInvoke(runId, invokeId)) return
    try {
      await flushEventAppends(runDir)
      await flushStatusWrites(runDir)
    } catch (err) {
      // Do not clear pending append notices here — step-boundary
      // emitEventAppendFailureNotice still needs to surface them. Log so interim
      // receipt flushes are not silent.
      logger.warn('Interim step artifact flush failed', {
        scope: 'agent',
        code: 'PERSIST',
        correlationId: runId,
        err
      })
    }
  }
  const persistInterimReceipt = async (force = false): Promise<void> => {
    if (!runDir || !isCurrentInvoke(runId, invokeId)) return
    await flushStepArtifacts()
    if (!force && step - lastReceiptPersistedStep < RECEIPT_PERSIST_EVERY_STEPS) return
    // Interim receipts use the in-memory working set + a bounded event tail to
    // avoid re-parsing the full messages.jsonl every few steps. Final receipt in
    // `finally` still loads durable disk state.
    const events = await loadEventsAsync(runDir, runId)
    writeRunReceiptBestEffort({
      runDir,
      runId,
      loadStatus,
      loadMessages: () => messages,
      loadEvents: () => events,
      readContract
    })
    // Keep the observational flight recorder current on long runs — the final
    // write only happens in the terminal `finally`, so a multi-hour run would
    // otherwise have no trajectory until it ends.
    writeTrajectoryArtifactsBestEffort({
      runDir,
      runId,
      loadEvents: () => events,
      receipt: null
    })
    lastReceiptPersistedStep = step
  }
  const writeStatus = (patch: Parameters<typeof updateStatus>[1]): void => {
    if (!runDir || !isCurrentInvoke(runId, invokeId)) return
    if (patch.status === 'done' || patch.status === 'error' || patch.status === 'cancelled') {
      finalizeTodosOnRunEnd(runDir, patch.status)
      void patchLatestTodoWriteMessage(runDir, patch.status)
    }
    // Abort (including quit) must not pause. User Stop/Esc pauses in chat:cancel
    // so an active goal can resume after restart.
    updateStatus(runDir, patch)
  }
  const flushWriteCheckpoint = function* (opts?: {
    reopen?: boolean
  }): Generator<AgentEvent, void, unknown> {
    if (!runDir || checkpointFlushed) return
    checkpointFlushed = true
    const meta = finalizeWriteCheckpoint(runDir)
    if (meta) {
      const ev: AgentEvent = {
        type: 'writes_checkpoint',
        runId,
        checkpointId: meta.id,
        files: meta.files
      }
      appendEvent(runDir, ev)
      yield ev
    }
    if (opts?.reopen) {
      checkpointFlushed = false
      beginWriteCheckpoint(runDir, toolWorkspace, lastUserMessageIndex(messages))
    }
  }
  try {
    const lastUser = [...(input.messages ?? input.newMessages ?? [])]
      .reverse()
      .find((m) => m.role === 'user')
    // Prefer what the user typed: do not fall back to contentToText (attachment
    // dumps) for the durable goal. Collapse skill/MCP slash injections so
    // sidebar goals aren't the full body blob. Absolute paths are scrubbed from
    // the goal; outsideWorkspacePathGuidance stays a loop hint only.
    const displayText = lastUser ? contentDisplayText(lastUser.content) : ''
    const goal = lastUser ? runGoalFromUserText(displayText) : 'chat'
    const outsidePaths = lastUser ? findAbsolutePathsInText(displayText) : []
    const outsidePathHint = outsideWorkspacePathGuidance(outsidePaths)
    let initialStep = 0
    let resumedLoopCheckpoint: ReturnType<typeof loadLoopCheckpoint> = null

    let wasInterruptedResume = false

    if (input.resume) {
      const preResumeDir = resolveRunDir(workspace, runId)
      if (existsSync(preResumeDir)) {
        wasInterruptedResume = loadStatus(preResumeDir)?.resumable === true
      }
      runDir = await resumeRun(workspace, runId)
      if (wasInterruptedResume) {
        resumedLoopCheckpoint = loadLoopCheckpoint(runDir)
      } else {
        clearLoopCheckpoint(runDir)
      }
      const persisted = loadStatus(runDir)
      initialStep = persisted?.step ?? 0
      // Run 6265fa90 (2026-09-01): every app restart re-fired the 500-step
      // runaway guard ~200ms in — status running → error, no steps, no
      // provider call — because the run-scoped counter restored 500 and the
      // step++ at the loop head crossed the ceiling immediately. The guard's
      // own message says "Send continue to keep going": a resume that carries
      // a fresh user turn is a new turn, so its step budget starts at 0.
      if (
        initialStep >= MAX_STEPS_PER_TURN &&
        ((input.newMessages?.length ?? 0) > 0 || (input.messages?.length ?? 0) > 0)
      ) {
        initialStep = 0
      }
      // Prefer chatStart mode when the UI sent one; otherwise restore last run mode.
      agentMode = input.mode ?? persisted?.mode ?? 'agent'
      const diskMessages = await loadMessagesAsync(workspace, runId)
      // Always merge from durable disk history on resume so a stale client
      // payload cannot silently rewrite messages.jsonl.
      if (input.newMessages?.length) {
        const toAppend = dedupeNewMessagesAgainstDisk(
          diskMessages,
          input.newMessages,
          input.persistedMessageCount
        ).map((m) => ensureUserMessageAt(m))
        messages = [...diskMessages, ...toAppend]
      } else {
        messages = diskMessages.map((m) => ({ ...m }))
      }
      // A hard kill mid-stream leaves the in-flight answer only as
      // stream_snapshot events; rebuild it so the transcript the user resumes
      // shows the answer they watched stream.
      await reconstructStreamSnapshotAssistant(runDir, runId, messages)
      await syncMessagesAsync(runDir, messages)
      // Seed cumulative billed totals. Prefer the durable loopCheckpoint
      // usageTotals: events.jsonl archives rotate (oldest deleted), so
      // re-summing step_usage rows loses billed tokens once history rotates —
      // the checkpoint is written every step and is monotonic. Fall back to
      // the archive sum when no checkpoint totals exist (legacy runs).
      const archivedTotals = await loadStepUsageTotalsAsync(runDir)
      const checkpointTotals = resumedLoopCheckpoint?.usageTotals
      if (
        checkpointTotals &&
        checkpointTotals.steps >= archivedTotals.steps &&
        checkpointTotals.billedInputTokens >= archivedTotals.billedInputTokens
      ) {
        costTotals = { ...emptyStepUsageTotals(), ...checkpointTotals, inputTokens: checkpointTotals.lastStepInputTokens }
      } else {
        costTotals = archivedTotals
      }
    } else {
      messages = (input.messages ?? []).map((m) => ensureUserMessageAt({ ...m }))
      if (runExists(workspace, runId)) {
        // Inline instances (and other internal starters) may create the run dir
        // before runAgent — do not recreate status or wipe transcript files.
        runDir = resolveRunDir(workspace, runId)
        const persisted = loadStatus(runDir)
        agentMode = input.mode ?? persisted?.mode ?? agentMode
      } else {
        runDir = createRun(workspace, runId, goal, agentMode)
      }
      for (const m of messages) appendMessage(runDir, m)
      await flushMessageAppends(runDir)
    }

    const persistedForTools = loadStatus(runDir)
    const isInlineInstance = persistedForTools?.inlineInstance === true
    if (isInlineInstance && persistedForTools?.worktreePath) {
      const wt = persistedForTools.worktreePath
      if (!isSafeInstanceWorktreePath(workspace, wt) || !existsSync(wt)) {
        const missing =
          'Instance worktree is missing or unsafe — refusing to fall back to the parent workspace. Re-spawn the instance.'
        writeStatus({
          status: 'error',
          mode: agentMode,
          invokeId,
          error: missing
        })
        yield { type: 'error', runId, message: missing }
        yield { type: 'status', runId, status: 'error', invokeId }
        return
      }
      toolWorkspace = wt
    } else {
      toolWorkspace = workspace
    }

    if (!isInlineInstance) {
      const invocation = parseGoalInvocation(displayText)
      if (invocation) {
        const seeded = createGoal(runDir, invocation.objective)
        emitGoalUpdate({
          workspacePath: workspace,
          runId,
          runDir,
          goal: seeded
        })
      }
      // A follow-up message on a run whose goal is still the seeded trivial
      // first prompt ("hi", "chat") means the real task never became the goal.
      // Refresh status + contract.md from this invoke's instruction so the
      // goal sidebar, contract "Done when", and loop governance reflect the
      // actual task. Deliberate renames and longer seeded goals are kept.
      const persisted = loadStatus(runDir)
      const seededGoal = persisted?.goal?.trim() ?? ''
      const isTrivialSeed =
        seededGoal.length > 0 &&
        seededGoal.length <= 12 &&
        !seededGoal.includes(' ') &&
        seededGoal.toLowerCase() !== 'chat' // 'chat' is the createRun default, already meaningful
      const candidate = runGoalFromUserText(displayText)
      const candidateMeaningful =
        candidate !== 'chat' && candidate.trim().length > 12 && candidate.includes(' ')
      if (
        isTrivialSeed &&
        candidateMeaningful &&
        candidate.toLowerCase() !== seededGoal.toLowerCase()
      ) {
        writeStatus({ goal: candidate.slice(0, 200) })
        const contractPath = join(runDir, 'contract.md')
        try {
          const contract = readFileSync(contractPath, 'utf8')
          const updated = GOAL_SECTION_RE.test(contract)
            ? contract.replace(GOAL_SECTION_RE, `$1${candidate.slice(0, 200)}$3`)
            : contract
          atomicWriteFile(contractPath, updated)
        } catch {
          // No contract.md (or unreadable) — goal refresh alone is fine.
        }
      }
    }

    // Fresh invoke — do not inherit a prior LOOP_SAFETY failure streak.
    writeStatus({
      status: 'running',
      mode: agentMode,
      invokeId,
      error: undefined
    })
    // messages is still the FULL transcript here — the compaction fold below has
    // not run yet, so the plain working index is already a full-transcript index.
    beginWriteCheckpoint(runDir, toolWorkspace, lastUserMessageIndex(messages))

    if (agentMode === 'plan') {
      seedPlanStubIfMissing(runDir)
    }

    let compaction: CompactionRecord | null = loadCompaction(runDir)
    // Everything before the watermark is already represented by the summary, so it
    // never re-enters the working set. `messages.jsonl` still holds the full history
    // for transcript replay and lazy tool-output loads.
    let foldedMessages = compaction?.foldedMessages ?? 0
    if (foldedMessages > 0 && messages.length > 0) {
      const applied = applyFoldedMessagesWatermark(messages, foldedMessages)
      messages = applied.messages
      foldedMessages = applied.foldedMessages
      // Persist the clamped watermark so a corrupt/stale resume value does not
      // fold away the latest turn on the next restart.
      if (compaction && compaction.foldedMessages !== foldedMessages) {
        const clamped = { ...compaction, foldedMessages }
        if (runDir && !saveCompaction(runDir, clamped)) {
          logger.warn('Resume watermark clamp not persisted; in-memory watermark updated', {
            scope: 'agent',
            correlationId: runId
          })
        }
        compaction = clamped
      }
    } else {
      // Empty transcript + stale watermark: zero both counter and in-memory record
      // so later nextFolded math cannot under-count relative to disk.
      foldedMessages = 0
      if (compaction && (compaction.foldedMessages ?? 0) > 0) {
        const cleared = { ...compaction, foldedMessages: 0 }
        if (runDir && !saveCompaction(runDir, cleared)) {
          logger.warn('Stale resume watermark clear not persisted; in-memory watermark updated', {
            scope: 'agent',
            correlationId: runId
          })
        }
        compaction = cleared
      }
    }

    logger.info('Agent run started', {
      scope: 'agent',
      correlationId: runId,
      provider: settings.provider,
      model: settings.model,
      mode: agentMode,
      ...(workspace ? { workspaceId: workspaceIdFromPath(workspace) } : {}),
      resume: Boolean(input.resume)
    })

    yield { type: 'status', runId, invokeId, status: 'running' }
    appendEvent(runDir, { type: 'status', runId, invokeId, status: 'running' })
    if (wasInterruptedResume) {
      const terminalLossEv: AgentEvent = {
        type: 'token_cost_hint',
        runId,
        invokeId,
        kind: 'long_run_task_boundary',
        message:
          'Note: background terminal sessions from before the interruption are no longer available.'
      }
      appendEvent(runDir, terminalLossEv)
      yield terminalLossEv
    }
    // Flush so interim receipt sees invokeId (status patches are coalesced).
    await flushStatusWrites(runDir)
    const startEvents = await loadEventsAsync(runDir, runId)
    // Interim receipt so PlanPanel does not keep a prior invoke's done receipt while live.
    writeRunReceiptBestEffort({
      runDir,
      runId,
      loadStatus,
      loadMessages: () => loadMessages(workspace, runId),
      loadEvents: () => startEvents,
      readContract
    })

    const harness = loadHarness(workspace)
    const providerId: ProviderId = settings.provider
    const provider = getProvider(providerId)
    costLogProvider = providerId
    costLogModel = settings.model

    let apiKey: string | null = getSecret(providerId)
    const baseUrl = resolveProviderChatBaseUrl(providerId, settings, apiKey)
    {
      const status = secretStatus()
      const storedBlob = hasStoredSecretBlob(providerId)
      const preflight = preflightChatProviderAuth({
        providerId,
        apiKey,
        baseUrl: baseUrl ?? settings.ollamaBaseUrl,
        encryptionAvailable: status.encryptionAvailable,
        hasStoredBlob: storedBlob
      })
      if (preflight) {
        logger.warn(preflight.message, {
          scope: 'agent',
          code: preflight.code,
          correlationId: runId,
          provider: providerId
        })
        yield* emitTerminalRunError({
          runId,
          invokeId,
          runDir,
          message: preflight.message,
          code: preflight.code,
          flushWriteCheckpoint,
          writeStatus
        })
        return
      }
    }

    step = initialStep
    let lastUsage: TokenUsage | undefined
    // Interrupted resume restores budget fields even when invokeId differs — each
    // chatStart allocates a new invokeId while the prior slot unwinds. Follow-up
    // resume after done clears the checkpoint instead (see agentLoopResume tests).
    let truncationContinues = resumedLoopCheckpoint?.truncationContinues ?? 0
    let overflowRetryUsed = resumedLoopCheckpoint?.overflowRetryUsed ?? false
    let goalNoToolFinishes = resumedLoopCheckpoint?.goalNoToolFinishes ?? 0
    /** Current cumulative usage as the checkpoint's optional v3 payload. */
    const persistUsageTotalsCheckpointPayload = (): LoopCheckpoint['usageTotals'] => {
      if (costTotals.steps === 0) return undefined
      return {
        billedInputTokens: costTotals.billedInputTokens,
        peakInputTokens: costTotals.peakInputTokens,
        outputTokens: costTotals.outputTokens,
        billedCachedInputTokens: costTotals.billedCachedInputTokens,
        cacheCreationInputTokens: costTotals.cacheCreationInputTokens,
        reasoningTokens: costTotals.reasoningTokens,
        steps: costTotals.steps,
        stepsWithCacheReport: costTotals.stepsWithCacheReport,
        billedCost: costTotals.billedCost,
        billedCostSaved: costTotals.billedCostSaved,
        stepsWithCostReport: costTotals.stepsWithCostReport,
        generationMs: costTotals.generationMs,
        lastStepInputTokens: costTotals.inputTokens
      }
    }
    /**
     * Merge cumulative usage into loopCheckpoint.json. events.jsonl archives
     * rotate (oldest deleted, MAX_EVENT_ARCHIVES=5), so re-summing step_usage
     * rows on resume silently loses billed tokens once history rotates — the
     * durable checkpoint is the only monotonic source. Cheap (single atomic
     * JSON write) and called once per agent step.
     */
    const persistUsageTotalsCheckpoint = (): void => {
      if (!runDir || !isCurrentInvoke(runId, invokeId)) return
      const usageTotals = persistUsageTotalsCheckpointPayload()
      if (!usageTotals) return
      try {
        saveLoopCheckpoint(runDir, {
          version: LOOP_CHECKPOINT_VERSION,
          step,
          invokeId,
          updatedAt: new Date().toISOString(),
          truncationContinues,
          overflowRetryUsed,
          identicalStepStreak,
          lastStepFingerprint,
          consecutiveToolFailureSteps,
          recentFailureSignatures,
          emptyResponseContinues,
          goalNoToolFinishes,
          usageTotals
        })
      } catch {
        // Checkpoint write is best-effort; the run must not fail on it.
      }
    }
    const persistLoopCheckpoint = (): void => {
      if (!runDir || !isCurrentInvoke(runId, invokeId)) return
      try {
        saveLoopCheckpoint(runDir, {
          version: LOOP_CHECKPOINT_VERSION,
          step,
          invokeId,
          updatedAt: new Date().toISOString(),
          truncationContinues,
          overflowRetryUsed,
          identicalStepStreak,
          lastStepFingerprint,
          consecutiveToolFailureSteps,
          recentFailureSignatures,
          emptyResponseContinues,
          goalNoToolFinishes,
          // Carry the durable usage totals so this write never erases them.
          ...(persistUsageTotalsCheckpointPayload()
            ? { usageTotals: persistUsageTotalsCheckpointPayload() }
            : {})
        })
      } catch (err) {
        logger.warn('Loop checkpoint persist failed', {
          scope: 'agent',
          code: 'PERSIST',
          correlationId: runId,
          err
        })
      }
    }

    const approvalSettings = settings.toolApproval ?? DEFAULT_SETTINGS.toolApproval
    const mcpProtection = approvalSettings.mcpProtection !== false
    // Skip the gate only when nothing would park: mode off and MCP protection off.
    const approvalGate =
      approvalSettings.mode === 'off' && !mcpProtection
        ? undefined
        : createApprovalGate({
            runId,
            invokeId,
            mode: approvalSettings.mode,
            mcpProtection,
            workspaceAllowlist: approvalSettings.allowlist,
            autonomousMode: settings.autonomousMode === true,
            // Soft follow-up interrupt must cancel parked approvals, not only hard cancel.
            signal: streamSignalFor(runId, controller.signal),
            persistAlways: (toolName) => persistAlwaysAllow(workspace, toolName)
          })

    /** Persist compaction; `saved` is false only when a write was required and failed. */
    const emitCompaction = (
      record: CompactionRecord | null
    ): { saved: boolean; event: AgentEvent | null } => {
      if (!record || !runDir) return { saved: true, event: null }
      if (
        compaction?.summary === record.summary &&
        compaction?.createdAt === record.createdAt &&
        (compaction?.foldedMessages ?? 0) === (record.foldedMessages ?? 0)
      ) {
        return { saved: true, event: null }
      }
      const summaryChanged =
        compaction?.summary !== record.summary || compaction?.createdAt !== record.createdAt
      if (!saveCompaction(runDir, record)) {
        const onDisk = loadCompaction(runDir)
        if (
          onDisk &&
          onDisk.summary === record.summary &&
          onDisk.createdAt === record.createdAt &&
          (onDisk.foldedMessages ?? 0) === (record.foldedMessages ?? 0)
        ) {
          compaction = onDisk
        } else {
          logger.warn('Compaction not persisted; keeping prior in-memory record', {
            scope: 'agent',
            correlationId: runId
          })
          return { saved: false, event: null }
        }
      } else {
        compaction = record
      }
      if (!summaryChanged) {
        return { saved: true, event: null }
      }
      // A newly saved fold means history shrank — a later distinct overflow may
      // legitimately retry instead of being blocked by the one-shot flag.
      overflowRetryUsed = false
      const ev: AgentEvent = {
        type: 'compaction',
        runId,
        summary: record.summary,
        tokenEstimate: record.tokenEstimate,
        kind: 'summary',
        ...(record.verified != null ? { verified: record.verified } : {}),
        ...(record.verifyCoverage != null ? { verifyCoverage: record.verifyCoverage } : {}),
        ...(record.verifyFailures && record.verifyFailures.length > 0
          ? { verifyFailures: record.verifyFailures }
          : {})
      }
      appendEvent(runDir, ev)
      return { saved: true, event: ev }
    }

    const modelInfo = await resolveModelInfo(
      providerId,
      settings.model,
      apiKey,
      baseUrl,
      controller.signal
    )

    if (controller.signal.aborted) {
      yield* flushWriteCheckpoint()
      clearFollowUps(runId)
      markRunTurnComplete(runId, invokeId)
      yield { type: 'status', runId, invokeId, status: 'cancelled' }
      writeStatus({ status: 'cancelled' })
      appendEvent(runDir, { type: 'status', runId, invokeId, status: 'cancelled' })
      return
    }

    // Marketplace Force on/off applies from marketplaceOverrides even when the
    // provider/model workspace override toggle is off.
    const marketplaceOverrides = override?.marketplaceOverrides

    let skillsSection = buildSkillsSection(loadEnabledSkills(marketplaceOverrides, workspace))
    let pluginRulesSection = loadPluginRules(marketplaceOverrides)
    const refreshSkillPromptSections = (): void => {
      skillsSection = buildSkillsSection(loadEnabledSkills(marketplaceOverrides, workspace))
      pluginRulesSection = loadPluginRules(marketplaceOverrides)
    }

    let runEnabledMcpIds = new Set<string>()
    let mcpToolPolicies = new Map<
      string,
      { allowedTools?: string[]; deniedTools?: string[] }
    >()
    let toolDefs: { name: string; description: string; parameters: Record<string, unknown> }[] = []
    let toolsJsonEstimate = 0
    let lastMcpRefreshFp = ''
    let lastMcpCatalogFp = ''
    /** One forced reconnect attempt per run when enabled servers previously failed. */
    let mcpFailureRetried = false
    /** MCP tool names in the current step's provider catalog (post budget trim). */
    let stepMcpToolNames = new Set<string>()
    /** Optional pin bookkeeping for request_mcp_tools / release_mcp_tools.
     * The step catalog always carries every connected MCP tool and builtin, so
     * pins never change the catalog — they exist so request/release respond
     * honestly and so not-in-catalog fail-fast stays real for mode-denied MCP. */
    const runPinnedMcpToolNames = new Set<string>()
    const mcpLastUsedByName = new Map<string, number>()
    /** Per-tool not-in-catalog rejection counts (fail-fast after repeats). */
    const mcpNotInCatalogCounts = new Map<string, number>()
    const runStickyToolNames = new Set<string>()
    const invalidateMcpToolCatalogCache = (): void => {
      lastMcpCatalogFp = ''
    }

    const mcpNotInCatalogFailFastHint = (): string | undefined => {
      const hit = [...mcpNotInCatalogCounts.entries()]
        .filter(([, n]) => n >= MCP_NOT_IN_CATALOG_FAIL_FAST_THRESHOLD)
        .map(([name]) => name)
      return loopHintForMcpNotInCatalogFailFast(hit)
    }

    // Bind stdio MCP hint for legacy callers; sessions are workspace-scoped per sync.
    setMcpStdioWorkspace(workspace)

    const refreshMcpToolsForStep = async (): Promise<void> => {
      // Session map unions every open workspace so Force-off only disconnects when
      // no workspace still needs the server. Skip sync when config fingerprint is
      // unchanged (still rebuild tool defs from connected sessions).
      const refreshFp = `${mcpSessionMapFingerprint()}::${JSON.stringify(marketplaceOverrides ?? null)}::${workspace}`
      const configUnchanged = refreshFp === lastMcpRefreshFp
      lastMcpRefreshFp = refreshFp
      const sessionServers = resolveMcpServersForSessionMap()
      const needsFailureRetry =
        !mcpFailureRetried &&
        getMcpServerStatus(sessionServers).some(
          (s) =>
            s.enabled &&
            !s.connected &&
            Boolean(s.error) &&
            !isGitMcpNotARepoError(s.error)
        )
      if (!configUnchanged || needsFailureRetry) {
        if (needsFailureRetry) mcpFailureRetried = true
        await syncMcpServers(
          sessionServers,
          needsFailureRetry ? { forceRetryFailures: true } : undefined
        )
      }
      const runMcpServers = resolveEffectiveMcpServers(marketplaceOverrides)
      runEnabledMcpIds = new Set(
        runMcpServers
          .filter((s) => s.enabled && mcpAuthAllowedForWorkspace(s, workspace))
          .map((s) => s.id)
      )
      mcpToolPolicies = new Map(
        runMcpServers
          .filter((s) => s.enabled)
          .map((s) => [
            s.id,
            {
              ...(s.allowedTools?.length ? { allowedTools: s.allowedTools } : {}),
              ...(s.deniedTools?.length ? { deniedTools: s.deniedTools } : {})
            }
          ])
      )
      const liveCodeIndexEnabled = getSettings().codeIndex?.enabled !== false
      const catalogFp = `${refreshFp}::${agentMode}::${settings.autoModeSwitch ? 1 : 0}::${modelInfo.supportsTools === false ? 0 : 1}::ci${liveCodeIndexEnabled ? 1 : 0}`
      if (configUnchanged && catalogFp === lastMcpCatalogFp && lastMcpCatalogFp !== '') {
        // Servers/mode/switch availability/tools support unchanged — reuse prior defs.
        return
      }
      lastMcpCatalogFp = catalogFp
      const mcpToolDefs = listMcpToolDefinitions().filter((t) => {
        const parsed = parseMcpToolName(t.name)
        if (parsed == null || !runEnabledMcpIds.has(parsed.serverId)) return false
        const policy = mcpToolPolicies.get(parsed.serverId)
        if (policy && !isMcpToolPermitted(parsed.toolName, policy)) return false
        return true
      })
      const allToolDefs =
        modelInfo.supportsTools !== false
          ? filterToolDefsForCodeIndex(
              filterToolDefsForMode(
                agentMode,
                [...AGENT_TOOLS, ...mcpToolDefs],
                {
                autoModeSwitch: settings.autoModeSwitch,
                inlineInstance: isInlineInstance
              }),
              liveCodeIndexEnabled
            )
          : []
      // Full catalog every step: nothing is trimmed, deferred, or evicted —
      // request_mcp_tools pins are bookkeeping only (see toolsBudget.ts).
      const fullCatalog = buildStepToolCatalog(allToolDefs)
      toolDefs = fullCatalog.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters as Record<string, unknown>
      }))
      toolsJsonEstimate = fullCatalog.estimate
      const keptNameSet = new Set(fullCatalog.tools.map((t) => t.name))
      // A successful refresh that carries the tool should clear fail-fast history.
      for (const name of [...mcpNotInCatalogCounts.keys()]) {
        if (keptNameSet.has(name)) mcpNotInCatalogCounts.delete(name)
      }
      stepMcpToolNames = new Set(
        toolDefs.map((t) => t.name).filter((n) => parseMcpToolName(n) != null)
      )
    }

    await refreshMcpToolsForStep()
    let identicalStepLoopHint: string | undefined
    let compactionLoopHint: string | undefined
    /** Last executed step's tool fingerprint + repeat streak (runaway-loop guard). */
    let lastStepFingerprint = resumedLoopCheckpoint?.lastStepFingerprint ?? ''
    let identicalStepStreak = resumedLoopCheckpoint?.identicalStepStreak ?? 0
    /** Steps in a row where every tool call failed (runaway-failure guard). */
    let consecutiveToolFailureSteps = resumedLoopCheckpoint?.consecutiveToolFailureSteps ?? 0
    /** Recent all-failed step signatures (failure-streak novelty rule). */
    let recentFailureSignatures = [...(resumedLoopCheckpoint?.recentFailureSignatures ?? [])]
    let toolFailureLoopHint: string | undefined
    /** Estimated tokens left by the last auto-compaction (re-compaction throttle). */
    let postCompactEstimateFloor: number | null = null
    /**
     * Last provider-reported input tokens for this run. The local estimator
     * counts replay-only fields (reasoningState) that some upstreams never
     * process, inflating the estimate ~2.9× vs the wire (run b0d72041:
     * 433k estimated vs 148k billed). Anchoring the auto-compact decision on
     * the provider number prevents compaction firing far too early on such
     * providers. Local estimate still governs overflow and all UI estimates.
     */
    let providerInputTokens: number | null = null
    let lastCompactVerifyFailed = false
    let loopSafetyEmitted = false
    const stopForLoopSafety = function* (stop: LoopStop): Generator<AgentEvent, void, unknown> {
      if (loopSafetyEmitted) return
      loopSafetyEmitted = true
      logger.warn('Stopping run: loop safety limit reached', {
        scope: 'agent',
        code: 'LOOP_SAFETY',
        correlationId: runId,
        reason: stop.reason,
        step
      })
      yield* emitTerminalRunError({
        runId,
        invokeId,
        runDir,
        message: stop.message,
        code: 'LOOP_SAFETY',
        dropFollowUpsReason: stop.reason,
        flushWriteCheckpoint,
        writeStatus
      })
    }
    const knownPaths = seedKnownPathsFromMessages(messages)
    const mutationPaths = seedMutationPathsFromMessages(messages)
    /**
     * Run-scoped recency map for the re-read soft note: successful inspect
     * tools stamp the current step; a `read` inside the stale window gets a
     * cheap steering note appended to its result (executeStepTools).
     */
    const recentReadPaths = new Map<string, number>()
    /** Plan-mode chat-essay nudges this invoke (cap 2). */
    let planUnreadyNudges = 0
    /** Empty-response auto-continues this invoke (unbounded, same class as truncation). */
    let emptyResponseContinues = resumedLoopCheckpoint?.emptyResponseContinues ?? 0
    const costWarnOnce = new Set<string>()
    /** Rolling cache-hit samples from large steps (low_cache_hit_rate). */
    const recentLargeCacheHits: number[] = []
    const thinkingEffortHigh =
      settings.thinkingEffort === 'high' ||
      settings.thinkingEffort === 'xhigh' ||
      settings.thinkingEffort === 'max'

    while (true) {
      if (controller.signal.aborted) break
      // Fairness under many concurrent runs — yield before sync-heavy step work.
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (controller.signal.aborted) break
      // Inject promoted follow-ups (Send now) before the next model call.
      yield* applyDrainedFollowUps(runId, runDir, messages)
      agentMode = yield* applyPendingModeChange(
        runId,
        runDir,
        invokeId,
        agentMode,
        writeStatus
      )
      // Live autoModeSwitch at step boundary — next step picks up Settings toggles.
      // Provider/model stay invoke-frozen; only switch_mode availability is live.
      const liveAutoModeSwitch = getSettings().autoModeSwitch === true
      const autoModeSwitchChanged = liveAutoModeSwitch !== Boolean(settings.autoModeSwitch)
      if (autoModeSwitchChanged) {
        settings.autoModeSwitch = liveAutoModeSwitch
        lastMcpCatalogFp = ''
      }
      try {
        await flushMessageAppends(runDir)
      } catch {
        // Failure is recorded for emitMessageAppendFailureNotice below.
      }
      try {
        await flushEventAppends(runDir)
      } catch {
        // Failure is recorded for emitEventAppendFailureNotice below.
      }
      if (yield* emitMessageAppendFailureNotice(runId, runDir, invokeId)) {
        yield* emitTerminalRunError({
          runId,
          invokeId,
          runDir,
          message: 'Failed to persist a chat message',
          emitErrorEvent: false,
          flushWriteCheckpoint,
          writeStatus
        })
        return
      }
      if (yield* emitEventAppendFailureNotice(runId, runDir, invokeId)) {
        yield* emitTerminalRunError({
          runId,
          invokeId,
          runDir,
          message: 'Failed to persist a run event',
          emitErrorEvent: false,
          flushWriteCheckpoint,
          writeStatus
        })
        return
      }
      step++
      // Hard runaway-loop ceiling: distinct-but-unproductive step chains never
      // trip the identical-step or tool-failure streaks, so bound them here.
      if (step > MAX_STEPS_PER_TURN) {
        yield* emitTerminalRunError({
          runId,
          invokeId,
          runDir,
          message: `This turn reached ${MAX_STEPS_PER_TURN} agent steps and was stopped as a runaway-loop guard. Send "continue" to keep going, or break the task into smaller steps.`,
          code: 'LOOP_SAFETY',
          preserveFollowUps: true,
          flushWriteCheckpoint,
          writeStatus
        })
        return
      }
      const budgetStop = runBudgetStopMessage(getSettings(), costTotals)
      if (budgetStop) {
        yield* emitTerminalRunError({
          runId,
          invokeId,
          runDir,
          message: budgetStop,
          code: 'BUDGET_EXHAUSTED',
          preserveFollowUps: true,
          flushWriteCheckpoint,
          writeStatus
        })
        return
      }
      const loopSafetyStop = loopStopDecision({
        step,
        consecutiveToolFailureSteps,
        identicalStepStreak
      })
      // Terminal thresholds only: tool-failure streaks and identical-step
      // repeats at MAX_IDENTICAL_STEP_STREAK_TERMINAL (below it, repeats
      // degrade to the per-step hint).
      if (loopSafetyStop) {
        yield* stopForLoopSafety(loopSafetyStop)
        return
      }
      const stepSoftAbort = new AbortController()
      setStreamInterrupt(runId, stepSoftAbort)
      try {
      writeStatus({ step, status: 'running' })
      // Persist skill-body stubs once the invoking turn has follow-up messages.
      {
        const skillStub = stubPastSkillInvocationsInMessages(messages)
        if (skillStub.stubbedCount > 0) {
          messages = skillStub.messages
          const diskMessages = await loadMessagesAsync(workspace, runId)
          const fullStub = stubPastSkillInvocationsInMessages(diskMessages)
          if (fullStub.stubbedCount > 0) {
            await syncMessagesAsync(runDir, fullStub.messages)
          }
          logger.info('Stubbed past skill invocation bodies in durable history', {
            scope: 'agent',
            code: 'TOKEN_COST',
            runId,
            stubbedCount: fullStub.stubbedCount || skillStub.stubbedCount
          })
        }
      }
      // Steps after the first of this invoke pick up skills/plugin rules installed
      // or enabled mid-run, and MCP servers enabled/reconnected mid-run.
      // On resume (initialStep >= 1), skip the duplicate sync that would otherwise hit
      // immediately after the pre-loop refreshMcpToolsForStep — unless autoModeSwitch
      // flipped and the catalog must rebuild switch_mode availability.
      if (step > initialStep + 1) {
        refreshSkillPromptSections()
      }
      if (step > initialStep + 1 || autoModeSwitchChanged) {
        await refreshMcpToolsForStep()
      }

      let assistantText = ''
      let thinkingText = ''
      let thinkingDoneEmitted = false
      let stepReasoningState: ProviderReasoningState | undefined
      let stepStopReason: StopReason | undefined
      const toolCalls: ToolCall[] = []
      const streamedToolCalls = new Map<string, ToolCall>()
      const streamedToolCallIndex = new Map<number, string>()
      const liveForwardedToolIds = new Set<string>()
      const persistedLiveToolIds = new Set<string>()
      const thinkingEnabled =
        settings.thinkingEnabled &&
        catalogThinkingAllowed(settings.model, modelInfo.supportsThinking)

      const persistLiveToolChrome = (
        toolCallId: string,
        name: string | undefined,
        argumentsDelta: string
      ): void => {
        // One snapshot per id once the name is known — enough for reattach/hydrate
        // without writing every argument delta to events.jsonl.
        if (!runDir || persistedLiveToolIds.has(toolCallId)) return
        if (!name || name === 'tool') return
        persistedLiveToolIds.add(toolCallId)
        appendEvent(runDir, {
          type: 'tool_call_delta',
          runId,
          toolCallId,
          name,
          argumentsDelta
        })
      }

      const priorSummary = compaction?.summary
      const contract = await readContractAsync(runDir)
      // Plan mode mirrors plan.md verbatim (stub included, never truncated) so
      // str_replace/edit args match the on-disk file exactly; Agent mode only
      // injects a filled (non-stub) plan.
      const plan =
        agentMode === 'plan' ? await readPlanRawAsync(runDir) : await readPlanAsync(runDir)
      const assembleLoopHint = combineLoopHints(
        mcpNotInCatalogFailFastHint(),
        outsidePathHint,
        compactionLoopHint,
        toolFailureLoopHint,
        identicalStepLoopHint
      )
      const assembleBase = {
        harness,
        messages,
        workspacePath: toolWorkspace,
        goal,
        contract,
        plan: plan || undefined,
        sessionEnv: buildSessionEnvSection(settings.terminalShell),
        model: modelInfo,
        toolsJsonEstimate,
        lastUsage,
        priorCompaction: compaction,
        keepRecentTurns: settings.keepRecentTurns,
        skillsSection,
        pluginRulesSection,
        userRules: getSettings().userRules ?? [],
        persona: settings.agentPersona || undefined,
        tone: settings.agentTone || undefined,
        responseLanguage: settings.responseLanguage || undefined,
        responseVerbosity: settings.responseVerbosity,
        focusedFile: input.focusedFile,
        modeSection:
          modeSectionMarkdown(agentMode, {
            autoModeSwitch: settings.autoModeSwitch,
            inlineInstance: isInlineInstance
          }) ?? undefined,
        planVerbatim: agentMode === 'plan',
        loopHint: assembleLoopHint,
        taskList: formatTodosContextSection(readTodos(runDir)),
        activeGoal: isInlineInstance ? undefined : formatActiveGoalSection(readGoal(runDir)),
        providerId,
        provider,
        apiKey,
        baseUrl,
        signal: controller.signal
      }

      let assembled = await assembleContext(assembleBase)

      const effectiveContentWindow = contentWindow(modelInfo, providerId)
      const compactThresholdRatio =
        settings.autoCompactThresholdRatio ?? DEFAULT_AUTO_COMPACT_THRESHOLD_RATIO
      const proactiveThreshold = proactiveCompactThresholdTokens(
        effectiveContentWindow,
        compactThresholdRatio
      )
      // Proactive re-compaction is wasted work until history regrows: the same
      // summarizer and keepRecentTurns would fold the same tail again, so a tail
      // that alone exceeds the threshold would otherwise pay a summarizer call
      // (up to 10 minutes) on every remaining step. Overflow still forces a fold.
      // A verify_failed attempt is the same: retrying the identical prefix every
      // step cannot succeed until the model sees more (or different) history.
      const regrowthNeeded = Math.max(
        1,
        Math.round(effectiveContentWindow * AUTO_COMPACT_MIN_REGROWTH_RATIO)
      )
      const proactiveSuppressed =
        postCompactEstimateFloor !== null &&
        assembled.estimatedTokens < postCompactEstimateFloor + regrowthNeeded
      const proactiveDecision = shouldTriggerAutoCompact(
        assembled.estimatedTokens,
        proactiveThreshold,
        providerInputTokens
      )
      const needsAutoCompact =
        assembled.overflow || (proactiveDecision.trigger && !proactiveSuppressed)

      const reloadCompactionWatermark = (): void => {
        if (!runDir) return
        const next = loadCompaction(runDir)
        if (!next) return
        compaction = next
        foldedMessages = next.foldedMessages ?? 0
        const applied = loadWorkingMessagesForFold(workspace, runId, foldedMessages)
        messages.length = 0
        messages.push(...applied.messages)
        foldedMessages = applied.foldedMessages
      }

      if (needsAutoCompact) {
        logger.info('Auto LLM compaction starting', {
          scope: 'agent',
          code: 'COMPACTION',
          correlationId: runId,
          step,
          estimatedTokens: assembled.estimatedTokens,
          providerInputTokens: providerInputTokens ?? undefined,
          triggerSource: assembled.overflow ? 'overflow' : proactiveDecision.source,
          proactiveThreshold,
          overflow: assembled.overflow
        })
        const autoOutcome = yield* autoCompactLlmEvents({
          workspacePath: workspace,
          runId,
          runDir,
          settings,
          signal: controller.signal,
          triggerReason: assembled.overflow ? 'overflow' : 'proactive',
          systemStable: assembled.systemStable,
          toolDefs,
          ...(invokeId != null ? { invokeId } : {})
        })
        if (!autoOutcome.ok && autoOutcome.reason === 'aborted') break
        if (!autoOutcome.ok && autoOutcome.reason === 'failed') {
          yield* emitTerminalRunError({
            runId,
            invokeId,
            runDir,
            message: autoOutcome.message || 'Compaction failed',
            code: 'COMPACTION',
            flushWriteCheckpoint,
            writeStatus
          })
          return
        }
        if (!autoOutcome.ok) {
          // Nothing foldable, or the summary failed verification and was discarded.
          // Continue with a hint instead of failing the run.
          const verifyFailed = autoOutcome.reason === 'verify_failed'
          lastCompactVerifyFailed = verifyFailed
          logger.info(
            verifyFailed
              ? 'Auto compaction discarded; summary failed verification'
              : 'Auto compaction skipped; nothing foldable yet',
            {
              scope: 'agent',
              code: verifyFailed ? 'COMPACTION_VERIFY' : 'COMPACTION',
              correlationId: runId,
              step,
              reason: autoOutcome.message
            }
          )
          compactionLoopHint = verifyFailed
            ? loopHintForCompactionVerifyFailed()
            : loopHintForCompactionFailure()
          // Same-size history would otherwise re-pay a summarizer call every step.
          // Overflow still bypasses this floor. Retry after ~10% token growth.
          postCompactEstimateFloor = assembled.estimatedTokens
        } else {
          const nextCompaction = loadCompaction(runDir)
          if (!nextCompaction) {
            yield* emitTerminalRunError({
              runId,
              invokeId,
              runDir,
              message: 'Compaction succeeded but compaction.json is missing',
              code: 'COMPACTION',
              flushWriteCheckpoint,
              writeStatus
            })
            return
          }
          // emitCompaction adopts the record itself — assigning `compaction` first
          // would make its dedupe guard compare the record against itself and drop
          // the event, so auto-compaction would never reach the UI or the receipt.
          const { saved: autoSaved, event: autoCompactionEv } = emitCompaction(nextCompaction)
          compactionLoopHint = loopHintAfterCompaction(nextCompaction.retainedDecisions)
          compactionCountThisRun++
          if (autoCompactionEv) yield autoCompactionEv
          if (!autoSaved) {
            yield* emitTerminalRunError({
              runId,
              invokeId,
              runDir,
              message: 'Failed to persist context compaction',
              code: 'COMPACTION',
              flushWriteCheckpoint,
              writeStatus
            })
            return
          }
          reloadCompactionWatermark()
          lastCompactVerifyFailed = false
          const postCompactEstimate = autoOutcome.result.estimatedTokens
          postCompactEstimateFloor = postCompactEstimate ?? null
          assembled = await assembleContext({
            ...assembleBase,
            messages,
            priorCompaction: compaction,
            loopHint: combineLoopHints(
              mcpNotInCatalogFailFastHint(),
              outsidePathHint,
              compactionLoopHint,
              loopHintWhenContextStillLarge(postCompactEstimate ?? 0, proactiveThreshold),
              toolFailureLoopHint,
              identicalStepLoopHint
            )
          })
          lastUsage = { inputTokens: assembled.estimatedTokens }
        }
      }

      if (assembled.overflow) {
        // Shares the auto compaction gate; if folding didn't clear the window,
        // the overflow stop below reports context_overflow.
        if (!overflowRetryUsed) {
          overflowRetryUsed = true
          persistLoopCheckpoint()
          logger.warn('Context overflow after auto compact — retrying with same keep-recent', {
            scope: 'agent',
            code: 'CONTEXT_OVERFLOW_RETRY',
            correlationId: runId,
            step,
            estimatedTokens: assembled.estimatedTokens,
            contentWindow: effectiveContentWindow
          })
          const retryOutcome = yield* autoCompactLlmEvents({
            workspacePath: workspace,
            runId,
            runDir,
            settings,
            signal: controller.signal,
            triggerReason: 'overflow',
            systemStable: assembled.systemStable,
            toolDefs,
            ...(invokeId != null ? { invokeId } : {})
          })
          if (!retryOutcome.ok && retryOutcome.reason === 'aborted') break
          if (!retryOutcome.ok && retryOutcome.reason === 'failed') {
            yield* emitTerminalRunError({
              runId,
              invokeId,
              runDir,
              message: retryOutcome.message || 'Compaction failed after overflow retry',
              code: 'COMPACTION',
              flushWriteCheckpoint,
              writeStatus
            })
            return
          }
          if (!retryOutcome.ok && retryOutcome.reason === 'verify_failed') {
            lastCompactVerifyFailed = true
          }
          // `nothing_to_compact` here means the kept tail alone overflows the
          // window; fall through to the context_overflow report below.
          if (retryOutcome.ok) {
            const retryCompaction = loadCompaction(runDir)
            if (!retryCompaction) {
              yield* emitTerminalRunError({
                runId,
                invokeId,
                runDir,
                message: 'Compaction retry succeeded but compaction.json is missing',
                code: 'COMPACTION',
                flushWriteCheckpoint,
                writeStatus
              })
              return
            }
            const { saved: retrySaved, event: retryEv } = emitCompaction(retryCompaction)
            compactionLoopHint = loopHintAfterCompaction(retryCompaction.retainedDecisions)
            compactionCountThisRun++
            if (retryEv) yield retryEv
            if (!retrySaved) {
              yield* emitTerminalRunError({
                runId,
                invokeId,
                runDir,
                message: 'Failed to persist context compaction',
                code: 'COMPACTION',
                flushWriteCheckpoint,
                writeStatus
              })
              return
            }
            reloadCompactionWatermark()
            lastCompactVerifyFailed = false
            const retryPostCompactEstimate = retryOutcome.result.estimatedTokens
            postCompactEstimateFloor = retryPostCompactEstimate ?? null
            assembled = await assembleContext({
              ...assembleBase,
              messages,
              priorCompaction: compaction,
              loopHint: combineLoopHints(
                mcpNotInCatalogFailFastHint(),
                outsidePathHint,
                compactionLoopHint,
                loopHintWhenContextStillLarge(retryPostCompactEstimate ?? 0, proactiveThreshold),
                toolFailureLoopHint,
                identicalStepLoopHint
              )
            })
            lastUsage = { inputTokens: assembled.estimatedTokens }
          }
        }
        if (assembled.overflow) {
          const overflowMessage = lastCompactVerifyFailed
            ? CONTEXT_OVERFLOW_VERIFY_FAILED
            : INCOMPLETE_MESSAGES.context_overflow
          const overflowEv: AgentEvent = {
            type: 'incomplete',
            runId,
            invokeId,
            reason: 'context_overflow',
            step,
            message: overflowMessage
          }
          logger.warn('Stopping run: context still exceeds model window after LLM compaction', {
            scope: 'agent',
            code: 'CONTEXT_OVERFLOW',
            correlationId: runId,
            step,
            estimatedTokens: assembled.estimatedTokens,
            contentWindow: effectiveContentWindow
          })
          appendEvent(runDir, overflowEv)
          yield overflowEv
          yield* flushWriteCheckpoint()
          const closeOverflow = tryBeginRunClosing(runId, invokeId)
          if (closeOverflow === 'has_followups') {
            yield* dropPendingFollowUps(runId, runDir, overflowMessage)
            tryBeginRunClosing(runId, invokeId)
          }
          yield { type: 'status', runId, invokeId, status: 'error' }
          writeStatus({
            status: 'error',
            error: overflowMessage
          })
          appendEvent(runDir, { type: 'status', runId, invokeId, status: 'error' })
          return
        }
      }

      const contextWindow = contextWindowFor(modelInfo, providerId)
      const compactionTrigger = proactiveThreshold
      const priorProviderInput =
        lastUsage?.inputTokens && lastUsage.inputTokens > 0 ? lastUsage.inputTokens : undefined
      const usingProviderMeter =
        priorProviderInput != null && compaction?.summary === priorSummary
      const contextUsageEv: AgentEvent = {
        type: 'context_usage',
        runId,
        step,
        estimatedTokens: assembled.estimatedTokens,
        inputTokens: usingProviderMeter ? priorProviderInput : assembled.estimatedTokens,
        contextWindow,
        contentWindow: effectiveContentWindow,
        compactionTrigger,
        source: usingProviderMeter ? 'provider' : 'estimate',
        ...(assembled.overflow ? { overflow: true } : {}),
        layers: assembled.layers
      }
      appendEvent(runDir, contextUsageEv)
      yield contextUsageEv

      let streamFinished = false
      let streamSteered = false
      let streamGotDone = false
      let lastStreamSnapshotAt = 0
      let lastStreamFailureMessage = ''
      let lastStreamFailureCode = 'PROVIDER_STREAM'
      let lastStreamFailureHttpStatus: number | undefined = undefined
      // Quota exhaustion is sticky across stream attempts: the wire 429 chunk
      // ("Weekly/5-hour usage limit reached...") goes terminal the moment it
      // is seen, but 429s from OTHER concurrent runs on the same key can also
      // land here via the circuit — capture from ANY failure chunk in the
      // step. Reset per step — it must not leak across steps.
      let stepQuotaExhausted = false
      let stepQuotaResetHorizon: string | null = null
      // Const capture so nested generators keep `string` (outer `runDir` is `string | null`).
      const streamRunDir = runDir
      if (!streamRunDir) {
        const message = 'Run directory missing'
        yield* emitTerminalRunError({
          runId,
          invokeId,
          runDir,
          message,
          code: 'INTERNAL',
          flushWriteCheckpoint,
          writeStatus
        })
        return
      }

      const streamRetryResult = yield* runWithStreamRetryGen({
        circuitKey: circuitKeyProvider(providerId, baseUrl),
        onAttemptStart: function* (attempt) {
          // Any prior attempt may have streamed text, thinking, or tool deltas —
          // tell the UI to drop all of it before the retry starts clean.
          // Persist the reset so hydrate does not rebuild stale tool_call_delta chrome.
          if (attempt > 1) {
            const resetEv: AgentEvent = { type: 'stream_reset', runId, step }
            appendEvent(streamRunDir, resetEv)
            persistedLiveToolIds.clear()
            yield resetEv
          }
          assistantText = ''
          thinkingText = ''
          lastStreamSnapshotAt = 0
          thinkingDoneEmitted = false
          stepReasoningState = undefined
          stepStopReason = undefined
          toolCalls.length = 0
          streamedToolCalls.clear()
          streamedToolCallIndex.clear()
          liveForwardedToolIds.clear()
          streamSteered = false
          streamGotDone = false
        },
        waitBeforeRetry: async function* (attempt) {
          yield* yieldStreamRetryWait(
            runId,
            invokeId,
            step,
            attempt,
            streamSignalFor(runId, controller.signal),
            streamRunDir,
            lastStreamFailureCode || 'PROVIDER_STREAM'
          )
        },
        onRetriableFailure: (err, attempt) => {
          logger.warn('Provider stream disconnected (retrying)', {
            scope: 'agent',
            code: 'PROVIDER_STREAM',
            correlationId: runId,
            provider: providerId,
            step,
            attempt,
            err
          })
        },
        runAttempt: async function* (attempt) {
          const runDir = streamRunDir
          const streamStartedAt = Date.now()
          try {
          for await (const chunk of provider.streamChat({
          model: settings.model,
          messages: assembled.messages,
          tools: toolDefs,
          system: assembled.system,
          systemStable: assembled.systemStable,
          systemVolatile: assembled.systemVolatile,
          signal: streamSignalFor(runId, controller.signal),
          apiKey,
          baseUrl,
          maxOutputTokens: requestMaxOutputTokens(providerId, modelInfo),
          anthropicNative: assembled.anthropicNative,
          toolChoice: toolDefs.length > 0 ? 'auto' : undefined,
          parallelToolCalls: toolDefs.length > 0 ? true : undefined,
          promptCacheKey: runId,
          modelInfo,
          reasoningState: lastReasoningState(messages),
          thinking: thinkingEnabled
            ? {
                enabled: true,
                effort: settings.thinkingEffort,
                display: settings.showThinking ? 'summarized' : 'omitted'
              }
            : { enabled: false },
          serviceTier: resolveServiceTier(settings, providerId, settings.model)
        })) {
          if (controller.signal.aborted) break
          // Soft-steer: break so we can flush partial output and inject follow-ups.
          if (hasReadyFollowUps(runId) || stepSoftAbort.signal.aborted) {
            streamSteered = true
            break
          }
          // Throttled durable snapshot of in-flight output — a hard kill loses
          // at most STREAM_SNAPSHOT_INTERVAL_MS of assistant text (recoverable
          // from events.jsonl even before the step completes).
          const nowMs = Date.now()
          if (nowMs - lastStreamSnapshotAt >= STREAM_SNAPSHOT_INTERVAL_MS) {
            lastStreamSnapshotAt = nowMs
            // Snapshot the recoverable answer text only. Re-carrying the growing
            // reasoning text on every interval duplicated those bytes ~2x per
            // second of thinking on disk, and no reader consumes snapshot
            // thinking; completed reasoning lives in messages.jsonl.
            if (assistantText) {
              appendEvent(runDir, {
                type: 'stream_snapshot',
                runId,
                invokeId,
                step,
                text: assistantText
              })
            }
          }
          if (chunk.type === 'text' && chunk.text) {
            assistantText += chunk.text
            yield { type: 'text_delta', runId, text: chunk.text }
          } else if (chunk.type === 'thinking_delta' && chunk.text) {
            thinkingText += chunk.text
            yield { type: 'thinking_delta', runId, text: chunk.text, step }
          } else if (chunk.type === 'thinking_done') {
            // Anthropic emits one thinking_done per thinking block; append the
            // new segment instead of overwriting, guarded against providers
            // whose done text repeats the whole streamed buffer (OpenAI-compat
            // message snapshots) — those must stay a single replace.
            if (chunk.text) {
              const doneText = chunk.text
              if (
                !thinkingText ||
                doneText === thinkingText ||
                doneText.startsWith(thinkingText)
              ) {
                thinkingText = doneText
              } else if (!thinkingText.endsWith(doneText)) {
                thinkingText = `${thinkingText}\n\n${doneText}`
              }
            }
            if (!thinkingDoneEmitted) {
              thinkingDoneEmitted = true
              const thinkingDoneEv: AgentEvent = {
                type: 'thinking_done',
                runId,
                text: (thinkingText || chunk.text) ?? undefined,
                step
              }
              appendEvent(runDir, thinkingDoneEv)
              yield thinkingDoneEv
            }
          } else if (chunk.type === 'tool_call_delta' && chunk.toolCallDelta) {
            const delta = chunk.toolCallDelta
            let toolCallId = delta.id?.trim() || ''
            if (!toolCallId && typeof delta.index === 'number') {
              toolCallId = streamedToolCallIndex.get(delta.index) ?? ''
            }
            if (!toolCallId) {
              toolCallId =
                typeof delta.index === 'number'
                  ? `pending_${delta.index}`
                  : `pending_${streamedToolCalls.size}`
            }
            if (typeof delta.index === 'number') {
              if (delta.id?.trim()) {
                streamedToolCallIndex.set(delta.index, delta.id.trim())
              } else if (!streamedToolCallIndex.has(delta.index)) {
                streamedToolCallIndex.set(delta.index, toolCallId)
              }
            }
            liveForwardedToolIds.add(toolCallId)
            const argumentsDelta = delta.arguments ?? ''
            accumulateStreamedToolDelta(streamedToolCalls, toolCallId, {
              name: delta.name,
              arguments: argumentsDelta
            })
            persistLiveToolChrome(toolCallId, delta.name, argumentsDelta)
            yield {
              type: 'tool_call_delta',
              runId,
              toolCallId,
              name: delta.name || undefined,
              argumentsDelta
            }
          } else if (chunk.type === 'tool_call' && chunk.toolCall) {
            const [ensured] = ensureToolCallIds([chunk.toolCall], {
              step,
              prefix: 'call'
            })
            const tc = ensured ?? chunk.toolCall
            const prevArgs = streamedToolCalls.get(tc.id)?.arguments ?? ''
            accumulateStreamedToolDelta(streamedToolCalls, tc.id, {
              name: tc.name,
              arguments: tc.arguments
            })
            toolCalls.push(tc)
            // Chrome-only tool_call_delta (name, empty args) marks the id live.
            // A later complete tool_call must still forward the new suffix —
            // otherwise the UI stays on "Receiving edit…" until assistant_message.
            // Duplicate complete payloads yield an empty suffix (no double concat).
            const already = liveForwardedToolIds.has(tc.id)
            liveForwardedToolIds.add(tc.id)
            const merged = mergeOpenAiCompatToolArgDelta(prevArgs, tc.arguments)
            const argumentsDelta = already ? merged.yieldDelta : merged.arguments
            persistLiveToolChrome(tc.id, tc.name, argumentsDelta || tc.arguments || '')
            yield {
              type: 'tool_call_delta',
              runId,
              toolCallId: tc.id,
              name: tc.name || undefined,
              argumentsDelta
            }
          } else if (chunk.type === 'done') {
            streamGotDone = true
            if (chunk.reasoningState) stepReasoningState = chunk.reasoningState
            if (chunk.stopReason) stepStopReason = chunk.stopReason
            if (chunk.usage) {
              lastUsage = chunk.usage
              if (chunk.usage.inputTokens && chunk.usage.inputTokens > 0) {
                providerInputTokens = chunk.usage.inputTokens
              }
              const generationMs = Math.max(0, Date.now() - streamStartedAt)
              const cacheFieldsPresent =
                chunk.usage.cachedInputTokens != null ||
                chunk.usage.cacheCreationInputTokens != null
              const layers = {
                system: assembled.layers.system,
                history: assembled.layers.history,
                tools: assembled.layers.tools,
                buffer: assembled.layers.buffer
              }
              const hotspot = classifyTokenCostHotspot(layers)
              const stepPartial = stepUsageFromEvent({
                type: 'step_usage',
                runId,
                step,
                inputTokens: chunk.usage.inputTokens,
                ...(chunk.usage.inputTokensIncludesCache !== undefined
                  ? { inputTokensIncludesCache: chunk.usage.inputTokensIncludesCache }
                  : {}),
                outputTokens: chunk.usage.outputTokens,
                cachedInputTokens: chunk.usage.cachedInputTokens,
                cacheCreationInputTokens: chunk.usage.cacheCreationInputTokens,
                reasoningTokens: chunk.usage.reasoningTokens,
                generationMs,
                ...(chunk.usage.billedCost != null ? { billedCost: chunk.usage.billedCost } : {}),
                ...(chunk.usage.billedCostSaved != null
                  ? { billedCostSaved: chunk.usage.billedCostSaved }
                  : {})
              })
              if (stepPartial) {
                if (cacheFieldsPresent && stepPartial.stepsWithCacheReport === 0) {
                  stepPartial.stepsWithCacheReport = 1
                }
                costTotals = mergeStepUsageTotals(costTotals, stepPartial)
                persistUsageTotalsCheckpoint()
              }
              const usageEv: AgentEvent = {
                type: 'step_usage',
                runId,
                step,
                inputTokens: chunk.usage.inputTokens,
                ...(chunk.usage.inputTokensIncludesCache !== undefined
                  ? { inputTokensIncludesCache: chunk.usage.inputTokensIncludesCache }
                  : {}),
                outputTokens: chunk.usage.outputTokens,
                cachedInputTokens: chunk.usage.cachedInputTokens,
                cacheCreationInputTokens: chunk.usage.cacheCreationInputTokens,
                reasoningTokens: chunk.usage.reasoningTokens,
                generationMs,
                ...(chunk.usage.billedCost != null ? { billedCost: chunk.usage.billedCost } : {}),
                ...(chunk.usage.billedCostSaved != null
                  ? { billedCostSaved: chunk.usage.billedCostSaved }
                  : {}),
                billedInputTokens: costTotals.billedInputTokens,
                peakInputTokens: costTotals.peakInputTokens,
                cacheReported: cacheFieldsPresent,
                hotspot,
                messagesCount: assembled.messages.length,
                toolDefCount: toolDefs.length,
                toolResultCharsKept: countKeptToolResultChars(assembled.messages),
                compactionCountThisRun,
                layers
              }
              appendEvent(runDir, usageEv)
              yield usageEv
              const hitRate = stepCacheHitRate(
                chunk.usage.inputTokens,
                chunk.usage.cachedInputTokens,
                cacheFieldsPresent
              )
              const inputTok = chunk.usage.inputTokens ?? 0
              if (hitRate != null && inputTok >= LARGE_STEP_INPUT_THRESHOLD) {
                pushRecentLargeCacheHit(recentLargeCacheHits, hitRate)
              }
              logger.info('Token cost step', {
                scope: 'agent',
                correlationId: runId,
                provider: providerId,
                model: settings.model,
                step,
                inputTokens: chunk.usage.inputTokens,
                outputTokens: chunk.usage.outputTokens,
                reasoningTokens: chunk.usage.reasoningTokens,
                cachedInputTokens: chunk.usage.cachedInputTokens,
                cacheCreationInputTokens: chunk.usage.cacheCreationInputTokens,
                cacheReported: cacheFieldsPresent,
                cacheHitRateStep: hitRate,
                billedInputTokens: costTotals.billedInputTokens,
                peakInputTokens: costTotals.peakInputTokens,
                hotspot,
                layers,
                messagesCount: assembled.messages.length,
                toolDefCount: toolDefs.length,
                toolResultCharsKept: countKeptToolResultChars(assembled.messages),
                compactionCountThisRun
              })
              for (const warn of evaluateTokenCostWarnings({
                estimatedTokens: chunk.usage.inputTokens ?? assembled.estimatedTokens,
                compactionTrigger,
                contentWindow: effectiveContentWindow,
                compactedThisRun: compactionCountThisRun > 0,
                cacheHitRate: hitRate,
                stepsWithCacheReport: costTotals.stepsWithCacheReport,
                largeInput: inputTok >= LARGE_STEP_INPUT_THRESHOLD,
                recentLargeStepCacheHitRates: recentLargeCacheHits,
                thinkingEnabled: Boolean(settings.thinkingEnabled),
                thinkingEffortHigh,
                step,
                billedInputTokens: costTotals.billedInputTokens
              })) {
                // High thinking / long-run boundary re-notify on buckets; other kinds once.
                const warnOnceKey =
                  warn.kind === 'high_thinking_on_long_run'
                    ? `${warn.kind}:${Math.floor(step / 15)}`
                    : warn.kind === 'long_run_task_boundary'
                      ? `${warn.kind}:${Math.floor(step / 40)}`
                      : warn.kind
                if (costWarnOnce.has(warnOnceKey)) continue
                costWarnOnce.add(warnOnceKey)
                logger.warn(`Token cost: ${warn.message}`, {
                  scope: 'agent',
                  code: 'TOKEN_COST',
                  correlationId: runId,
                  kind: warn.kind,
                  step
                })
              }
              const providerContextEv: AgentEvent = {
                type: 'context_usage',
                runId,
                step,
                estimatedTokens: assembled.estimatedTokens,
                inputTokens: chunk.usage.inputTokens ?? assembled.estimatedTokens,
                contextWindow,
                contentWindow: effectiveContentWindow,
                compactionTrigger,
                source: 'provider',
                layers: assembled.layers,
                ...(assembled.overflow ? { overflow: true } : {})
              }
              appendEvent(runDir, providerContextEv)
              yield providerContextEv
              if (
                (chunk.usage.cachedInputTokens && chunk.usage.cachedInputTokens > 0) ||
                (chunk.usage.cacheCreationInputTokens &&
                  chunk.usage.cacheCreationInputTokens > 0)
              ) {
                logger.info('Prompt cache', {
                  scope: 'agent',
                  correlationId: runId,
                  provider: providerId,
                  step,
                  cachedInputTokens: chunk.usage.cachedInputTokens,
                  cacheCreationInputTokens: chunk.usage.cacheCreationInputTokens,
                  inputTokens: chunk.usage.inputTokens
                })
              }
            }
          } else if (chunk.type === 'error') {
            const message = chunk.error ?? 'Provider error'
            // 401/402/403 must arrive pre-mapped to PROVIDER_AUTH / PROVIDER_BILLING
            // (see providerHttpErrorCode): they are permanent user-action failures,
            // and leaving them on the retryable PROVIDER_HTTP code would render a
            // Retry affordance that can never succeed.
            const errorCode =
              chunk.errorCode === 'PROVIDER_HTTP'
                ? providerHttpErrorCode(chunk.httpStatus)
                : chunk.errorCode === 'PROVIDER_NETWORK' ||
                    chunk.errorCode === 'PROVIDER_TIMEOUT' ||
                    chunk.errorCode === 'CIRCUIT_OPEN'
                  ? chunk.errorCode
                  : 'PROVIDER_STREAM'
            lastStreamFailureHttpStatus = chunk.httpStatus
            if (isQuotaExhaustedMessage(message)) {
              stepQuotaExhausted = true
              stepQuotaResetHorizon = parseQuotaResetHorizon(message) ?? stepQuotaResetHorizon
            }
            // A usage-limit 429 is a billing gate, not a transient outage: stop
            // TERMINALLY (non-resumable) the moment it is seen. Burning stream
            // attempts (and tripping the circuit) only delays the stop and
            // re-bills the full prompt on retries that cannot succeed (runs
            // f086bc66 / c3290c9d, 2026-09-01: 429 → attempt 2 → circuit open →
            // terminal). Flushed partial output is preserved; queued follow-ups
            // are dropped — a quota resume is a user "continue", not an
            // automatic replay (same gate blocks the goal relaunch storm of run
            // 6265fa90).
            if (stepQuotaExhausted) {
              logger.warn('Provider quota exhausted — stopping without retries', {
                scope: 'agent',
                code: 'QUOTA_EXHAUSTED',
                correlationId: runId,
                provider: providerId,
                step
              })
              yield* yieldQuotaExhaustedTerminal(
                runId,
                invokeId,
                step,
                runDir,
                messages,
                assistantText,
                thinkingText,
                stepReasoningState,
                toolCalls,
                streamedToolCalls,
                stepQuotaResetHorizon,
                flushWriteCheckpoint,
                writeStatus
              )
              return 'terminal'
            }
            if (errorCode === 'PROVIDER_NETWORK') {
              // Retriable at the stream layer now — record so a final exhaust
              // classifies as networkRelated (interrupted, not hard error).
              lastStreamFailureMessage = message
              lastStreamFailureCode = errorCode
            }
            if (shouldRetryStreamErrorChunk(errorCode, message, attempt, chunk.httpStatus)) {
              lastStreamFailureMessage = message
              lastStreamFailureCode = errorCode
              logger.warn('Provider stream error (retrying)', {
                scope: 'agent',
                code: errorCode,
                correlationId: runId,
                provider: providerId,
                step,
                attempt
              })
              return 'retry'
            }
            logger.error('Provider stream error', {
              scope: 'agent',
              code: errorCode,
              correlationId: runId,
              provider: providerId,
              step,
              message: message.slice(0, 280)
            })
            // A retriable status that exhausted its attempts (429/408/5xx) is a
            // transient provider-side wait — interrupted + Continue, not a hard error.
            if (
              isNetworkFailureCode(errorCode) ||
              errorCode === 'CIRCUIT_OPEN' ||
              errorCode === 'PROVIDER_TIMEOUT' ||
              (errorCode === 'PROVIDER_HTTP' && isTransientHttpFailure(errorCode, chunk.httpStatus))
            ) {
              yield* yieldNetworkInterruptedTerminal(
                runId,
                invokeId,
                step,
                runDir,
                messages,
                assistantText,
                thinkingText,
                stepReasoningState,
                toolCalls,
                streamedToolCalls,
                message,
                errorCode,
                flushWriteCheckpoint,
                writeStatus,
                errorCode === 'CIRCUIT_OPEN'
                  ? 'circuit_open'
                  : errorCode === 'PROVIDER_HTTP' && !isNetworkFailureCode(errorCode)
                    ? 'provider_error'
                    : 'network_interrupted'
              )
              return 'terminal'
            }
            yield* flushPartialAssistant(
              runId,
              runDir,
              messages,
              assistantText,
              thinkingText,
              stepReasoningState,
              toolCalls,
              streamedToolCalls,
              step,
              'interrupted'
            )
            yield* emitTerminalRunError({
              runId,
              invokeId,
              runDir,
              message,
              code: errorCode,
              dropFollowUpsReason: errorCode,
              flushWriteCheckpoint,
              writeStatus
            })
            return 'terminal'
          }
        }
      } catch (err) {
          if (isStreamIdleTimeoutError(err)) {
            const message = err.message
            logger.error('Provider stream idle timeout', {
              scope: 'agent',
              code: 'PROVIDER_TIMEOUT',
              correlationId: runId,
              provider: providerId,
              step,
              idleMs: err.idleMs,
              attempt
            })
            // A silent provider stall is usually transient — retry like any other
            // stream failure. Returning 'retry' on the final attempt classifies as
            // 'exhausted', which lands in the interrupted branch (Continue UX).
            lastStreamFailureMessage = message
            lastStreamFailureCode = 'PROVIDER_TIMEOUT'
            lastStreamFailureHttpStatus = undefined
            return 'retry'
          }
          if (
            shouldRetryThrownStreamError(err, attempt) ||
            (!isAbortError(err) && isRetriableStreamFailure(err))
          ) {
            lastStreamFailureMessage = err instanceof Error ? err.message : String(err)
            lastStreamFailureCode = 'PROVIDER_STREAM'
            throw err
          }
          // Providers rethrow AbortError from SSE readers — treat like an in-loop cancel.
          if (!isAbortError(err)) {
            // Save what already streamed before the throw unwinds to the outer handler,
            // which no longer has access to this step's buffers.
            yield* flushPartialAssistant(
              runId,
              runDir,
              messages,
              assistantText,
              thinkingText,
              stepReasoningState,
              toolCalls,
              streamedToolCalls,
              step,
              'interrupted'
            )
            throw err
          }
          // Soft follow-up interrupt (stepSoftAbort) vs full run cancel.
          if (
            !controller.signal.aborted &&
            (hasReadyFollowUps(runId) || stepSoftAbort.signal.aborted)
          ) {
            streamSteered = true
          }
          return 'complete'
        }

          return 'complete'
        }
      })

      if (streamRetryResult.status === 'terminal') return
      streamFinished = streamRetryResult.status === 'complete'
      if (
        streamRetryResult.status === 'exhausted' &&
        isCircuitOpenError(streamRetryResult.err)
      ) {
        lastStreamFailureMessage = streamRetryResult.err.message
        lastStreamFailureCode = 'CIRCUIT_OPEN'
      }

      // Soft-steer may end the provider generator cleanly (return after abort)
      // without throwing — still treat as steered so partial tools are not
      // fingerprinted for identical-step LOOP_SAFETY. Skip when a `done` chunk
      // already arrived (follow-up queued after a complete stream step).
      if (
        !streamSteered &&
        !streamGotDone &&
        !controller.signal.aborted &&
        (hasReadyFollowUps(runId) || stepSoftAbort.signal.aborted)
      ) {
        streamSteered = true
      }

      // Exhausted retriable stream attempts — network failures get Continue UX.
      if (!streamFinished && !controller.signal.aborted && !streamSteered) {
        const message =
          lastStreamFailureMessage.trim() ||
          `Provider stream failed after ${MAX_STREAM_ATTEMPTS} attempts`
        const errorCode = lastStreamFailureCode || 'PROVIDER_STREAM'
        const transientHttp = isTransientHttpFailure(errorCode, lastStreamFailureHttpStatus)
        const networkRelated =
          isNetworkFailureCode(errorCode) ||
          errorCode === 'PROVIDER_TIMEOUT' ||
          transientHttp ||
          (lastStreamFailureMessage.trim().length > 0 &&
            isRetriableProviderMessage(lastStreamFailureMessage))
        const circuitOpen = errorCode === 'CIRCUIT_OPEN'
        logger.error(message, {
          scope: 'agent',
          code: errorCode,
          correlationId: runId,
          provider: providerId,
          step,
          networkRelated
        })
        // Quota exhaustion seen during the exhausted attempts: stop terminally
        // (a billing gate cannot clear within a circuit window). Same contract
        // as the in-stream branch above.
        if (stepQuotaExhausted) {
          yield* yieldQuotaExhaustedTerminal(
            runId,
            invokeId,
            step,
            runDir,
            messages,
            assistantText,
            thinkingText,
            stepReasoningState,
            toolCalls,
            streamedToolCalls,
            stepQuotaResetHorizon,
            flushWriteCheckpoint,
            writeStatus
          )
          return
        }
        if (networkRelated || circuitOpen) {
          yield* yieldNetworkInterruptedTerminal(
            runId,
            invokeId,
            step,
            runDir,
            messages,
            assistantText,
            thinkingText,
            stepReasoningState,
            toolCalls,
            streamedToolCalls,
            message,
            errorCode,
            flushWriteCheckpoint,
            writeStatus,
            circuitOpen
              ? 'circuit_open'
              : transientHttp && !isNetworkFailureCode(errorCode)
                ? 'provider_error'
                : 'network_interrupted'
          )
          return
        }
        yield* flushPartialAssistant(
          runId,
          runDir,
          messages,
          assistantText,
          thinkingText,
          stepReasoningState,
          toolCalls,
          streamedToolCalls,
          step,
          'interrupted'
        )
        yield* emitTerminalRunError({
          runId,
          invokeId,
          runDir,
          message,
          code: errorCode,
          dropFollowUpsReason: errorCode,
          flushWriteCheckpoint,
          writeStatus
        })
        return
      }

      if (controller.signal.aborted) {
        clearFollowUps(runId)
        yield* flushPartialAssistant(
          runId,
          runDir,
          messages,
          assistantText,
          thinkingText,
          stepReasoningState,
          toolCalls,
          streamedToolCalls,
          step,
          'cancelled'
        )
        break
      }

      // Mid-stream steer: keep the turn alive, flush partial output, then inject.
      // Do not bump identicalStepStreak or LOOP_SAFETY here — partial tool calls
      // never executed; prefer applying the follow-up over dropping it.
      if (streamSteered) {
        yield* flushPartialAssistant(
          runId,
          runDir,
          messages,
          assistantText,
          thinkingText,
          stepReasoningState,
          toolCalls,
          streamedToolCalls,
          step,
          'interrupted'
        )
        yield* applyDrainedFollowUps(runId, runDir, messages)
        continue
      }

      // Quarantine a script-corrupted `done` payload before persist/replay;
      // clear the display buffer to match. The live thinking_done event already
      // streamed to the UI is unavoidable — corruption is only detectable once
      // the block is complete.
      const quarantined = quarantineReasoningState(stepReasoningState)
      if (quarantined !== stepReasoningState) {
        logReasoningQuarantine(runId, step)
        stepReasoningState = quarantined
        if (isScriptCorruptedReasoning(thinkingText)) {
          thinkingText = ''
          thinkingDoneEmitted = true
        }
      }

      const uniqueToolCalls = resolveStepToolCalls(toolCalls, streamedToolCalls, step)

      if (uniqueToolCalls.length > 0) {
        goalNoToolFinishes = 0
        ensureToolCallIds(uniqueToolCalls, { prefix: 'call_guard' })

        const stepFingerprint = stepToolCallsFingerprint(uniqueToolCalls)
        identicalStepStreak = nextIdenticalStepStreak(
          lastStepFingerprint,
          identicalStepStreak,
          stepFingerprint
        )
        lastStepFingerprint = stepFingerprint
        identicalStepLoopHint = loopHintForIdenticalStepStreak(identicalStepStreak)
        const repeatStop = loopStopDecision({ step, identicalStepStreak })
        // Terminal identical-step repeat (≥ MAX_IDENTICAL_STEP_STREAK_TERMINAL):
        // flush this step's partial output, then stop. Below the ceiling the
        // escalating hint steers instead.
        if (repeatStop) {
          yield* flushPartialAssistant(
            runId,
            runDir,
            messages,
            assistantText,
            thinkingText,
            stepReasoningState,
            uniqueToolCalls,
            streamedToolCalls,
            step,
            'interrupted'
          )
          yield* stopForLoopSafety(repeatStop)
          return
        }
      } else {
        identicalStepStreak = 0
        lastStepFingerprint = ''
        identicalStepLoopHint = undefined
      }

      if (uniqueToolCalls.length === 0) {
        if (thinkingText && !thinkingDoneEmitted) {
          thinkingDoneEmitted = true
          const thinkingDoneEv: AgentEvent = {
            type: 'thinking_done',
            runId,
            text: thinkingText,
            step
          }
          appendEvent(runDir, thinkingDoneEv)
          yield thinkingDoneEv
        }
        const scrubbedAssistantText = stripToolShapedAssistantText(assistantText)
        // Reasoning persists once (see the tool-call path above): `reasoningState`
        // on the message, with `thinking` kept only when the payload carries no
        // recoverable text.
        const assistant: ChatMessage = {
          role: 'assistant',
          content: scrubbedAssistantText,
          ...(!thinkingFromReasoningState(stepReasoningState) && thinkingText
            ? { thinking: thinkingText }
            : {}),
          ...(stepReasoningState ? { reasoningState: stepReasoningState } : {})
        }
        messages.push(assistant)
        appendMessage(runDir, assistant)
        const assistantMsgEv: AgentEvent = {
          type: 'assistant_message',
          runId,
          content: scrubbedAssistantText,
          ...(thinkingText ? { thinking: thinkingText } : {})
        }
        appendEvent(runDir, assistantMsgEv)
        yield assistantMsgEv

        const incomplete = classifyIncompleteTurn(stepStopReason, scrubbedAssistantText)
        if (incomplete === 'truncated' && !controller.signal.aborted) {
          truncationContinues += 1
          persistLoopCheckpoint()
          if (truncationContinues > MAX_TRUNCATION_CONTINUES) {
            logger.warn('Stopping auto-continue after repeated truncation', {
              scope: 'agent',
              correlationId: runId,
              step,
              truncationContinues
            })
            // Do not continue; fall through so the turn ends with an incomplete event
            // instead of looping forever and burning tokens.
          } else {
            logger.info('Auto-continuing after truncation', {
              scope: 'agent',
              correlationId: runId,
              step,
              truncationContinues
            })
            const continueEv: AgentEvent = {
              type: 'incomplete',
              runId,
              invokeId,
              reason: 'truncated',
              step,
              message: 'Output was truncated; continuing automatically…'
            }
            appendEvent(runDir, continueEv)
            yield continueEv
            const continueUser: ChatMessage = {
              role: 'user',
              content: 'Continue from where you left off. Finish without repeating.',
              // Loop-injected protocol turn — must never render as a user bubble.
              synthetic: true
            }
            messages.push(continueUser)
            appendMessage(runDir, continueUser)
            continue
          }
        }

        if (incomplete === 'empty_response' && !controller.signal.aborted) {
          emptyResponseContinues += 1
          // Persist immediately (matches truncationContinues): this continue
          // path bypasses the post-tool checkpoint write, so a crash would
          // otherwise restore a stale count and re-burn empty steps.
          persistLoopCheckpoint()
          if (emptyResponseContinues > MAX_EMPTY_RESPONSE_CONTINUES) {
            logger.warn('Stopping auto-continue after repeated empty response', {
              scope: 'agent',
              correlationId: runId,
              step,
              emptyResponseContinues
            })
            // Do not continue; fall through so the turn ends with an incomplete event.
          } else {
            logger.info('Auto-continuing after empty response', {
              scope: 'agent',
              correlationId: runId,
              step,
              emptyResponseContinues
            })
            const continueEv: AgentEvent = {
              type: 'incomplete',
              runId,
              invokeId,
              reason: 'empty_response',
              step,
              message: 'Model returned an empty response; retrying…'
            }
            appendEvent(runDir, continueEv)
            yield continueEv
            // Drop empty assistant from in-memory history and rewrite disk so
            // resume/hydrate does not see a blank turn the working list no longer has.
            // "Empty" = no user-visible text and no tool calls. Reasoning is not
            // an answer, so discard reasoning-only turns before retrying.
            const last = messages[messages.length - 1]
            if (
              last?.role === 'assistant' &&
              !contentToText(last.content).trim() &&
              !last.toolCalls?.length
            ) {
              messages.pop()
            }
            // Retry the SAME request: no injected user message. Fabricating a
            // "Your previous response was empty…" user turn leaked protocol text
            // into messages.jsonl (rendered as a user bubble) and taught the model
            // a phantom turn; re-streaming the unchanged history is the honest retry.
            // Rewrite from DISK, not the working set: after mid-run compaction the
            // working list is post-fold and a sync here would permanently drop the
            // folded head from messages.jsonl (breaking rewind indices and the
            // stitched transcript).
            if (foldedMessages > 0) {
              const diskMessages = await loadMessagesAsync(workspace, runId)
              const diskLast = diskMessages[diskMessages.length - 1]
              if (
                diskLast?.role === 'assistant' &&
                !contentToText(diskLast.content).trim() &&
                !diskLast.toolCalls?.length
              ) {
                diskMessages.pop()
              }
              await syncMessagesAsync(runDir, diskMessages)
            } else {
              await syncMessagesAsync(runDir, messages)
            }
            continue
          }
        }

        if (controller.signal.aborted) break

        if (agentMode === 'plan' && planUnreadyNudges < 2) {
          const planRaw = await readPlanRawAsync(runDir)
          // Draft-ready but structurally shallow plans get the same capped
          // nudge budget as missing plans, with the top quality issues named.
          const quality = isPlanDraftReady(planRaw) ? scorePlanQuality(planRaw) : null
          if (quality === null || quality.issues.length > 0) {
            planUnreadyNudges += 1
            const nudge: ChatMessage = {
              role: 'user',
              content:
                quality === null
                  ? 'Call `create_plan` with Goal, Steps, and Done when. Do not put the plan only in chat.'
                  : `Plan published but shallow — refine it with \`create_plan\`. Top issues: ${quality.issues.slice(0, 2).join(' ')}`,
              // Loop-injected protocol turn — must never render as a user bubble.
              synthetic: true
            }
            messages.push(nudge)
            appendMessage(runDir, nudge)
            continue
          }
        }

        // Queued follow-ups at turn end auto-apply and continue the run.
        if (hasPendingFollowUps(runId)) {
          yield* applyDrainedFollowUps(runId, runDir, messages, 'next')
          continue
        }

        if (incomplete) {
          const incompleteEv: AgentEvent = {
            type: 'incomplete',
            runId,
            invokeId,
            reason: incomplete,
            step,
            message: INCOMPLETE_MESSAGES[incomplete]
          }
          logger.warn(
            `Turn ended incomplete: ${incomplete} (textLen=${assistantText.length}; thinkLen=${thinkingText.length})`,
            {
              scope: 'agent',
              code: 'AGENT_INCOMPLETE',
              correlationId: runId,
              provider: providerId,
              step,
              stopReason: stepStopReason ?? 'unset'
            }
          )
          appendEvent(runDir, incompleteEv)
          yield incompleteEv
        }

        yield* flushWriteCheckpoint()
        // Atomically close for follow-ups (or drain and continue) — avoids the
        // TOCTOU window between hasPendingFollowUps and markRunTurnComplete.
        const closeTurn = tryBeginRunClosing(runId, invokeId)
        if (closeTurn === 'has_followups') {
          const applied = yield* applyDrainedFollowUps(runId, runDir, messages, 'next')
          if (applied) {
            checkpointFlushed = false
            // Anchor AFTER draining so the checkpoint covers the follow-up turn's
            // own prompt (rewind/edit of that prompt must restore its writes).
            beginWriteCheckpoint(runDir, toolWorkspace, lastUserAnchorIndex(messages, foldedMessages))
            continue
          }
          // The queued follow-up was removed between tryBeginRunClosing and the
          // take — close the turn and fall through to done instead of re-
          // streaming an unchanged transcript (a duplicated answer + tokens).
          markRunTurnComplete(runId, invokeId)
        }
        if (!incomplete && !isInlineInstance && closeTurn === 'closed') {
          const activeGoal = readGoal(runDir)
          const nextStreak = goalNoToolFinishes + 1
          const decision = shouldAutoContinueActiveGoal({
            goalStatus: activeGoal?.status,
            agentMode,
            incomplete: false,
            consecutiveNoToolFinishes: nextStreak
          })
          if (decision === 'continue' && activeGoal && reopenRunTurn(runId, invokeId)) {
            goalNoToolFinishes = nextStreak
            bumpGoalContinueCount(runDir)
            const continueUser: ChatMessage = {
              role: 'user',
              content: formatGoalContinueMessage(activeGoal.objective),
              // Loop-injected protocol turn — must never render as a user bubble.
              synthetic: true
            }
            messages.push(continueUser)
            appendMessage(runDir, continueUser)
            checkpointFlushed = false
            beginWriteCheckpoint(runDir, toolWorkspace, lastUserAnchorIndex(messages, foldedMessages))
            continue
          }
          if (decision === 'stop_wait' && activeGoal) {
            goalNoToolFinishes = nextStreak
            const goalWaitMessage = INCOMPLETE_MESSAGES.goal_wait
            emitGoalUpdate({
              workspacePath: workspace,
              runId,
              runDir,
              goal: activeGoal,
              notice: goalWaitMessage
            })
            // Durable, chat-visible stop reason (was toast-only, run 6265fa90
            // audit): the renderer builds its banner + Continue affordance from
            // the persisted incomplete event, so the reason survives restarts
            // instead of vanishing with the toast.
            const goalWaitEv: AgentEvent = {
              type: 'incomplete',
              runId,
              invokeId,
              reason: 'goal_wait',
              step,
              message: goalWaitMessage
            }
            appendEvent(runDir, goalWaitEv)
            yield goalWaitEv
          }
        }
        // Surface disk append failures before claiming done — otherwise the UI
        // shows success while messages.jsonl silently lost the last turns.
        try {
          await flushMessageAppends(runDir)
          await flushEventAppends(runDir)
        } catch (persistErr) {
          const message = `Failed to persist run transcript: ${formatError(persistErr)}`
          logger.error(message, {
            scope: 'agent',
            code: 'PERSIST',
            correlationId: runId,
            err: persistErr
          })
          yield* emitTerminalRunError({
            runId,
            invokeId,
            runDir,
            message,
            code: 'PERSIST',
            dropFollowUpsReason: 'PERSIST',
            skipCheckpoint: true,
            flushWriteCheckpoint,
            writeStatus
          })
          return
        }
        runExitedNormally = true
        clearLoopCheckpoint(runDir)
        yield { type: 'status', runId, invokeId, status: 'done' }
        writeStatus({ status: 'done', error: undefined })
        appendEvent(runDir, { type: 'status', runId, invokeId, status: 'done' })
        return
      }

      const mappedCalls = uniqueToolCalls.map((t) => ({
        id: t.id,
        name: t.name,
        arguments: t.arguments
      }))
      const scrubbedAssistantText = stripToolShapedAssistantText(assistantText)
      // Persist reasoning once: `reasoningState` is the wire-replay source of
      // truth (in memory and on disk); `thinking` is only its human-readable
      // view and is kept solely when the payload carries no recoverable text.
      // Storing both carried the same words twice on every transcript row.
      const derivedThinking = thinkingFromReasoningState(stepReasoningState)
      const assistantWithTools: ChatMessage = {
        role: 'assistant',
        content: scrubbedAssistantText,
        toolCalls: mappedCalls,
        ...(!derivedThinking && thinkingText ? { thinking: thinkingText } : {}),
        ...(stepReasoningState ? { reasoningState: stepReasoningState } : {})
      }
      messages.push(assistantWithTools)
      appendMessage(runDir, assistantWithTools)
      await flushMessageAppends(runDir)
      if (yield* emitMessageAppendFailureNotice(runId, runDir, invokeId)) {
        yield* emitTerminalRunError({
          runId,
          invokeId,
          runDir,
          message: 'Failed to persist assistant message before tool execution',
          emitErrorEvent: false,
          flushWriteCheckpoint,
          writeStatus
        })
        return
      }
      try {
        await flushEventAppends(runDir)
      } catch {
        // Failure is recorded for emitEventAppendFailureNotice below.
      }
      if (yield* emitEventAppendFailureNotice(runId, runDir, invokeId)) {
        yield* emitTerminalRunError({
          runId,
          invokeId,
          runDir,
          message: 'Failed to persist run event before tool execution',
          emitErrorEvent: false,
          flushWriteCheckpoint,
          writeStatus
        })
        return
      }
      if (thinkingText && !thinkingDoneEmitted) {
        thinkingDoneEmitted = true
        const thinkingDoneEv: AgentEvent = {
          type: 'thinking_done',
          runId,
          text: thinkingText,
          step
        }
        appendEvent(runDir, thinkingDoneEv)
        yield thinkingDoneEv
      }
      const assistantMsgEv: AgentEvent = {
        type: 'assistant_message',
        runId,
        content: scrubbedAssistantText,
        ...(thinkingText ? { thinking: thinkingText } : {}),
        toolCalls: mappedCalls
      }
      appendEvent(runDir, assistantMsgEv)
      yield assistantMsgEv

      // Long-running tools emit live progress while the step await is blocked.
      // Queue those events and drain them between wakeups instead of holding
      // them until the batch settles.
      const liveEvents: AgentEvent[] = []
      const liveToolResultsEmitted = new Set<string>()
      let wakeLiveEvents: (() => void) | null = null

      // Execute tool calls as streamed from the provider.
      const callsToExecute = uniqueToolCalls

      const toolCtx = {
        runId,
        runDir: runDir!,
        workspace: toolWorkspace,
        sessionWorkspace: workspace,
        inlineInstance: isInlineInstance,
        signal: streamSignalFor(runId, controller.signal),
        runSignal: controller.signal,
        invokeId,
        knownPaths,
        mutationPaths,
        recentReadPaths,
        readStampStep: step,
        appendMessage: async (msg: ChatMessage) => {
          await appendMessage(runDir!, msg)
          // Surface persist failures before the next tool mutates the workspace.
          await flushMessageAppends(runDir!)
        },
        appendEvent: (ev: AgentEvent) => appendEvent(runDir!, ev),
        approval: approvalGate,
        agentMode,
        getAgentMode: () => agentMode,
        setAgentMode: (mode: AgentInteractionMode) => {
          agentMode = mode
          const dir = runDir
          if (mode === 'plan' && dir) seedPlanStubIfMissing(dir)
          return writeStatus({ mode })
        },
        autoModeSwitch: settings.autoModeSwitch,
        terminalShell: settings.terminalShell,
        diagnosticsCommand: settings.diagnosticsCommand,
        invokeSettings: settings,
        runEnabledMcpIds,
        mcpToolPolicies,
        stepMcpToolNames,
        runPinnedMcpToolNames,
        runStickyToolNames,
        mcpLastUsedByName,
        currentStep: step,
        invalidateMcpToolCatalogCache,
        mcpNotInCatalogCounts,
        emitLiveEvent: (ev: AgentEvent) => {
          liveEvents.push(ev)
          if (ev.type === 'tool_progress' || ev.type === 'mode_changed' || ev.type === 'agent_instance_update' || ev.type === 'goal_update' || ev.type === 'loop_update') {
            appendEvent(runDir!, ev)
          }
          if (ev.type === 'tool_result') {
            liveToolResultsEmitted.add(ev.toolCallId)
          }
          wakeLiveEvents?.()
        }
      }
      const toolWork = executeStepToolCalls(callsToExecute, toolCtx)
      let toolsSteered = false
      let toolsSettled = false
      const settledWork = toolWork.then(
        (result) => {
          toolsSettled = true
          wakeLiveEvents?.()
          return result
        },
        (err) => {
          toolsSettled = true
          wakeLiveEvents?.()
          throw err
        }
      )

      for (;;) {
        while (liveEvents.length) {
          const ev = liveEvents.shift()!
          yield ev.type === 'tool_result' ? toolResultEventForIpc(ev) : ev
        }
        if (toolsSettled) break
        if (
          !controller.signal.aborted &&
          (hasReadyFollowUps(runId) || stepSoftAbort.signal.aborted)
        ) {
          toolsSteered = true
          // Ensure in-flight tools see soft-abort even if enqueue raced before
          // streamInterrupt was bound, or AbortSignal.any is unavailable.
          if (!stepSoftAbort.signal.aborted) stepSoftAbort.abort()
        }
        await Promise.race([
          settledWork.catch(() => undefined),
          new Promise<void>((resolve) => {
            wakeLiveEvents = resolve
          })
        ])
        wakeLiveEvents = null
      }
      let toolOutcome: Awaited<typeof settledWork>
      try {
        toolOutcome = await settledWork
      } catch (err) {
        try {
          await flushMessageAppends(runDir)
        } catch {
          // Failure is recorded for emitMessageAppendFailureNotice below.
        }
        try {
          await flushEventAppends(runDir)
        } catch {
          // Failure is recorded for emitEventAppendFailureNotice below.
        }
        if (yield* emitMessageAppendFailureNotice(runId, runDir, invokeId)) {
          yield* emitTerminalRunError({
            runId,
            invokeId,
            runDir,
            message: 'Failed to persist a chat message',
            emitErrorEvent: false,
            flushWriteCheckpoint,
            writeStatus
          })
          return
        }
        if (yield* emitEventAppendFailureNotice(runId, runDir, invokeId)) {
          yield* emitTerminalRunError({
            runId,
            invokeId,
            runDir,
            message: 'Failed to persist a run event',
            emitErrorEvent: false,
            flushWriteCheckpoint,
            writeStatus
          })
          return
        }
        throw err
      }
      for (const ev of toolOutcome.events) {
        if (ev.type === 'tool_result') {
          if (liveToolResultsEmitted.has(ev.toolCallId)) continue
          yield toolResultEventForIpc(ev)
        }
      }
      for (const toolMsg of toolOutcome.messages) {
        messages.push(toolMsg)
      }

      if (uniqueToolCalls.length > 0) {
        // Soft-steer / Send now aborts tools as ok:false — that is not a real
        // identical-step streak or failure streak. Skip LOOP_SAFETY so follow-ups apply.
        if (toolsSteered) {
          identicalStepStreak = 0
          lastStepFingerprint = ''
          identicalStepLoopHint = undefined
          consecutiveToolFailureSteps = 0
          toolFailureLoopHint = undefined
          recentFailureSignatures = []
        } else {
          // Novelty-aware failure streak (root fix for run 3d8e0ead): an
          // all-failed step charges the streak only when it repeats a recent
          // failed attempt; a new attempt shape holds the streak so distinct
          // approaches can keep exploring one external blocker.
          if (nextConsecutiveToolFailureSteps(0, toolOutcome.messages) === 1) {
            const signature = stepFailureSignature(toolOutcome.messages)
            const next = nextToolFailureStreak(
              consecutiveToolFailureSteps,
              signature,
              recentFailureSignatures
            )
            consecutiveToolFailureSteps = next.streak
            recentFailureSignatures = next.recentSignatures
          } else {
            // Mixed or successful step — real progress; clear streak + window.
            consecutiveToolFailureSteps = 0
            recentFailureSignatures = []
          }
          toolFailureLoopHint = loopHintForConsecutiveToolFailures(
            consecutiveToolFailureSteps,
            summarizeRecentToolFailure(toolOutcome.messages)
          )
          const failureStop = loopStopDecision({
            step,
            consecutiveToolFailureSteps,
            identicalStepStreak
          })
          // Same rule as the pre-step guards: terminal thresholds end the run.
          if (failureStop) {
            yield* stopForLoopSafety(failureStop)
            return
          }
        }
      }

      if (
        !controller.signal.aborted &&
        (toolsSteered || hasReadyFollowUps(runId))
      ) {
        yield* applyDrainedFollowUps(runId, runDir, messages)
        try {
          await flushMessageAppends(runDir)
        } catch {
          // Failure is recorded for emitMessageAppendFailureNotice below.
        }
        try {
          await flushEventAppends(runDir)
        } catch {
          // Failure is recorded for emitEventAppendFailureNotice below.
        }
        if (yield* emitMessageAppendFailureNotice(runId, runDir, invokeId)) {
          yield* emitTerminalRunError({
            runId,
            invokeId,
            runDir,
            message: 'Failed to persist a chat message',
            emitErrorEvent: false,
            flushWriteCheckpoint,
            writeStatus
          })
          return
        }
        if (yield* emitEventAppendFailureNotice(runId, runDir, invokeId)) {
          yield* emitTerminalRunError({
            runId,
            invokeId,
            runDir,
            message: 'Failed to persist a run event',
            emitErrorEvent: false,
            flushWriteCheckpoint,
            writeStatus
          })
          return
        }
        continue
      }

      await persistInterimReceipt()
      persistLoopCheckpoint()

      if (controller.signal.aborted) break
      } finally {
        setStreamInterrupt(runId, null)
      }
    }

    if (controller.signal.aborted) {
      markRunTurnComplete(runId, invokeId)
      clearFollowUps(runId)
      yield* flushWriteCheckpoint()
      yield { type: 'status', runId, invokeId, status: 'cancelled' }
      writeStatus({ status: 'cancelled' })
      appendEvent(runDir, { type: 'status', runId, invokeId, status: 'cancelled' })
    }
    } catch (err) {
    if (isAbortError(err)) {
      logger.warn('Agent run cancelled', { scope: 'agent', correlationId: runId })
      markRunTurnComplete(runId, invokeId)
      clearFollowUps(runId)
      yield* flushWriteCheckpoint()
      yield { type: 'status', runId, invokeId, status: 'cancelled' }
      if (runDir) {
        writeStatus({ status: 'cancelled' })
        appendEvent(runDir, { type: 'status', runId, invokeId, status: 'cancelled' })
      }
    } else {
      const message = formatError(err)
      logger.error(`Agent loop failed: ${logErrorSummary(err, 'AGENT_LOOP')}`, {
        scope: 'agent',
        code: 'AGENT_LOOP',
        correlationId: runId,
        err
      })
      markRunTurnComplete(runId, invokeId)
      yield* emitTerminalRunError({
        runId,
        invokeId,
        runDir,
        message,
        code: 'AGENT_LOOP',
        dropFollowUpsReason: 'agent_loop',
        flushWriteCheckpoint,
        writeStatus
      })
    }
  } finally {
    // Close the turn for follow-ups as soon as the run ends so a queued message
    // cannot land during flush/dispose and then be dropped unapplied.
    markRunTurnComplete(runId, invokeId)
    // Persistence flush/receipt must not skip slot teardown — a rethrown append
    // error would otherwise leave isActive(runId) true forever.
    try {
      // Always drain the per-run append chain so a superseded invoke cannot leave
      // events buffered when a follow-up turn starts immediately.
      if (runDir) {
        if (!checkpointFlushed) {
          const meta = finalizeWriteCheckpoint(runDir)
          checkpointFlushed = true
          if (meta) {
            const ev: AgentEvent = {
              type: 'writes_checkpoint',
              runId,
              checkpointId: meta.id,
              files: meta.files
            }
            appendEvent(runDir, ev)
            setLateWriteCheckpoint(runId, ev)
          }
        }
        await flushMessageAppends(runDir)
        await flushEventAppends(runDir)
        await flushStatusWrites(runDir)
        const finalEvents = await loadEventsAsync(runDir, runId)
        const receipt = writeRunReceiptBestEffort({
          runDir,
          runId,
          loadStatus,
          loadMessages: () => loadMessages(workspace, runId),
          loadEvents: () => finalEvents,
          readContract
        })
        // Observational AHE sidecars — best-effort; must not block receipt success.
        writeTrajectoryArtifactsBestEffort({
          runDir,
          runId,
          loadEvents: () => finalEvents,
          receipt
        })
        if (costTotals.steps > 0) {
          const avgInput =
            costTotals.steps > 0
              ? Math.round(costTotals.billedInputTokens / costTotals.steps)
              : 0
          const billedHit = billedCacheHitRate(
            costTotals.billedInputTokens,
            costTotals.billedCachedInputTokens
          )
          logger.info('Token cost run summary', {
            scope: 'agent',
            correlationId: runId,
            provider: costLogProvider,
            model: costLogModel,
            steps: costTotals.steps,
            billedInputTokens: costTotals.billedInputTokens,
            peakInputTokens: costTotals.peakInputTokens,
            avgInputTokensPerStep: avgInput,
            latestInputTokens: costTotals.inputTokens,
            outputTokens: costTotals.outputTokens,
            reasoningTokens: costTotals.reasoningTokens,
            billedCachedInputTokens: costTotals.billedCachedInputTokens,
            cacheCreationInputTokens: costTotals.cacheCreationInputTokens,
            billedCacheHitRate: billedHit,
            compactionCountThisRun,
            topToolsByCalls: topToolsByCallCount(receipt?.toolStats?.byName)
          })
        }
      }
    } catch (flushErr) {
      logger.warn('Agent run finally persistence failed', {
        scope: 'agent',
        code: 'AGENT_FINALLY_FLUSH',
        correlationId: runId,
        err: flushErr
      })
      if (runDir) {
        // Direct retry for the terminal status: once this generator has ended
        // nothing re-enqueues a parked patch, and a dropped terminal write
        // leaves status.json "running" — a zombie the orphan sweep later
        // converts to "Cancelled".
        try {
          await updateStatus(runDir, {}, { sync: true })
        } catch (retryErr) {
          logger.error('Terminal status retry after finally flush failure also failed', {
            scope: 'agent',
            code: 'AGENT_FINALLY_FLUSH',
            correlationId: runId,
            err: retryErr
          })
        }
        try {
          appendEvent(runDir, {
            type: 'error',
            runId,
            invokeId,
            message: `Persistence flush failed after run ended: ${formatError(flushErr)}`,
            code: 'PERSISTENCE'
          })
        } catch {
          // best-effort warning only
        }
      }
    }
    try {
      disposeTerminalSessionsForInvoke(runId, invokeId)
    } catch (disposeErr) {
      logger.warn('Agent run finally dispose failed', {
        scope: 'agent',
        code: 'AGENT_FINALLY_DISPOSE',
        correlationId: runId,
        err: disposeErr
      })
    } finally {
      const pending = peekFollowUps(runId)
      if (pending.length > 0) {
        if (runExitedNormally) {
          logger.error('Follow-ups remained after normal run exit', {
            scope: 'agent',
            code: 'FOLLOW_UP_ORPHAN',
            correlationId: runId,
            count: pending.length
          })
        }
        const ids = pending.map((entry) => entry.id)
        clearFollowUps(runId)
        if (runDir) syncFollowUpsToDisk(runDir, runId)
        const dropped: AgentEvent = {
          type: 'follow_up_dropped',
          runId,
          ids,
          reason: 'run_ended'
        }
        if (runDir) appendEvent(runDir, dropped)
        setLateFollowUpDropped(runId, dropped)
      }
      clearRunAbort(runId, invokeId)
    }
  }
}
