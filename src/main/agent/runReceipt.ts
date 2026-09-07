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

function toolStatsFromMessages(messages: readonly SeedToolMessage[]): RunReceipt['toolStats'] {
  const byName: Record<string, { ok: number; failed: number }> = {}
  let totalCalls = 0
  let ok = 0
  let failed = 0
  for (const msg of messages) {
    if (msg.role !== 'tool' || !msg.toolName) continue
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
  return { totalCalls, ok, failed, byName }
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

function failureClustersFromMessages(
  messages: readonly SeedToolMessage[],
  cap = 12
): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>()
  for (const msg of messages) {
    if (msg.role !== 'tool' || msg.ok !== false || !msg.toolName) continue
    const content = contentToText(msg.content ?? '')
    if (isAbortStubToolResult(content)) continue
    const text = failureClusterBody(msg.toolName, content)
    const key = `${msg.toolName}: ${text || '(no message)'}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, cap)
}

/** Longest run of back-to-back failed tool calls in message order (weakness signal). */
export function maxConsecutiveToolFailuresFromMessages(
  messages: readonly SeedToolMessage[]
): number {
  let max = 0
  let current = 0
  for (const msg of messages) {
    if (msg.role !== 'tool' || !msg.toolName) continue
    if (isAbortStubToolResult(contentToText(msg.content ?? ''))) {
      current = 0
      continue
    }
    if (msg.ok === false) {
      current++
      if (current > max) max = current
    } else {
      current = 0
    }
  }
  return max
}

function unreadEditPathsFromMessages(messages: readonly SeedToolMessage[]): string[] {
  const known = new Set<string>()
  const unread = new Set<string>()
  const resultByCallId = new Map<string, { ok: boolean; content: string }>()
  for (const msg of messages) {
    if (msg.role !== 'tool' || !msg.toolCallId) continue
    resultByCallId.set(msg.toolCallId, {
      ok: msg.ok !== false,
      content: contentToText(msg.content ?? '')
    })
  }
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

function countDiagnosticsCalls(messages: readonly ChatMessage[]): {
  calls: number
  ok: number
  clean: number
} {
  let calls = 0
  let ok = 0
  let clean = 0
  for (const msg of messages) {
    if (msg.role !== 'tool' || msg.toolName !== 'diagnostics') continue
    calls++
    if (msg.ok !== false) {
      ok++
      const items = parseDiagnosticLines(contentToText(msg.content ?? ''))
      if (!items.some((d) => (d.severity ?? 'error') === 'error')) clean++
    }
  }
  return { calls, ok, clean }
}

/** run_tests aggregate: call counts plus the latest parsed pass/fail summary. */
function testStatsFromMessages(messages: readonly ChatMessage[]): {
  calls: number
  ok: number
  failed: number
  lastPassed?: number
  lastFailed?: number
} {
  let calls = 0
  let ok = 0
  let failed = 0
  let lastPassed: number | undefined
  let lastFailed: number | undefined
  for (const msg of messages) {
    if (msg.role !== 'tool' || msg.toolName !== 'run_tests') continue
    calls++
    if (msg.ok === false) failed++
    else ok++
    const parsed = parseTestResultHeader(contentToText(msg.content ?? ''))
    if (parsed) {
      lastPassed = parsed.passed
      lastFailed = parsed.failed
    }
  }
  return {
    calls,
    ok,
    failed,
    ...(lastPassed != null ? { lastPassed } : {}),
    ...(lastFailed != null ? { lastFailed } : {})
  }
}

/**
 * Was the work verified? Compares the last successful diagnostics/run_tests
 * tool_result against the last writes_checkpoint. Informational only — the
 * loop never blocks on it.
 */
function verificationFromEvents(events: readonly PersistedEvent[]): {
  lastMutationAt?: string
  lastCheckAt?: string
  verifiedAfterLastMutation: boolean
} | undefined {
  let lastMutationAt: string | undefined
  let lastCheckAt: string | undefined
  for (const row of events) {
    const ev = row.event as { type?: string; name?: string; ok?: boolean } | undefined
    if (ev?.type === 'writes_checkpoint' && row.at) lastMutationAt = row.at
    if (
      ev?.type === 'tool_result' &&
      (ev.name === 'diagnostics' || ev.name === 'run_tests') &&
      ev.ok === true &&
      row.at
    ) {
      lastCheckAt = row.at
    }
  }
  if (lastMutationAt == null && lastCheckAt == null) return undefined
  return {
    ...(lastMutationAt ? { lastMutationAt } : {}),
    ...(lastCheckAt ? { lastCheckAt } : {}),
    verifiedAfterLastMutation:
      lastCheckAt != null && (lastMutationAt == null || lastCheckAt >= lastMutationAt)
  }
}

export function buildRunReceipt(input: {
  runId: string
  status: RunStatus
  messages: readonly ChatMessage[]
  events: readonly PersistedEvent[]
  contract: string
  runDir?: string
}): RunReceipt {
  const incomplete = lastIncompleteFromEvents(input.events, input.status.invokeId)
  const tokenUsage = tokenUsageFromEvents(input.events)
  const testStats = testStatsFromMessages(input.messages)
  const verification = verificationFromEvents(input.events)

  const receipt: RunReceipt = {
    version: RUN_RECEIPT_VERSION,
    writtenAt: new Date().toISOString(),
    runId: input.runId,
    status: input.status.status,
    step: input.status.step,
    ...(typeof input.status.invokeId === 'number' ? { invokeId: input.status.invokeId } : {}),
    ...(input.status.goal ? { goal: input.status.goal } : {}),
    ...(input.status.mode ? { mode: input.status.mode } : {}),
    ...(input.status.error ? { statusError: input.status.error } : {}),
    ...(incomplete ? { incomplete } : {}),
    ...(tokenUsage ? { tokenUsage } : {}),
    compactionCount: compactionCountFromEvents(input.events),
    toolStats: toolStatsFromMessages(input.messages),
    failureClusters: failureClustersFromMessages(input.messages),
    ...(maxConsecutiveToolFailuresFromMessages(input.messages) > 0
      ? { maxConsecutiveToolFailures: maxConsecutiveToolFailuresFromMessages(input.messages) }
      : {}),
    unreadEditPaths: unreadEditPathsFromMessages(input.messages),
    wroteFiles: wroteFilesFromEvents(input.events),
    diagnostics: countDiagnosticsCalls(input.messages),
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
      runDir: input.runDir
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
