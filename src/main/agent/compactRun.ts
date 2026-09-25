import type {
  AgentEvent,
  ChatMessage,
  CompactRunResult,
  ModelInfo,
  ProviderId,
  Settings
} from '../../shared/ipc'
import { contentToText } from '../../shared/ipc'
import {
  providerNeedsKey,
  resolveProviderChatBaseUrl
} from '../../shared/domain/providers'
import { DEFAULT_SETTINGS } from '../../shared/ipc'
import { logger } from '../../shared/logger'
import { resolveEffectiveSettings } from '../../shared/effectiveSettings'
import { getSecret, hasStoredSecretBlob, secretStatus } from '@main/settings/secrets'
import { getSettings } from '@main/settings/settings'
import { findWorkspaceSettingsOverride, readWorkspacesState } from '@main/workspace/workspaces'
import { allocateBudget, contentWindow, contextWindowFor } from './context/budget'
import {
  CompactionHardFailureError,
  compactMessages,
  countUserTurns,
  forceCompactKeepTail,
  ensureSubstantialFold,
  manualKeepRecentTurns,
  preserveRecentMessagesAsync,
  type CompactionUsageSample
} from './context/compact'
import { estimateStepCost, resolveModelPrice } from '../../shared/pricing/modelPrices'
import { recordAuxUsage } from './usageLedger'
import { estimateMessagesTokensAsync, estimateTextTokensAsync } from './context/estimate'
import { extractFoldFacts } from './context/foldFacts'
import {
  foldFactsToPinned,
  mergeFoldFacts,
  pinFoldFacts,
  pinnedFactsToFoldFacts
} from './context/pinFoldFacts'
import {
  extractAskQuestionDecisions,
  mergeCompactionFocus
} from './context/retainedDecisions'
import {
  clipVerifyFailures,
  formatCompactionVerifyFailure,
  isUntrustworthy,
  missingFactsFocus,
  requiredFoldFactsFocus,
  untrustworthy,
  verifyCompactionSummary
} from './context/verifyCompaction'
import {
  KEEP_RECENT_TURNS,
  type CompactionRecord,
  type CompactionTriggerReason
} from './context/types'
import { resolveModelInfo } from './modelResolve'
import { getProvider } from './providers'
import { STREAM_IDLE_TIMEOUT_MS } from './providers/sse'
import type { LlmProvider } from './providers/types'
import {
  appendEvent,
  loadCompaction,
  loadWorkingMessagesForFold,
  readContract,
  runExists,
  saveCompaction
} from './state'
import { readTodos } from './tools/todo'
import { resolveRunDir } from '@main/storage/paths'

/**
 * Wall-clock budget for compaction. Align with stream idle tolerance so slow
 * reasoning models can finish summarization.
 */
const COMPACT_TIMEOUT_MS = STREAM_IDLE_TIMEOUT_MS

/** Below this there is nothing meaningful to summarize. */
const MIN_MESSAGES_TO_COMPACT = 4

function compactTimeoutUserMessage(): string {
  const minutes = Math.round(COMPACT_TIMEOUT_MS / 60_000)
  return `Compaction timed out after ${minutes} minutes. Try again, use a faster model, or /clear for a fresh chat.`
}

/** Hard provider failures surface their real cause, not a generic no-summary error. */
function unwrapCompactionFailure(err: unknown): never {
  if (err instanceof CompactionHardFailureError) {
    throw new CompactionUnavailableError(err.message)
  }
  throw err
}

/**
 * Compaction could not run. `benign` marks the "nothing to fold yet" states —
 * the history is too short, or all of it is recent enough to keep verbatim.
 * Those are normal for a young run and must not terminate it.
 */
export class CompactionUnavailableError extends Error {
  readonly benign: boolean

  constructor(message: string, opts?: { benign?: boolean }) {
    super(message)
    this.benign = opts?.benign === true
  }
}

/** Summarizer output failed extractive verification; the watermark must not advance. */
export class CompactionVerifyFailedError extends Error {
  readonly failures: string[]

  constructor(message: string, failures: string[]) {
    super(message)
    this.failures = failures
  }
}

type CompactAbortHandle = {
  signal: AbortSignal
  /** Wall-clock budget elapsed before caller/run stop. */
  timedOut: () => boolean
  /** Caller cancelled via run/tool stop. */
  userAborted: () => boolean
}

