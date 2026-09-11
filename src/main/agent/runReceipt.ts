import { join } from 'path'
import { atomicWriteJson } from '../storage/atomicWrite'
import type {
  ChatMessage,
  MessageContent,
  PersistedEvent,
  RunReceipt,
  RunStatus
} from '../../shared/ipc'
import { contentToText, RUN_RECEIPT_VERSION, RunReceiptSchema } from '../../shared/ipc'
import {
  applyToolCallToKnownPaths,
  isAbortStubToolResult,
  isBuildOutputRelPath,
  isGateRefusalToolResult,
  isNonMutatingWriteFailure,
  isPlausibleWorkspaceFilePath,
  normalizeWorkspaceRelPath,
  toolArgsFromCall,
  unreadExistingEditPaths
} from './loopPolicy'
import { parseDiagnosticLines } from './tools/diagnostics'
import { parseTestResultHeader } from './tools/runTests'
import { logger } from '../../shared/logger'
import { stepUsageTotalsFromPersistedEvents } from '../../shared/utils/runTelemetry'
import { parseTerminalOutput } from '../../shared/utils/terminalFormat'

export { RUN_RECEIPT_VERSION }
export const RUN_RECEIPT_FILENAME = 'receipt.json'
export type { RunReceipt }

type SeedToolMessage = {
  role: string
  toolCalls?: Array<{ id: string; name: string; arguments: string }>
  toolCallId?: string
  toolName?: string
  ok?: boolean
  content?: MessageContent
}

/** Normalize em/en dashes and common UTF-8 mojibake to ASCII `-` for stable cluster keys. */
export function normalizeFailureClusterText(text: string): string {
  return text
    .replace(/\u2014|\u2013/g, '-')
    .replace(/â€"|â€“/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Terminal polls prefix a unique session_id, so raw first-80-char keys never
 * merge. Cluster by exit / status / command instead.
 */
function terminalFailureClusterText(content: string): string | null {
  const parsed = parseTerminalOutput(content)
  const command = (parsed.command ?? '').replace(/\s+/g, ' ').trim().slice(0, 48)
  const parts = [
    parsed.exitCode != null ? `exit ${parsed.exitCode}` : null,
    parsed.sessionStatus ? `status ${parsed.sessionStatus}` : null,
    command || null
  ].filter((part): part is string => Boolean(part))
  return parts.length > 0 ? parts.join(' · ') : null
}

function failureClusterBody(toolName: string, content: string): string {
  if (toolName === 'terminal') {
    const terminal = terminalFailureClusterText(content)
    if (terminal) return terminal
  }
  const text = normalizeFailureClusterText(content)
  if (
    toolName === 'edit' &&
    /Diff hunk failed to match/i.test(text)
  ) {
    return 'Diff hunk failed to match (context/removal mismatch)'
  }
  if (
    toolName === 'edit' &&
    /Diff hunk (?:near line \d+ |for line \d+ )?matched \d+/i.test(text)
  ) {
    return 'Diff hunk matched multiple locations'
  }
  if (
    (toolName === 'str_replace' || toolName === 'edit_notebook' || toolName === 'edit') &&
    /old_string not found/i.test(text)
  ) {
    return 'old_string not found'
  }
  if (/Plan mode may only edit plan\.md or contract\.md/i.test(text)) {
    return 'Plan mode may only edit plan.md or contract.md'
  }
  if (/Path escapes workspace/i.test(text)) {
    return 'Path escapes workspace (outside workspace root)'
  }
  return text.slice(0, 80)
}

/** Longest run of back-to-back failed tool calls in message order (weakness signal). */
export function maxConsecutiveToolFailuresFromMessages(
  messages: readonly SeedToolMessage[]
): number {
  return scanToolMessages(messages).maxConsecutiveToolFailures
}

function unreadEditPathsFromMessages(
  messages: readonly SeedToolMessage[],
  resultByCallId: Map<string, { ok: boolean; content: string }>
): string[] {
  const known = new Set<string>()
  const unread = new Set<string>()
  // Transcript replay has no filesystem snapshot; treat edited paths as pre-existing.
  const pathExists = (): boolean => true
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !msg.toolCalls) continue
    for (const call of msg.toolCalls) {
      const args = toolArgsFromCall(call.arguments)
      const result = resultByCallId.get(call.id)
      const ok = result?.ok ?? false
      const content = result?.content ?? ''
      if (!ok && isNonMutatingWriteFailure(content)) continue
      if (
        call.name === 'read' ||
        call.name === 'grep' ||
        call.name === 'glob' ||
        call.name === 'codebase_search'
      ) {
        applyToolCallToKnownPaths(known, call.name, args, ok, content)
        continue
      }
      for (const path of unreadExistingEditPaths(known, call.name, args, pathExists)) {
        unread.add(path)
      }
      applyToolCallToKnownPaths(known, call.name, args, ok, content)
    }
  }
  return [...unread].sort()
}

