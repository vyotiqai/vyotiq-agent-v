import { join } from 'path'
import { atomicWriteJson, atomicWriteJsonAsync } from '../storage/atomicWrite'
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
  toolArgsFromCall,
  unreadExistingEditPaths
} from './loopPolicy'
import { isFileMutationToolName, isRunArtifactEditPath } from './loopPolicy'
import { looksLikeWorkspacePath, normalizeWorkspaceRelPath } from './pathPlausibility'
import { parseDiagnosticLines } from './tools/diagnostics'
import { parseTestResultHeader, parseTestSummary } from './tools/runTests'
import { isCheckCommand } from './feedback/checkCommands'
import { logger } from '../../shared/logger'
import { stepUsageTotalsFromPersistedEvents } from '../../shared/utils/runTelemetry'
import { isTerminalSessionInProgress, parseTerminalOutput } from '../../shared/utils/terminalFormat'

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
function normalizeFailureClusterText(text: string): string {
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
  // Historical: Plan mode is merged into Agent, but receipts are recomputed
  // from pre-merge history, which still holds this refusal. Keep the cluster.
  if (/Plan mode may only edit plan\.md or contract\.md/i.test(text)) {
    return 'Plan mode may only edit plan.md or contract.md'
  }
  if (/Path escapes workspace/i.test(text)) {
    return 'Path escapes workspace (outside workspace root)'
  }
  return text.slice(0, 80)
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
        call.name === 'codebase_search' ||
        call.name === 'concept_search'
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

/** Every path written by any writes_checkpoint in the run (object entries or legacy strings). */
export function wroteFilesFromEvents(events: readonly PersistedEvent[]): string[] {
  // Cumulative across the whole run, like toolStats and failureClusters: a
  // resumed run flushes one writes_checkpoint per invoke, and returning on
  // the newest one reported only the last invoke's files as if the earlier
  // work had never happened. First-seen order, deduplicated.
  const paths: string[] = []
  const seen = new Set<string>()
  for (const row of events) {
    const ev = row.event as { type?: string; files?: unknown } | undefined
    if (ev?.type !== 'writes_checkpoint' || !Array.isArray(ev.files)) continue
    for (const entry of ev.files) {
      const raw =
        typeof entry === 'string'
          ? entry
          : entry && typeof entry === 'object' && typeof (entry as { path?: unknown }).path === 'string'
            ? (entry as { path: string }).path
            : null
      if (raw == null) continue
      const path = normalizeWorkspaceRelPath(raw)
      if (path && looksLikeWorkspacePath(path) && !isBuildOutputRelPath(path) && !seen.has(path)) {
        seen.add(path)
        paths.push(path)
      }
    }
  }
  return paths
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
        : {}),
      ...(totals.generationMs > 0 ? { generationMs: totals.generationMs } : {})
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
export const SKIPPED_CHECK_RE =
  /^(?:No test runner detected|No TypeScript project \(|No JavaScript project \()/

/** `diagnostics` and `run_tests` — the dedicated check tools (receipt stats key off these). */
export function isCheckResult(name: string | undefined): boolean {
  return name === 'diagnostics' || name === 'run_tests'
}

/**
 * Tools whose result may be a check: the two check tools, and `terminal`,
 * whose recognised test/typecheck/lint commands count too (see
 * feedback/checkCommands.ts). Which results actually count is
 * {@link checkVerdict}'s call.
 */
export function isCheckCandidateTool(name: string | undefined): boolean {
  return isCheckResult(name) || name === 'terminal'
}

/**
 * What one check-candidate result proved. `skip`: no check ran — no runner,
 * a denied or refused call, a command that failed to parse or spawn, a
 * command that is not a test/typecheck/lint runner, a terminal session still
 * running, or a result with an empty body. `failed`: it ran and reported
 * errors, exited non-zero, or timed out. A failing test run is `ok: false`, so
 * dropping every `ok: false` result (as this once did) let edit → clean
 * diagnostics → failing tests read verified.
 *
 * An empty body is a skip, never a clean. A slim persisted event whose body
 * was dropped once read `unknown`, and every consumer treated an `unknown` on
 * an `ok !== false` result as a pass — so a check that had produced no
 * evidence at all was recorded as a successful verification.
 */
export type CheckVerdict = 'skip' | 'clean' | 'failed'

const CHECK_RAN_AND_FAILED_RE = /^exit: |was killed \(timeout\)/m
const TERMINAL_EXIT_CODE_RE = /^exit_code:\s*(-?\d+)\s*$/gm

/**
 * @param command The command the call ran, from its arguments — `terminal`
 *   results carry it in a `command:` header only for session output.
 */
export function checkVerdict(
  name: string | undefined,
  ok: boolean | undefined,
  content: string,
  command?: string
): CheckVerdict {
  const text = content.trim()
  if (name === 'terminal') return terminalCheckVerdict(text, command)
  if (!text) return 'skip'
  if (ok === false) return CHECK_RAN_AND_FAILED_RE.test(text) ? 'failed' : 'skip'
  if (SKIPPED_CHECK_RE.test(text)) return 'skip'
  // A non-zero `exit:` line is decisive whatever the tool reported as `ok`:
  // `diagnostics` returns ok:true as soon as the command printed parseable
  // diagnostics, so a lint that exits 1 on a single warning
  // (`eslint . --max-warnings 0`) carried a warning-severity body that read
  // clean and stamped the run verified on a failed check.
  if (name === 'diagnostics' && CHECK_RAN_AND_FAILED_RE.test(text)) return 'failed'
  if (name === 'run_tests') {
    // run_tests runs whatever command it is handed; only a test, typecheck
    // or lint runner verified anything.
    const ran = /^command: (.*)$/m.exec(text)?.[1]
    if (ran != null && !isCheckCommand(ran)) return 'skip'
  }
  const clean = name === 'run_tests' ? runTestsCheckClean(text) : diagnosticsCheckClean(text)
  return clean ? 'clean' : 'failed'
}

/**
 * A terminal result is a check when its command is a recognised runner and
 * it finished: judged by its exit code, and by the runner's own failure
 * count when one is printed. A session still running, or a slim event with
 * no body, proves nothing yet.
 */
function terminalCheckVerdict(text: string, command: string | undefined): CheckVerdict {
  if (!text) return 'skip'
  const parsed = parseTerminalOutput(text)
  if (!isCheckCommand(parsed.command ?? command)) return 'skip'
  if (isTerminalSessionInProgress(parsed.sessionStatus)) return 'skip'
  let exitCode: number | null = null
  for (const match of text.matchAll(TERMINAL_EXIT_CODE_RE)) exitCode = Number(match[1])
  if (exitCode == null) return 'skip'
  if (exitCode !== 0) return 'failed'
  const summary = parseTestSummary(text)
  return summary && summary.failed > 0 ? 'failed' : 'clean'
}

/** run_tests cleanliness: parsed failed-count; header absent + ok → exit 0. */
export function runTestsCheckClean(content: string): boolean {
  const parsed = parseTestResultHeader(content)
  return parsed == null ? true : parsed.failed === 0
}

/** diagnostics cleanliness: no error-severity diagnostic lines. */
export function diagnosticsCheckClean(content: string): boolean {
  return !parseDiagnosticLines(content).some((d) => (d.severity ?? 'error') === 'error')
}

/**
 * Message-side check verdicts (full tool content) in message order. Zips by
 * order with the event-side list when counts align (tool messages and
 * tool_result events append 1:1 and both stitch their archives), so a slim
 * persisted event — content dropped past 200 chars — still carries the full
 * result's verdict. Both sides list every check result, skips included, so
 * a skip only one side can recognise never shifts the zip.
 */
function checkVerdictsFromMessages(messages: readonly SeedToolMessage[]): CheckVerdict[] {
  const out: CheckVerdict[] = []
  const commandByCallId = new Map<string, string>()
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      for (const call of msg.toolCalls ?? []) {
        if (call.name !== 'terminal') continue
        const command = toolArgsFromCall(call.arguments).command
        if (typeof command === 'string') commandByCallId.set(call.id, command)
      }
      continue
    }
    if (msg.role !== 'tool' || !msg.toolName || !isCheckCandidateTool(msg.toolName)) continue
    const command = msg.toolCallId ? commandByCallId.get(msg.toolCallId) : undefined
    out.push(checkVerdict(msg.toolName, msg.ok, contentToText(msg.content ?? ''), command))
  }
  return out
}

/**
 * When a writes_checkpoint's mutations happened. The event is flushed at
 * invoke end — after every check that invoke ran — so its own `at` would date
 * every write after its checks and no writing run could ever read verified.
 * Each file is dated by its last observed write (`lastMutatedAt`, set when a
 * terminal, MCP, lsp, merge or git_apply write touches a path already in the
 * checkpoint), else its first (`recordedAt`); re-edits through edit tools are
 * dated by their tool_result instead. Build output (`obj/`, `bin/Debug`) is
 * skipped, as it is for `wroteFiles`. A file the user discarded was reverted
 * when this event was written, so it dates to the event. An unstamped file (a
 * checkpoint written before the stamps existed) contributes nothing — dating
 * the whole checkpoint by it would push every stamped write forward to the
 * flush time — so the flush time is the fallback for a checkpoint where no
 * file carries a stamp.
 */
function checkpointMutationAt(
  files: unknown,
  flushedAt: string,
  undone: boolean
): string | undefined {
  if (!Array.isArray(files) || files.length === 0) return flushedAt
  let latest: string | undefined
  for (const file of files as Array<{
    path?: unknown
    recordedAt?: unknown
    lastMutatedAt?: unknown
    resolved?: unknown
  }>) {
    if (typeof file?.path === 'string') {
      const path = normalizeWorkspaceRelPath(file.path)
      if (!path || isBuildOutputRelPath(path)) continue
    }
    let at: string | undefined
    if (undone && file?.resolved === 'discarded') at = flushedAt
    else if (typeof file?.lastMutatedAt === 'string') at = file.lastMutatedAt
    else if (typeof file?.recordedAt === 'string') at = file.recordedAt
    if (at == null) continue
    latest = laterIso(latest, at)
  }
  return latest ?? flushedAt
}

/** Epoch ms for an ISO stamp, or null when it does not parse. */
function instantOf(iso: string): number | null {
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms
}

/**
 * Later of two stamps, by INSTANT. A stored stamp need not be a
 * `toISOString` value — an offset-bearing `+05:30` one orders after a Z stamp
 * that is later in wall-clock text — so string compare alone could date a
 * mutation backwards. Well-formed `toISOString` stamps are all UTC, where
 * instant order and string order agree, so their behaviour is unchanged.
 * An unparseable stamp falls back to the string compare.
 */
function laterIso(a: string | undefined, b: string): string {
  if (a == null) return b
  const ta = instantOf(a)
  const tb = instantOf(b)
  if (ta == null || tb == null) return b > a ? b : a
  return tb > ta ? b : a
}

/** Is `a` at or after `b`? Same instant rule as {@link laterIso}. */
function atOrAfter(a: string, b: string): boolean {
  const ta = instantOf(a)
  const tb = instantOf(b)
  if (ta == null || tb == null) return a >= b
  return ta >= tb
}

/**
 * Was the work verified? Compares diagnostics/run_tests checks against the
 * last mutation — a successful edit-family tool call on a workspace file, or
 * a file in a writes_checkpoint (which also catches terminal and MCP
 * writes). The verified state requires the newest check after the last
 * mutation to have run AND passed clean — a failing or errored check is a
 * failed verification, and a check that never ran verified nothing.
 * Informational only — the loop never blocks on it.
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
  const eventChecks: Array<{ at: string | undefined; verdict: CheckVerdict }> = []
  for (const row of events) {
    const ev = row.event as {
      type?: string
      name?: string
      ok?: boolean
      summary?: unknown
      content?: unknown
      files?: unknown
      undone?: unknown
    } | undefined
    if (ev?.type === 'writes_checkpoint' && row.at) {
      const at = checkpointMutationAt(ev.files, row.at, ev.undone === true)
      if (at) lastMutationAt = laterIso(lastMutationAt, at)
    }
    if (
      ev?.type === 'tool_result' &&
      ev.ok === true &&
      ev.name &&
      isFileMutationToolName(ev.name) &&
      !isRunArtifactEditPath(typeof ev.summary === 'string' ? ev.summary : undefined) &&
      row.at
    ) {
      lastMutationAt = laterIso(lastMutationAt, row.at)
    }
    if (ev?.type !== 'tool_result' || !isCheckCandidateTool(ev.name)) continue
    // Slim events drop bodies past 200 chars; such a body reads as an absent
    // check here (`skip`, like a denied call) and takes the message side's
    // verdict when the two lists align. A terminal event's summary is its
    // command, cut to 80.
    const content = typeof ev.content === 'string' ? ev.content : ''
    const command = ev.name === 'terminal' && typeof ev.summary === 'string' ? ev.summary : undefined
    eventChecks.push({ at: row.at, verdict: checkVerdict(ev.name, ev.ok, content, command) })
  }
  // Full-content message verdicts win when the two sides stayed aligned.
  const messageVerdicts = checkVerdictsFromMessages(messages)
  const aligned = eventChecks.length > 0 && messageVerdicts.length === eventChecks.length
  // A zip that does not line up is not a pass. Dropping the message side
  // wholesale left each check on the slimmed event-side verdict, so a check
  // whose real result was truncated away could reappear as `clean` purely
  // because one message never reached the event file (a repaired orphan stub,
  // a rewind). Downgrade the `clean`s to `skip` — no result to line up with
  // is no evidence — and keep `failed`, which is evidence on its own.
  const untrusted = !aligned && messageVerdicts.length > 0
  const checks = eventChecks
    .map((check, i) => {
      const verdict = (aligned ? messageVerdicts[i] : undefined) ?? check.verdict
      if (!untrusted || verdict !== 'clean') return { ...check, verdict }
      return { ...check, verdict: 'skip' as const }
    })
    .filter((check): check is typeof check & { at: string } => check.verdict !== 'skip' && !!check.at)
  const lastCheck = checks[checks.length - 1]
  if (lastMutationAt == null && lastCheck == null) return undefined
  // Only a verdict the check actually earned counts as a pass. An absent
  // verdict is evidence of nothing passing.
  const lastCheckClean = lastCheck != null && lastCheck.verdict === 'clean'
  return {
    ...(lastMutationAt ? { lastMutationAt } : {}),
    ...(lastCheck ? { lastCheckAt: lastCheck.at } : {}),
    verifiedAfterLastMutation:
      lastCheckClean && (lastMutationAt == null || atOrAfter(lastCheck.at, lastMutationAt))
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

/** Every field the schema requires, with a value that claims nothing. */
const MINIMAL_RECEIPT: Omit<RunReceipt, 'writtenAt'> = {
  version: RUN_RECEIPT_VERSION,
  runId: 'unknown',
  // Placeholder: the caller keeps the run's real outcome, but a fallback has
  // no verified state, no per-tool metrics and no files to speak of.
  status: 'error',
  step: 0,
  compactionCount: 0,
  toolStats: { totalCalls: 0, ok: 0, failed: 0, byName: {} },
  failureClusters: [],
  unreadEditPaths: [],
  wroteFiles: [],
  diagnostics: { calls: 0, ok: 0, clean: 0 },
  contractExcerpt: ''
}

/**
 * A receipt must survive its own schema. Every field it carries is derived, so
 * one malformed value used to throw out of `buildRunReceipt` — and on the
 * best-effort path that cost the run its receipt entirely. Drop the fields the
 * schema objects to and parse again; if a required field is itself the
 * offender, fall back to a bare record that asserts nothing. Verification is
 * absent in both fallbacks, which reads as unchecked, never as verified.
 */
function parseRunReceipt(receipt: RunReceipt): RunReceipt {
  const parsed = RunReceiptSchema.safeParse(receipt)
  if (parsed.success) return parsed.data
  const trimmed: Record<string, unknown> = { ...receipt }
  for (const issue of parsed.error.issues) {
    const key = issue.path[0]
    if (typeof key === 'string') delete trimmed[key]
  }
  const retried = RunReceiptSchema.safeParse(trimmed)
  if (retried.success) return retried.data
  const identity: Record<string, unknown> = { ...MINIMAL_RECEIPT }
  if (typeof trimmed.runId === 'string' && trimmed.runId) identity.runId = trimmed.runId
  if (
    trimmed.status === 'running' ||
    trimmed.status === 'cancelled' ||
    trimmed.status === 'error' ||
    trimmed.status === 'done'
  ) {
    identity.status = trimmed.status
  }
  if (typeof trimmed.step === 'number' && Number.isInteger(trimmed.step) && trimmed.step >= 0) {
    identity.step = trimmed.step
  }
  if (typeof trimmed.writtenAt === 'string' && trimmed.writtenAt) {
    identity.writtenAt = trimmed.writtenAt
  }
  return RunReceiptSchema.parse(identity)
}

export function buildRunReceipt(input: {
  runId: string
  status: RunStatus
  messages: readonly ChatMessage[]
  events: readonly PersistedEvent[]
  contract: string
  /** Serving provider — tagged into the receipt for forward-looking usage splits. */
  provider?: string
  /** Serving model — tagged into the receipt for forward-looking usage splits. */
  model?: string
  /** Cumulative provider-reported cost (durable usage totals at write time). */
  billedCost?: number
  /**
   * Cumulative estimated cost (tokens × published model prices) for runs
   * whose provider never reported a cost field. Kept separate from
   * `billedCost` — never presented as a provider bill.
   */
  estimatedCost?: number
  /** Raw model context window in effect at the final step (context pressure). */
  contextWindow?: number
  /**
   * Live turn-end gate verdict from the loop's verification tracker. Typed off
   * the schema rather than imported from `feedback/verification` — that module
   * imports the cleanliness predicates from here.
   */
  verificationGate?: RunReceipt['verificationGate']
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
    ...(input.estimatedCost != null && input.estimatedCost > 0
      ? { estimatedCost: input.estimatedCost }
      : {}),
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
    ...(input.verificationGate ? { verificationGate: input.verificationGate } : {}),
    contractExcerpt: contractExcerpt(input.contract)
  }
  return parseRunReceipt(receipt)
}

export function writeRunReceipt(runDir: string, receipt: RunReceipt): void {
  atomicWriteJson(join(runDir, RUN_RECEIPT_FILENAME), receipt)
}

/**
 * Async twin, used on the best-effort path.
 *
 * The sync writer's Windows rename backoff totals ~18ms (deliberately shrunk so
 * per-step checkpoint writes stop freezing the main thread), which is not
 * enough for AV/indexer contention: the field log shows
 * `EPERM: rename receipt.json.<pid>.<hex>.tmp -> receipt.json` losing a run's
 * receipt outright. The async ladder retries for ~385ms and blocks nothing,
 * and a receipt write is not on any latency path.
 */
export async function writeRunReceiptAsync(
  runDir: string,
  receipt: RunReceipt
): Promise<void> {
  await atomicWriteJsonAsync(join(runDir, RUN_RECEIPT_FILENAME), receipt)
}

/** Best-effort: load run state pieces and write receipt.json. Never throws to callers. */
export async function writeRunReceiptBestEffort(input: {
  runDir: string
  runId: string
  loadStatus: (dir: string) => RunStatus | null
  loadMessages: () => ChatMessage[] | Promise<ChatMessage[]>
  loadEvents: (dir: string) => PersistedEvent[]
  readContract: (dir: string) => string
  provider?: string
  model?: string
  /** Cumulative provider-reported cost (durable usage totals at write time). */
  billedCost?: number
  /** Cumulative estimated cost (tokens × published prices) — estimate only. */
  estimatedCost?: number
  /** Raw model context window in effect at the final step (context pressure). */
  contextWindow?: number
  /** Live turn-end gate verdict from the loop's verification tracker. */
  verificationGate?: RunReceipt['verificationGate']
}): Promise<RunReceipt | null> {
  try {
    const status = input.loadStatus(input.runDir)
    if (!status) return null
    const receipt = buildRunReceipt({
      runId: input.runId,
      status,
      messages: await input.loadMessages(),
      events: input.loadEvents(input.runDir),
      contract: input.readContract(input.runDir),
      provider: input.provider,
      model: input.model,
      billedCost: input.billedCost,
      estimatedCost: input.estimatedCost,
      contextWindow: input.contextWindow,
      verificationGate: input.verificationGate
    })
    await writeRunReceiptAsync(input.runDir, receipt)
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