export type CompactPlan = {
  runDir: string
  runId: string
  providerId: ProviderId
  provider: LlmProvider
  model: ModelInfo
  apiKey: string | null | undefined
  baseUrl: string | undefined
  abort: CompactAbortHandle
  userSignal?: AbortSignal
  working: ChatMessage[]
  kept: ChatMessage[]
  toSummarize: ChatMessage[]
  baseFolded: number
  existing: CompactionRecord | null
  /** Whether the unchunked message-shape fork may be used for this plan. */
  allowMessageFork: boolean
  /**
   * Billed compaction streams collected during this plan's LLM calls, drained
   * by `drainAuxUsageEvents` once the awaited call returns. An accumulator
   * rather than a return value because compaction retries and chunks, and the
   * abort paths return `null` after having already been billed.
   */
  auxUsage?: CompactionUsageSample[]
}

/** Combine caller abort with the compact timeout. */
function createCompactAbort(userSignal?: AbortSignal): CompactAbortHandle {
  const timeout = AbortSignal.timeout(COMPACT_TIMEOUT_MS)
  const timedOut = (): boolean => timeout.aborted && !userSignal?.aborted
  const userAborted = (): boolean => userSignal?.aborted ?? false

  if (!userSignal) {
    return { signal: timeout, timedOut, userAborted }
  }
  if (typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any([userSignal, timeout]), timedOut, userAborted }
  }
  if (userSignal.aborted || timeout.aborted) {
    const done = new AbortController()
    done.abort()
    return { signal: done.signal, timedOut, userAborted }
  }
  const combined = new AbortController()
  const onAbort = (): void => {
    userSignal.removeEventListener('abort', onAbort)
    timeout.removeEventListener('abort', onAbort)
    if (!combined.signal.aborted) combined.abort()
  }
  userSignal.addEventListener('abort', onAbort, { once: true })
  timeout.addEventListener('abort', onAbort, { once: true })
  return { signal: combined.signal, timedOut, userAborted }
}

function throwCompactionAbort(abort: CompactAbortHandle): void {
  if (abort.userAborted()) {
    const err = new Error('Aborted')
    err.name = 'AbortError'
    throw err
  }
  if (abort.timedOut()) {
    throw new CompactionUnavailableError(compactTimeoutUserMessage())
  }
  const err = new Error('Aborted')
  err.name = 'AbortError'
  throw err
}

function resolveSettings(workspacePath: string, snapshotted?: Settings): Settings {
  if (snapshotted) {
    return { ...DEFAULT_SETTINGS, ...snapshotted }
  }
  const globalSettings = getSettings()
  const override = findWorkspaceSettingsOverride(readWorkspacesState(), workspacePath)
  return {
    ...DEFAULT_SETTINGS,
    ...globalSettings,
    ...resolveEffectiveSettings(globalSettings, override)
  }
}