/** Paths from the latest writes_checkpoint event (object entries or legacy strings). */
export function wroteFilesFromEvents(events: readonly PersistedEvent[]): string[] {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]?.event as { type?: string; files?: unknown } | undefined
    if (ev?.type !== 'writes_checkpoint' || !Array.isArray(ev.files)) continue
    const paths: string[] = []
    for (const entry of ev.files) {
      if (typeof entry === 'string') {
        const path = normalizeWorkspaceRelPath(entry)
        if (path && isPlausibleWorkspaceFilePath(path) && !isBuildOutputRelPath(path)) {
          paths.push(path)
        }
        continue
      }
      if (entry && typeof entry === 'object' && typeof (entry as { path?: unknown }).path === 'string') {
        const path = normalizeWorkspaceRelPath((entry as { path: string }).path)
        if (path && isPlausibleWorkspaceFilePath(path) && !isBuildOutputRelPath(path)) {
          paths.push(path)
        }
      }
    }
    return paths
  }
  return []
}

function lastIncompleteFromEvents(
  events: readonly PersistedEvent[],
  invokeId?: number
): RunReceipt['incomplete'] | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]?.event as {
      type?: string
      invokeId?: number
      reason?: string
      message?: string
    } | undefined
    if (invokeId != null && ev?.invokeId !== invokeId) continue
    if (ev?.type !== 'incomplete' || typeof ev.reason !== 'string') continue
    const parsed = RunReceiptSchema.shape.incomplete.unwrap().safeParse({
      reason: ev.reason,
      ...(typeof ev.message === 'string' ? { message: ev.message } : {})
    })
    if (parsed.success) return parsed.data
  }
  return undefined
}

function tokenUsageFromEvents(
  events: readonly PersistedEvent[]
): RunReceipt['tokenUsage'] | undefined {
  // Sum per-step inputTokens only — never trust process-local billed* carried on
  // step_usage (those reset on resume and would undercount the receipt).
  const totals = stepUsageTotalsFromPersistedEvents(events)
  if (totals.steps > 0) {
    return {
      ...(totals.inputTokens > 0 ? { inputTokens: totals.inputTokens } : {}),
      ...(totals.billedInputTokens > 0 ? { billedInputTokens: totals.billedInputTokens } : {}),
      ...(totals.peakInputTokens > 0 ? { peakInputTokens: totals.peakInputTokens } : {}),
      ...(totals.outputTokens > 0 ? { outputTokens: totals.outputTokens } : {}),
      ...(totals.reasoningTokens > 0 ? { reasoningTokens: totals.reasoningTokens } : {}),
      ...(totals.cachedInputTokens > 0 ? { cachedInputTokens: totals.cachedInputTokens } : {}),
      ...(totals.billedCachedInputTokens > 0
        ? { billedCachedInputTokens: totals.billedCachedInputTokens }
        : {}),
      ...(totals.cacheCreationInputTokens > 0
        ? { cacheCreationInputTokens: totals.cacheCreationInputTokens }
        : {})
    }
  }
  let lastContextInput: number | undefined
  for (const row of events) {
    const ev = row.event as { type?: string; inputTokens?: number } | undefined
    if (ev?.type === 'context_usage' && typeof ev.inputTokens === 'number') {
      lastContextInput = ev.inputTokens
    }
  }
  if (lastContextInput != null) return { inputTokens: lastContextInput }
  return undefined
}