/** Load messages, apply fold watermark, compute kept / toSummarize. */
export async function planCompact(input: {
  workspacePath: string
  runId: string
  signal?: AbortSignal
  /** Invoke-snapshotted settings (auto). When omitted, read live effective settings (menu). */
  settings?: Settings
}): Promise<CompactPlan> {
  if (!runExists(input.workspacePath, input.runId)) {
    throw new CompactionUnavailableError('Run not found')
  }
  const runDir = resolveRunDir(input.workspacePath, input.runId)
  const settings = resolveSettings(input.workspacePath, input.settings)

  const providerId: ProviderId = settings.provider
  const apiKey = getSecret(providerId)
  const baseUrl = resolveProviderChatBaseUrl(providerId, settings, apiKey)
  if (providerNeedsKey(providerId, baseUrl ?? settings.ollamaBaseUrl) && !apiKey) {
    const status = secretStatus()
    const storedBlob = hasStoredSecretBlob(providerId)
    const message = !status.encryptionAvailable
      ? 'OS secure storage is unavailable. API keys cannot be decrypted on this system.'
      : storedBlob
        ? `API key for ${providerId} is stored but cannot be decrypted. Re-enter it in Settings → Providers or restore OS keychain access.`
        : `API key for ${providerId} is not set.`
    throw new CompactionUnavailableError(message)
  }

  const existing = loadCompaction(runDir)
  const folded = existing?.foldedMessages ?? 0
  const applied = loadWorkingMessagesForFold(input.workspacePath, input.runId, folded)
  const working = applied.messages
  const baseFolded = applied.foldedMessages

  if (working.length < MIN_MESSAGES_TO_COMPACT) {
    throw new CompactionUnavailableError('Not enough history to compact yet.', { benign: true })
  }

  const configuredKeep = settings.keepRecentTurns ?? KEEP_RECENT_TURNS
  const abort = createCompactAbort(input.signal)
  const provider = getProvider(providerId)
  const model = await resolveModelInfo(providerId, settings.model, apiKey, baseUrl, abort.signal)
  const historyBudget = allocateBudget(model, providerId).history

  const keepRecent = manualKeepRecentTurns(countUserTurns(working), configuredKeep)
  let kept = await preserveRecentMessagesAsync(working, keepRecent, historyBudget, model)
  if (kept.length >= working.length) {
    kept = forceCompactKeepTail(working)
  }
  // Menu compact can be under any token trigger; still fold at least half so
  // keep-recent cannot persist a 16-message-only prefix of a long run.
  kept = ensureSubstantialFold(working, kept)
  const toSummarize = working.slice(0, working.length - kept.length)
  if (!toSummarize.length) {
    throw new CompactionUnavailableError(
      'All of the current history is recent enough to keep verbatim.',
      { benign: true }
    )
  }

  return {
    runDir,
    runId: input.runId,
    providerId,
    provider,
    model,
    apiKey,
    baseUrl,
    abort,
    userSignal: input.signal,
    working,
    kept,
    toSummarize,
    baseFolded,
    existing,
    allowMessageFork: true,
    auxUsage: []
  }
}

async function invokeCompactionLlm(
  plan: CompactPlan,
  focus: string | undefined,
  abort: CompactAbortHandle,
  supportsStructuredOutput: boolean,
  opts?: { allowFork?: boolean }
): Promise<Awaited<ReturnType<typeof compactMessages>>> {
  const allowFork = opts?.allowFork !== false
  return compactMessages({
    provider: plan.provider,
    model: plan.model.id,
    apiKey: plan.apiKey,
    baseUrl: plan.baseUrl,
    signal: abort.signal,
    messages: plan.toSummarize,
    supportsStructuredOutput,
    contextWindow: contentWindow(plan.model, plan.providerId),
    priorSummary: plan.existing?.summary,
    focus,
    allowMessageFork: allowFork && plan.allowMessageFork,
    promptCacheKey: plan.runId,
    modelInfo: plan.model,
    onAuxUsage: (sample) => plan.auxUsage?.push(sample)
  })
}

/**
 * Turn collected compaction streams into `aux_usage` events, recording each into
 * the run's per-day ledger on the way out. Drains the accumulator, so calling it
 * after every awaited compaction call is safe and never double-reports.
 *
 * Cost mirrors the agent loop: provider-reported when the stream carried one,
 * otherwise a published-price estimate, and neither when the model is
 * unpriceable — tokens are still reported, a fabricated `$` never is.
 */
function drainAuxUsageEvents(plan: CompactPlan, invokeId: number | undefined): AgentEvent[] {
  const samples = plan.auxUsage
  if (!samples?.length) return []
  const drained = samples.splice(0, samples.length)
  const price = resolveModelPrice(plan.providerId, plan.model.id)
  const events: AgentEvent[] = []
  for (const sample of drained) {
    const { usage } = sample
    const estimated =
      usage.billedCost == null && price ? estimateStepCost(usage, price) ?? undefined : undefined
    const event: AgentEvent = {
      type: 'aux_usage',
      runId: plan.runId,
      site: sample.site,
      provider: plan.providerId,
      model: plan.model.id,
      attempt: sample.attempt,
      ...(usage.inputTokens != null ? { inputTokens: usage.inputTokens } : {}),
      ...(usage.outputTokens != null ? { outputTokens: usage.outputTokens } : {}),
      ...(usage.cachedInputTokens != null
        ? { cachedInputTokens: usage.cachedInputTokens }
        : {}),
      ...(usage.cacheCreationInputTokens != null
        ? { cacheCreationInputTokens: usage.cacheCreationInputTokens }
        : {}),
      ...(usage.reasoningTokens != null ? { reasoningTokens: usage.reasoningTokens } : {}),
      ...(usage.inputTokensIncludesCache !== undefined
        ? { inputTokensIncludesCache: usage.inputTokensIncludesCache }
        : {}),
      ...(usage.billedCost != null ? { billedCost: usage.billedCost } : {}),
      ...(usage.billedCostSaved != null ? { billedCostSaved: usage.billedCostSaved } : {}),
      ...(estimated !== undefined ? { estimatedCost: estimated } : {}),
      generationMs: sample.generationMs
    }
    recordAuxUsage(plan.runDir, {
      site: sample.site,
      ...(usage.inputTokens != null ? { inputTokens: usage.inputTokens } : {}),
      ...(usage.outputTokens != null ? { outputTokens: usage.outputTokens } : {}),
      ...(usage.cachedInputTokens != null
        ? { cachedInputTokens: usage.cachedInputTokens }
        : {}),
      ...(usage.reasoningTokens != null ? { reasoningTokens: usage.reasoningTokens } : {}),
      ...(usage.billedCost != null ? { billedCost: usage.billedCost } : {}),
      ...(estimated !== undefined ? { estimatedCost: estimated } : {})
    })
    const stamped = stampCompactEvent(plan, invokeId, event)
    appendEvent(plan.runDir, stamped)
    events.push(stamped)
  }
  return events
}

export type CompactMode = 'auto' | 'manual'

function resolveTriggerReason(
  mode: CompactMode,
  autoReason?: 'proactive' | 'overflow'
): CompactionTriggerReason {
  if (mode === 'auto') return autoReason ?? 'proactive'
  return 'manual'
}

type ExecuteCompactOpts = {
  invokeId?: number
}

function stampCompactEvent(
  plan: CompactPlan,
  invokeId: number | undefined,
  event: AgentEvent
): AgentEvent {
  return invokeId != null ? { ...event, invokeId } : event
}

async function summarizeWithTimeoutRetry(
  plan: CompactPlan,
  focus: string | undefined,
  structured: boolean
): Promise<NonNullable<Awaited<ReturnType<typeof compactMessages>>>> {
  let record: Awaited<ReturnType<typeof compactMessages>>
  try {
    record = await invokeCompactionLlm(plan, focus, plan.abort, structured)
  } catch (err) {
    unwrapCompactionFailure(err)
  }

  if (!record && plan.abort.timedOut() && !plan.abort.userAborted()) {
    logger.info('Compaction timed out; retrying flattened tools=[] path', {
      scope: 'agent',
      code: 'COMPACTION',
      correlationId: plan.runId
    })
    const retryAbort = createCompactAbort(plan.userSignal)
    try {
      record = await invokeCompactionLlm(plan, focus, retryAbort, false, { allowFork: false })
    } catch (err) {
      unwrapCompactionFailure(err)
    }
    if (!record && retryAbort.timedOut()) {
      throw new CompactionUnavailableError(compactTimeoutUserMessage())
    }
    if (!record && retryAbort.userAborted()) {
      throwCompactionAbort(retryAbort)
    }
  }

  // A transient empty model response (no timeout, no abort) must not terminate a
  // long run — session d8883185 hit this once and the run died. One flattened
  // retry, mirroring the timeout path above; still terminal if the retry is empty.
  if (!record && !plan.abort.signal.aborted && !plan.abort.timedOut() && !plan.abort.userAborted()) {
    logger.info('Compaction returned no summary; retrying flattened tools=[] path', {
      scope: 'agent',
      code: 'COMPACTION',
      correlationId: plan.runId
    })
    const retryAbort = createCompactAbort(plan.userSignal)
    try {
      record = await invokeCompactionLlm(plan, focus, retryAbort, false, { allowFork: false })
    } catch (err) {
      unwrapCompactionFailure(err)
    }
    if (!record && retryAbort.timedOut()) {
      throw new CompactionUnavailableError(compactTimeoutUserMessage())
    }
    if (!record && retryAbort.userAborted()) {
      throwCompactionAbort(retryAbort)
    }
  }

  if (!record) {
    if (plan.abort.signal.aborted || plan.abort.timedOut() || plan.abort.userAborted()) {
      throwCompactionAbort(plan.abort)
    }
    throw new CompactionUnavailableError('The model returned no summary.')
  }

  if (plan.abort.userAborted()) {
    throwCompactionAbort(plan.abort)
  }
  return record
}