function compactionCountFromEvents(events: readonly PersistedEvent[]): number {
  let count = 0
  for (const row of events) {
    const ev = row.event as { type?: string } | undefined
    if (ev?.type === 'compaction') count++
  }
  return count
}

function contractExcerpt(contract: string, cap = 600): string {
  const text = contract.trim()
  if (!text) return ''
  const doneIdx = text.search(/^##\s*Done when\b/im)
  const slice = doneIdx >= 0 ? text.slice(doneIdx) : text
  return slice.length <= cap ? slice : slice.slice(0, cap) + '\n…'
}

/**
 * A diagnostics/run_tests result refreshes verification only when the check
 * actually ran (the run_tests skip result reports ok=true with no runner —
 * it verified nothing). Skipped checks and checks that reported errors must
 * not stamp the verified state.
 */
const SKIPPED_CHECK_RE = /^No test runner detected/

function isCheckResult(name: string | undefined): boolean {
  return name === 'diagnostics' || name === 'run_tests'
}

/** run_tests cleanliness: parsed failed-count; header absent + ok → exit 0. */
function runTestsCheckClean(content: string): boolean {
  const parsed = parseTestResultHeader(content)
  return parsed == null ? true : parsed.failed === 0
}

/** diagnostics cleanliness: no error-severity diagnostic lines. */
function diagnosticsCheckClean(content: string): boolean {
  return !parseDiagnosticLines(content).some((d) => (d.severity ?? 'error') === 'error')
}

/**
 * Message-side check cleanliness (full tool content) in message order. Zips
 * by order with the event-side list when counts align (tool messages and
 * tool_result events append 1:1 and both stitch their archives), so a slim
 * persisted event — content dropped past 200 chars — still carries the full
 * result's verdict. Both sides skip the same never-ran checks, keeping the
 * zip aligned.
 */
function checkCleanlinessFromMessages(messages: readonly SeedToolMessage[]): boolean[] {
  const out: boolean[] = []
  for (const msg of messages) {
    if (msg.role !== 'tool' || !msg.toolName || !isCheckResult(msg.toolName)) continue
    if (msg.ok === false) continue
    const content = contentToText(msg.content ?? '')
    if (SKIPPED_CHECK_RE.test(content.trim())) continue
    out.push(
      msg.toolName === 'run_tests'
        ? runTestsCheckClean(content)
        : diagnosticsCheckClean(content)
    )
  }
  return out
}

/**
 * Was the work verified? Compares diagnostics/run_tests checks against the
 * last writes_checkpoint. The verified state requires the newest check after
 * the last mutation to have run AND passed clean — an errored check is a
 * failed verification, and a skipped runner verified nothing. Informational
 * only — the loop never blocks on it.
 */
function verificationFromEvents(
  events: readonly PersistedEvent[],
  messages: readonly SeedToolMessage[] = []
): {
  lastMutationAt?: string
  lastCheckAt?: string
  verifiedAfterLastMutation: boolean
} | undefined {
  let lastMutationAt: string | undefined
  const eventChecks: Array<{ at: string; clean: boolean | null }> = []
  for (const row of events) {
    const ev = row.event as {
      type?: string
      name?: string
      ok?: boolean
      content?: unknown
    } | undefined
    if (ev?.type === 'writes_checkpoint' && row.at) lastMutationAt = row.at
    if (ev?.type !== 'tool_result' || !isCheckResult(ev.name) || ev.ok !== true || !row.at) {
      continue
    }
    // Slim events drop bodies past 200 chars; the 149-char skip message
    // always persists, so the skip can never masquerade as a real check.
    const content = typeof ev.content === 'string' ? ev.content : ''
    if (SKIPPED_CHECK_RE.test(content.trim())) continue
    eventChecks.push({
      at: row.at,
      clean: content
        ? ev.name === 'run_tests'
          ? runTestsCheckClean(content)
          : diagnosticsCheckClean(content)
        : null
    })
  }
  // Full-content message verdicts win when the two sides stayed aligned.
  const messageClean = checkCleanlinessFromMessages(messages)
  const checks =
    eventChecks.length > 0 && messageClean.length === eventChecks.length
      ? eventChecks.map((check, i) => ({ ...check, clean: messageClean[i] ?? check.clean }))
      : eventChecks
  const lastCheck = checks[checks.length - 1]
  if (lastMutationAt == null && lastCheck == null) return undefined
  return {
    ...(lastMutationAt ? { lastMutationAt } : {}),
    ...(lastCheck ? { lastCheckAt: lastCheck.at } : {}),
    verifiedAfterLastMutation:
      lastCheck != null &&
      // Proven-unclean demotes; an unknown verdict (misaligned archives) keeps
      // today's behavior rather than fabricating a fresh warning.
      lastCheck.clean !== false &&
      (lastMutationAt == null || lastCheck.at >= lastMutationAt)
  }
}

type ToolMessageScan = {
  toolStats: RunReceipt['toolStats']
  failureClusters: Array<{ key: string; count: number }>
  maxConsecutiveToolFailures: number
  diagnostics: { calls: number; ok: number; clean: number }
  tests: {
    calls: number
    ok: number
    failed: number
    lastPassed?: number
    lastFailed?: number
  }
  /** toolCallId → result, reused by `unreadEditPathsFromMessages`. */
  resultByCallId: Map<string, { ok: boolean; content: string }>
}

const FAILURE_CLUSTER_CAP = 12

/**
 * Every per-tool receipt metric in one pass over the transcript.
 *
 * These used to be five separate full scans (with `maxConsecutiveToolFailures`
 * computed twice), each calling `contentToText` on every tool result. On a long
 * run that is the dominant cost of building a receipt, and it runs every 5
 * steps plus at terminal teardown. `contentToText` now happens once per message.
 */
function scanToolMessages(messages: readonly SeedToolMessage[]): ToolMessageScan {
  const byName: Record<string, { ok: number; failed: number }> = {}
  const resultByCallId = new Map<string, { ok: boolean; content: string }>()
  const clusterCounts = new Map<string, number>()
  let totalCalls = 0
  let ok = 0
  let failed = 0
  let maxConsecutive = 0
  let currentConsecutive = 0
  const diagnostics = { calls: 0, ok: 0, clean: 0 }
  const tests: ToolMessageScan['tests'] = { calls: 0, ok: 0, failed: 0 }

  for (const msg of messages) {
    if (msg.role !== 'tool') continue
    const content = contentToText(msg.content ?? '')
    if (msg.toolCallId) {
      resultByCallId.set(msg.toolCallId, { ok: msg.ok !== false, content })
    }
    if (!msg.toolName) continue

    // Never-executed calls are usage, not failed executions: run-cancel/steer
    // stubs and approval/mode gate refusals must not inflate "N tools · M
    // failed" chips, Home topTools rows, or failureClusters.
    const isStub = isAbortStubToolResult(content) || isGateRefusalToolResult(content)

    // Consecutive-failure run: a stub breaks the run rather than extending it.
    if (isStub) currentConsecutive = 0
    else if (msg.ok === false) {
      currentConsecutive++
      if (currentConsecutive > maxConsecutive) maxConsecutive = currentConsecutive
    } else currentConsecutive = 0

    if (!isStub) {
      totalCalls++
      const entry = byName[msg.toolName] ?? { ok: 0, failed: 0 }
      if (msg.ok === false) {
        entry.failed++
        failed++
      } else {
        entry.ok++
        ok++
      }
      byName[msg.toolName] = entry
    }

    if (msg.ok === false && !isStub) {
      const text = failureClusterBody(msg.toolName, content)
      const key = `${msg.toolName}: ${text || '(no message)'}`
      clusterCounts.set(key, (clusterCounts.get(key) ?? 0) + 1)
    }

    if (msg.toolName === 'diagnostics') {
      diagnostics.calls++
      if (msg.ok !== false) {
        diagnostics.ok++
        const items = parseDiagnosticLines(content)
        if (!items.some((d) => (d.severity ?? 'error') === 'error')) diagnostics.clean++
      }
    } else if (msg.toolName === 'run_tests') {
      tests.calls++
      if (msg.ok === false) tests.failed++
      else tests.ok++
      const parsed = parseTestResultHeader(content)
      if (parsed) {
        tests.lastPassed = parsed.passed
        tests.lastFailed = parsed.failed
      }
    }
  }

  const failureClusters = [...clusterCounts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, FAILURE_CLUSTER_CAP)

  return {
    toolStats: { totalCalls, ok, failed, byName },
    failureClusters,
    maxConsecutiveToolFailures: maxConsecutive,
    diagnostics,
    tests,
    resultByCallId
  }
}

export function buildRunReceipt(input: {
  runId: string
  status: RunStatus
  messages: readonly ChatMessage[]
  events: readonly PersistedEvent[]
  contract: string
  runDir?: string
  /** Serving provider — tagged into the receipt for forward-looking usage splits. */
  provider?: string
  /** Serving model — tagged into the receipt for forward-looking usage splits. */
  model?: string
  /** Cumulative provider-reported cost (durable usage totals at write time). */
  billedCost?: number
  /** Raw model context window in effect at the final step (context pressure). */
  contextWindow?: number
}): RunReceipt {
  const incomplete = lastIncompleteFromEvents(input.events, input.status.invokeId)
  const tokenUsage = tokenUsageFromEvents(input.events)
  const scan = scanToolMessages(input.messages)
  const testStats = scan.tests
  const verification = verificationFromEvents(input.events, input.messages)

  const receipt: RunReceipt = {
    version: RUN_RECEIPT_VERSION,
    writtenAt: new Date().toISOString(),
    runId: input.runId,
    status: input.status.status,
    step: input.status.step,
    ...(typeof input.status.invokeId === 'number' ? { invokeId: input.status.invokeId } : {}),
    ...(input.status.goal ? { goal: input.status.goal } : {}),
    ...(input.status.mode ? { mode: input.status.mode } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.billedCost != null && input.billedCost > 0 ? { billedCost: input.billedCost } : {}),
    ...(input.contextWindow != null && input.contextWindow > 0
      ? { contextWindow: input.contextWindow }
      : {}),
    ...(input.status.error ? { statusError: input.status.error } : {}),
    ...(incomplete ? { incomplete } : {}),
    ...(tokenUsage ? { tokenUsage } : {}),
    compactionCount: compactionCountFromEvents(input.events),
    toolStats: scan.toolStats,
    failureClusters: scan.failureClusters,
    ...(scan.maxConsecutiveToolFailures > 0
      ? { maxConsecutiveToolFailures: scan.maxConsecutiveToolFailures }
      : {}),
    unreadEditPaths: unreadEditPathsFromMessages(input.messages, scan.resultByCallId),
    wroteFiles: wroteFilesFromEvents(input.events),
    diagnostics: scan.diagnostics,
    ...(testStats.calls > 0 ? { tests: testStats } : {}),
    ...(verification ? { verification } : {}),
    contractExcerpt: contractExcerpt(input.contract)
  }
  return RunReceiptSchema.parse(receipt)
}

export function writeRunReceipt(runDir: string, receipt: RunReceipt): void {
  atomicWriteJson(join(runDir, RUN_RECEIPT_FILENAME), receipt)
}

/** Best-effort: load run state pieces and write receipt.json. Never throws to callers. */
export function writeRunReceiptBestEffort(input: {
  runDir: string
  runId: string
  loadStatus: (dir: string) => RunStatus | null
  loadMessages: () => ChatMessage[]
  loadEvents: (dir: string) => PersistedEvent[]
  readContract: (dir: string) => string
  provider?: string
  model?: string
  /** Cumulative provider-reported cost (durable usage totals at write time). */
  billedCost?: number
  /** Raw model context window in effect at the final step (context pressure). */
  contextWindow?: number
}): RunReceipt | null {
  try {
    const status = input.loadStatus(input.runDir)
    if (!status) return null
    const receipt = buildRunReceipt({
      runId: input.runId,
      status,
      messages: input.loadMessages(),
      events: input.loadEvents(input.runDir),
      contract: input.readContract(input.runDir),
      runDir: input.runDir,
      provider: input.provider,
      model: input.model,
      billedCost: input.billedCost,
      contextWindow: input.contextWindow
    })
    writeRunReceipt(input.runDir, receipt)
    return receipt
  } catch (err) {
    logger.warn('Failed to write run receipt', {
      scope: 'agent',
      correlationId: input.runId,
      err
    })
    return null
  }
}