/** Run summarizer, verify against fold facts, persist only when verified. */
export async function* executeCompactEvents(
  plan: CompactPlan,
  focus: string | undefined,
  mode: CompactMode,
  autoReason?: 'proactive' | 'overflow',
  opts?: ExecuteCompactOpts
): AsyncGenerator<AgentEvent, CompactRunResult> {
  const retainedDecisions = extractAskQuestionDecisions(plan.toSummarize)
  const facts = mergeFoldFacts(
    pinnedFactsToFoldFacts(plan.existing?.pinnedFacts),
    extractFoldFacts(plan.toSummarize, {
      contract: readContract(plan.runDir),
      todos: readTodos(plan.runDir)
    })
  )
  const foldedText = [
    plan.existing?.summary ?? '',
    ...plan.toSummarize.map((msg) => {
      const tools = msg.toolCalls?.map((t) => `${t.name}(${t.arguments})`).join(', ')
      return `${contentToText(msg.content)}${tools ? `\n${tools}` : ''}`
    })
  ]
    .filter(Boolean)
    .join('\n')
  const effectiveFocus = [
    mergeCompactionFocus(focus, retainedDecisions),
    requiredFoldFactsFocus(facts)
  ]
    .filter(Boolean)
    .join('\n\n') || undefined
  const structured = plan.model.supportsStructuredOutput ?? false

  // Manual compact is IPC — persist start so hydrate/UI can recover.
  // Auto yields `compaction_started` from `autoCompactLlmEvents` after plan succeeds.
  if (mode === 'manual') {
    const started = stampCompactEvent(plan, opts?.invokeId, {
      type: 'compaction_started',
      runId: plan.runId,
      mode: 'manual'
    })
    appendEvent(plan.runDir, started)
    yield started
  }

  let record: NonNullable<Awaited<ReturnType<typeof compactMessages>>>
  try {
    record = await summarizeWithTimeoutRetry(plan, effectiveFocus, structured)
  } catch (err) {
    // A compaction that failed was still billed for whatever it streamed before
    // failing — persist that spend to the ledger and the event log, then rethrow.
    // This is the spend most worth seeing, so it must not ride on the happy path.
    drainAuxUsageEvents(plan, opts?.invokeId)
    throw err
  }
  for (const ev of drainAuxUsageEvents(plan, opts?.invokeId)) yield ev

  const emitVerifying = function* (): Generator<AgentEvent, void> {
    const ev = stampCompactEvent(plan, opts?.invokeId, {
      type: 'compaction_verifying',
      runId: plan.runId,
      summary: record.summary,
      tokenEstimate: record.tokenEstimate
    })
    appendEvent(plan.runDir, ev)
    yield ev
  }

  yield* emitVerifying()
  // Score the model's own narrative, before pinning. Pinning appends every
  // missing fact verbatim, so scoring the pinned text made `missing_*` and
  // `low_file_coverage` unreachable and `verifyCoverage` a constant 1 — the
  // retry could only ever fire on a refusal or an invented path. Verifying
  // first keeps exactly that reachable set, but now says so, and reports a real
  // coverage number.
  let scored = verifyCompactionSummary(record.summary, facts, foldedText)

  if (untrustworthy(scored).length > 0) {
    const failureLines = clipVerifyFailures(
      untrustworthy(scored).map(formatCompactionVerifyFailure)
    )
    const retryEv = stampCompactEvent(plan, opts?.invokeId, {
      type: 'compaction_verify_retry',
      runId: plan.runId,
      summary: record.summary,
      failures: failureLines
    })
    appendEvent(plan.runDir, retryEv)
    yield retryEv

    logger.info('Compaction summary failed verification; retrying with missing facts', {
      scope: 'agent',
      code: 'COMPACTION_VERIFY',
      correlationId: plan.runId,
      failures: failureLines
    })

    const retryFocus = [missingFactsFocus(scored, facts), effectiveFocus]
      .filter(Boolean)
      .join('\n\n')
    const retryAbort = createCompactAbort(plan.userSignal)
    let retryRecord: Awaited<ReturnType<typeof compactMessages>>
    try {
      retryRecord = await invokeCompactionLlm(plan, retryFocus, retryAbort, false, {
        allowFork: false
      })
    } catch (err) {
      drainAuxUsageEvents(plan, opts?.invokeId)
      unwrapCompactionFailure(err)
    }
    // The verification retry is a second full compaction — bill it separately.
    for (const ev of drainAuxUsageEvents(plan, opts?.invokeId)) yield ev
    if (!retryRecord) {
      if (retryAbort.userAborted() || retryAbort.timedOut() || retryAbort.signal.aborted) {
        throwCompactionAbort(retryAbort)
      }
      throw new CompactionUnavailableError('The model returned no summary.')
    }
    record = retryRecord
    yield* emitVerifying()
    scored = verifyCompactionSummary(record.summary, facts, foldedText)
  }

  const blocking = untrustworthy(scored)
  if (blocking.length > 0) {
    const failureLines = clipVerifyFailures(blocking.map(formatCompactionVerifyFailure))
    const failedEv = stampCompactEvent(plan, opts?.invokeId, {
      type: 'compaction_verify_failed',
      runId: plan.runId,
      summary: record.summary,
      tokenEstimate: record.tokenEstimate,
      failures: failureLines
    })
    appendEvent(plan.runDir, failedEv)
    yield failedEv
    throw new CompactionVerifyFailedError(
      `Compaction summary failed verification: ${failureLines.join('; ')}`,
      failureLines
    )
  }

  // The summary is trustworthy; now repair what it merely left out. Pinning
  // splices the missing extractive facts back in verbatim from `facts`, so an
  // omission costs an appendix rather than a second summarizer call.
  const repaired = scored.failures.filter((f) => !isUntrustworthy(f))
  const pinnedSummary = pinFoldFacts(record.summary, facts)
  if (pinnedSummary !== record.summary) {
    record = {
      ...record,
      summary: pinnedSummary,
      tokenEstimate: await estimateTextTokensAsync(pinnedSummary)
    }
  }
  if (repaired.length > 0) {
    logger.info('Compaction summary omissions repaired from extracted fold facts', {
      scope: 'agent',
      code: 'COMPACTION_VERIFY',
      correlationId: plan.runId,
      repairedCount: repaired.length,
      repaired: clipVerifyFailures(repaired.map(formatCompactionVerifyFailure))
    })
  }

  const foldedMessages = plan.baseFolded + plan.toSummarize.length
  const ctxWindow = contextWindowFor(plan.model, plan.providerId)
  const cWin = contentWindow(plan.model, plan.providerId)
  const remainingEstimate =
    (await estimateMessagesTokensAsync(plan.kept, plan.model)) + (record.tokenEstimate ?? 0)
  const triggerReason = resolveTriggerReason(mode, autoReason)

  const compactionRecord: CompactionRecord = {
    ...record,
    foldedMessages,
    triggerReason,
    messagesFolded: plan.toSummarize.length,
    keptMessages: plan.kept.length,
    postCompactEstimatedTokens: remainingEstimate,
    contentWindowAtCompact: cWin,
    verified: true,
    // Pre-pin coverage: the share of fold files the model cited on its own.
    // Scored after pinning this was always 1.
    verifyCoverage: scored.coverage,
    pinnedFacts: foldFactsToPinned(facts),
    ...(retainedDecisions.length > 0
      ? { retainedDecisions: retainedDecisions.slice(0, 8) }
      : {})
  }
  if (!saveCompaction(plan.runDir, compactionRecord)) {
    throw new CompactionUnavailableError('Failed to persist compaction record.')
  }

  if (mode === 'manual') {
    const done = stampCompactEvent(plan, opts?.invokeId, {
      type: 'compaction',
      runId: plan.runId,
      summary: record.summary,
      tokenEstimate: record.tokenEstimate,
      kind: 'summary',
      verified: true,
      verifyCoverage: scored.coverage
    })
    appendEvent(plan.runDir, done)
    yield done
  }

  logger.info(mode === 'manual' ? 'Manual compaction complete' : 'Auto compaction complete', {
    scope: 'agent',
    code: 'COMPACTION',
    source: mode,
    triggerReason,
    correlationId: plan.runId,
    provider: plan.providerId,
    messagesBefore: plan.working.length,
    messagesFolded: plan.toSummarize.length,
    keptMessages: plan.kept.length,
    postCompactEstimatedTokens: remainingEstimate,
    contentWindowAtCompact: cWin,
    postCompactRatio: cWin > 0 ? remainingEstimate / cWin : undefined,
    verified: true,
    verifyCoverage: scored.coverage
  })

  return {
    summary: record.summary,
    tokenEstimate: record.tokenEstimate,
    keptMessages: plan.kept.length,
    messagesBefore: plan.working.length,
    estimatedTokens: remainingEstimate,
    contextWindow: ctxWindow,
    contentWindow: cWin,
    retainedDecisions:
      retainedDecisions.length > 0 ? retainedDecisions.slice(0, 8) : undefined,
    verified: true,
    verifyCoverage: scored.coverage
  }
}

export type AutoCompactOutcome =
  | { ok: true; result: CompactRunResult }
  /** Nothing to fold yet — the caller should continue the run, not fail it. */
  | { ok: false; reason: 'nothing_to_compact'; message: string }
  /** Summary failed extractive verification — do not fold; continue or overflow-stop. */
  | { ok: false; reason: 'verify_failed'; message: string }
  /** Caller cancelled — the caller should take its cancel path, not its error path. */
  | { ok: false; reason: 'aborted'; message: string }
  | { ok: false; reason: 'failed'; message: string }

function compactOutcomeFromCaught(err: unknown): AutoCompactOutcome {
  if (err instanceof CompactionVerifyFailedError) {
    return { ok: false, reason: 'verify_failed', message: err.message }
  }
  if (err instanceof CompactionUnavailableError) {
    return {
      ok: false,
      reason: err.benign ? 'nothing_to_compact' : 'failed',
      message: err.message
    }
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return { ok: false, reason: 'aborted', message: 'Compaction aborted.' }
  }
  throw err
}

export type AutoCompactEventsInput = {
  workspacePath: string
  runId: string
  runDir: string
  settings: Settings
  signal?: AbortSignal
  focus?: string
  triggerReason?: 'proactive' | 'overflow'
  invokeId?: number
}

/**
 * Plan first, then yield `compaction_started` only when there is something to fold.
 * The loop must `yield*` this so the UI sees Compacting… during the LLM call.
 */
export async function* autoCompactLlmEvents(
  input: AutoCompactEventsInput
): AsyncGenerator<AgentEvent, AutoCompactOutcome> {
  let plan: CompactPlan
  try {
    plan = await planCompact({
      workspacePath: input.workspacePath,
      runId: input.runId,
      signal: input.signal,
      settings: input.settings
    })
    if (input.signal?.aborted || plan.abort.signal.aborted) {
      throwCompactionAbort(plan.abort)
    }
  } catch (err) {
    return compactOutcomeFromCaught(err)
  }

  const started: AgentEvent = {
    type: 'compaction_started',
    runId: input.runId,
    mode: 'auto',
    ...(input.invokeId != null ? { invokeId: input.invokeId } : {})
  }
  appendEvent(input.runDir, started)
  yield started

  try {
    const focus = input.focus?.trim() || undefined
    const gen = executeCompactEvents(plan, focus, 'auto', input.triggerReason, {
      invokeId: input.invokeId
    })
    let next = await gen.next()
    while (!next.done) {
      yield next.value
      next = await gen.next()
    }
    return { ok: true, result: next.value }
  } catch (err) {
    return compactOutcomeFromCaught(err)
  }
}

/** Menu /compact IPC. */
export async function compactRunNow(input: {
  workspacePath: string
  runId: string
  focus?: string
  signal?: AbortSignal
  onEvent?: (event: AgentEvent) => void
}): Promise<CompactRunResult> {
  const plan = await planCompact({
    workspacePath: input.workspacePath,
    runId: input.runId,
    signal: input.signal
  })
  if (input.signal?.aborted || plan.abort.signal.aborted) {
    throwCompactionAbort(plan.abort)
  }
  const focus = input.focus?.trim() || undefined
  const gen = executeCompactEvents(plan, focus, 'manual')
  let next = await gen.next()
  while (!next.done) {
    input.onEvent?.(next.value)
    next = await gen.next()
  }
  return next.value
}
