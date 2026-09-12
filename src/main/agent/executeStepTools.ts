import { existsSync } from 'fs'
import type { AgentEvent, AgentInteractionMode, ChatMessage, Settings } from '../../shared/ipc'
import { isAbortError } from '../../shared/errors'
import { composeAbortSignal } from '../../shared/utils/errors'
import { logger } from '../../shared/logger'
import { summarizeToolArgs } from '../../shared/toolSummary'
import { toolResultEventForPersistence } from '../../shared/utils/toolResultIpc'
import type { ToolCall } from './providers/types'
import { executeTool, type ToolResult } from '@main/agent/tools'
import { canonicalizeAgentToolName } from './schemas/tools'
import {
  isParallelBatchClass,
  parallelLimitForBatchClass,
  parallelMutationPathKey,
  stepToolBatchClass,
  type StepToolBatchClass
} from './tools/classify'
import type { ToolApprovalGate } from './toolApproval'
import type { TerminalShell } from '../../shared/ipc'
import { resolveInsideWorkspace } from '../workspace/safePath'
import {
  applyToolCallToKnownPaths,
  applyToolCallToMutationPaths,
  deletePathFromToolCall,
  editPathsFromToolCall,
  isConcreteWorkspacePath,
  isFileMutationToolName,
  isInspectToolName,
  normalizeWorkspaceRelPath,
  toolArgsFromCall,
  unreadExistingEditPaths
} from './loopPolicy'
import { searchHitPathsFromResult } from './tools/search'
import { codebaseSearchHitPathsFromResult } from './codeindex/query'
import { readPathArg } from './tools/argAccess'
import { hasJavaScriptProject, hasTypeScriptProject } from './tools/diagnostics'
import { ensureToolCallIds } from './dedupeToolCalls'
import { yieldToEventLoop } from './tools/walk'
export const SOFT_WARN_MUTATION_WITHOUT_DIAGNOSTICS =
  '[Soft warning: this step mutated file(s) without calling diagnostics. Run diagnostics (typecheck/lint) before treating the change as done.]'

/**
 * A read is "recent" if the same path was returned within this many agent
 * steps. Beyond that, workspace state may plausibly have moved on.
 */
const RECENT_READ_STALE_STEPS = 4

/**
 * Soft note when the model re-reads a path whose contents are already in its
 * recent context. Deliberately non-blocking: re-reads are sometimes legitimate
 * (file may have changed, targeted startLine/endLine window). Mirrors the
 * soft-warning pattern used for unread-edit and missing-diagnostics nudges.
 */
export function recentRereadNote(
  recentReadPaths: Map<string, number> | undefined,
  readStampStep: number | undefined,
  name: string,
  args: Record<string, unknown>
): string | undefined {
  if (!recentReadPaths || readStampStep == null) return undefined
  if (name !== 'read') return undefined
  const path = readPathArg(args) ? normalizeWorkspaceRelPath(readPathArg(args)!) : ''
  if (!path) return undefined
  // A ranged read targets a specific window — not the full-file restatement
  // the guard exists for.
  if (args.startLine !== undefined || args.endLine !== undefined) return undefined
  const lastReadAt = recentReadPaths.get(path)
  if (lastReadAt == null) return undefined
  const age = readStampStep - lastReadAt
  if (age < 0 || age > RECENT_READ_STALE_STEPS) return undefined
  return `[Note: ${path} was already read ${age === 0 ? 'this step' : `${age} step${age === 1 ? '' : 's'} ago`} and its contents are in your context. Re-read only if you expect it changed.]`
}

/** Record inspect-tool paths after a successful call. */
function recordRecentReads(
  recentReadPaths: Map<string, number> | undefined,
  readStampStep: number | undefined,
  name: string,
  args: Record<string, unknown>,
  ok: boolean,
  resultContent: string | undefined
): void {
  if (!recentReadPaths || readStampStep == null) return
  // A mutation makes every prior read of the target stale — a following re-read
  // is legitimate and must not be noted. Delete also removes descendants.
  if (ok && isFileMutationToolName(name)) {
    for (const path of editPathsFromToolCall(name, args)) recentReadPaths.delete(path)
    const deleted = deletePathFromToolCall(name, args)
    if (deleted) {
      const prefix = normalizeWorkspaceRelPath(deleted)
      recentReadPaths.delete(prefix)
      const dirPrefix = `${prefix}/`
      for (const key of [...recentReadPaths.keys()]) {
        if (key.startsWith(dirPrefix)) recentReadPaths.delete(key)
      }
    }
    return
  }
  if (!ok) return
  if (!isInspectToolName(name)) return
  const stampStep = readStampStep
  if (name === 'read' || name === 'list_dir') {
    const path = readPathArg(args) ? normalizeWorkspaceRelPath(readPathArg(args)!) : ''
    if (path) recentReadPaths.set(path, stampStep)
    return
  }
  if (name === 'grep') {
    const raw = typeof args.include === 'string' ? args.include : args.path
    if (typeof raw === 'string' && isConcreteWorkspacePath(raw)) {
      recentReadPaths.set(normalizeWorkspaceRelPath(raw), stampStep)
    }
    return
  }
  if (name === 'glob') {
    const pattern = typeof args.pattern === 'string' ? args.pattern : ''
    if (isConcreteWorkspacePath(pattern)) {
      recentReadPaths.set(normalizeWorkspaceRelPath(pattern), stampStep)
    }
    return
  }
  // search / codebase_search: stamp concrete hit paths from the result text.
  if (typeof resultContent === 'string' && resultContent) {
    const hits =
      name === 'search'
        ? searchHitPathsFromResult(resultContent)
        : codebaseSearchHitPathsFromResult(resultContent)
    for (const hit of hits) {
      const path = normalizeWorkspaceRelPath(hit)
      if (isConcreteWorkspacePath(path)) recentReadPaths.set(path, stampStep)
    }
  }
}


export type ToolStepContext = {
  runId: string
  runDir: string
  workspace: string
  /** Parent/session workspace when `workspace` is an instance worktree. */
  sessionWorkspace?: string
  /** True when this invoke is a depth-1 inline instance. */
  inlineInstance?: boolean
  /** Combined run cancel + soft stream / follow-up interrupt. */
  signal: AbortSignal
  /** Run-level cancel only — distinguishes Interrupted vs Cancelled. */
  runSignal?: AbortSignal
  appendMessage: (msg: ChatMessage) => Promise<void>
  appendEvent: (ev: AgentEvent) => void
  /** Session-scoped paths already inspected or edited (read-before-edit soft warn). */
  knownPaths?: Set<string>
  /** Run-scoped paths the agent actually changed (scopes git_commit staging). */
  mutationPaths?: Set<string>
  /** Present when tool approval is on, or MCP tools protection is on. */
  approval?: ToolApprovalGate
  /** ChatStart invoke that owns this step; scopes interactive cancel. */
  invokeId?: number
  /** Ask / Plan / Agent for this invoke (mutable via switch_mode). */
  agentMode?: AgentInteractionMode
  getAgentMode?: () => AgentInteractionMode
  setAgentMode?: (mode: AgentInteractionMode) => void | Promise<void>
  /** autoModeSwitch at last step boundary (refreshed each loop step). */
  autoModeSwitch?: boolean
  /** Snapshot of settings.terminalShell for this invoke. */
  terminalShell?: TerminalShell
  /** Snapshot of settings.diagnosticsCommand for this invoke. */
  diagnosticsCommand?: string
  /** Invoke-snapshotted settings for tools that must not read live Settings mid-run. */
  invokeSettings?: Settings
  /** Streams events while a tool is still running. */
  emitLiveEvent?: (ev: AgentEvent) => void
  /**
   * MCP servers enabled for this run (workspace overrides applied).
   * Enforced at invoke time so Force-off cannot be bypassed via stale tool names.
   */
  runEnabledMcpIds?: ReadonlySet<string>
  /** Per-server allow/deny for bare MCP tool names. */
  mcpToolPolicies?: ReadonlyMap<string, { allowedTools?: string[]; deniedTools?: string[] }>
  /**
   * MCP tool full names in this step's provider catalog (post budget trim).
   * When set, MCP invokes outside this set are rejected.
   */
  stepMcpToolNames?: ReadonlySet<string>
  /** Run-scoped MCP tools pinned via request_mcp_tools. */
  runPinnedMcpToolNames?: Set<string>
  /** Sticky catalog names — also admits deferred optional builtins after pin. */
  runStickyToolNames?: Set<string>
  /** Last step each MCP tool was pinned or invoked. */
  mcpLastUsedByName?: Map<string, number>
  /** Current agent step for last-used stamps. */
  currentStep?: number
  invalidateMcpToolCatalogCache?: () => void
  /** Run-scoped MCP not-in-catalog rejection counts (per full tool name). */
  mcpNotInCatalogCounts?: Map<string, number>
  /**
   * Run-scoped paths returned by a recent successful read/list_dir/grep/glob.
   * A read of an already-read path gets a soft note (cheap steering) instead of
   * burning a full step on re-inspection the model already has in context.
   */
  recentReadPaths?: Map<string, number>
  /** Current agent step — stamps recentReadPaths entries. */
  readStampStep?: number
}

type ToolOutcome = {
  ok: boolean
  events: AgentEvent[]
  message: ChatMessage
}

function abortToolContent(ctx: ToolStepContext): string {
  const runAborted = ctx.runSignal?.aborted ?? ctx.signal.aborted
  if (runAborted) return 'Cancelled'
  if (ctx.signal.aborted) return 'Interrupted'
  return 'Cancelled'
}

function abortToolSummary(ctx: ToolStepContext): string {
  return abortToolContent(ctx).toLowerCase()
}

function emitToolStart(ctx: ToolStepContext, event: AgentEvent): void {
  ctx.appendEvent(event)
  ctx.emitLiveEvent?.(event)
}

function emitToolResult(ctx: ToolStepContext, event: AgentEvent): void {
  if (event.type !== 'tool_result') return
  ctx.emitLiveEvent?.(event)
}

/**
 * Soft deadline per tool invocation. Tools receive the abort signal, but a
 * handler that ignores it must not hold the run slot forever. On expiry the
 * call resolves as a failed tool result (counted by loop-safety streaks).
 *
 * Expiry also aborts the tool through `onDeadline`. Without it the handler is
 * merely abandoned mid-flight: a shell it spawned keeps running after the run
 * moves on, and the next command contends with it for the same repo (one wedged
 * `vitest` tree outlived its deadline by ~25 minutes and starved the retry).
 * Aborting propagates to the handlers that own processes — terminal kills its
 * whole child tree, background sessions dispose — so nothing outlives the slot.
 */
export const TOOL_SOFT_DEADLINE_MS = resolveSoftDeadlineMs()

/**
 * Tools exempt from the soft deadline: ask_question resolves only when the
 * human answers, so "stuck" is the normal state while it waits — deadline-
 * killing it registers every long wait as a tool failure. Only the run's own
 * AbortSignal (cancel/interrupt) ends it.
 */
const DEADLINE_EXEMPT_TOOLS: ReadonlySet<string> = new Set(['ask_question'])

function resolveSoftDeadlineMs(): number {
  const raw = process.env.VYOTIQ_TOOL_SOFT_DEADLINE_MS
  if (raw) {
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return 10 * 60_000
}

async function raceToolDeadline(
  pending: Promise<ToolResult>,
  name: string,
  onDeadline?: () => void
): Promise<ToolResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<ToolResult>((resolve) => {
    timer = setTimeout(() => {
      // Resolve before aborting: both settle in the same tick, and settling the
      // deadline first is what wins the race, so the step reports the deadline
      // instead of an AbortError. The abort and its tree-kill still run.
      resolve({
        ok: false,
        summary: name,
        content: `Tool "${name}" exceeded its ${Math.round(TOOL_SOFT_DEADLINE_MS / 60_000)}-minute deadline and was stopped. Split the work into smaller calls or check whether the tool is stuck.`,
        failureLogged: false
      })
      onDeadline?.()
    }, TOOL_SOFT_DEADLINE_MS)
  })
  try {
    // The loser keeps running after the race settles. Aborting it on the
    // deadline path makes it reject with AbortError — swallow that, or the
    // late rejection surfaces as an unhandledRejection in the main process.
    void pending.catch(() => {})
    return await Promise.race([pending, deadline])
  } finally {
    clearTimeout(timer)
  }
}

async function runSingleTool(
  call: ToolCall,
  ctx: ToolStepContext,
  stepFlags?: { softDiagnosticsNudge?: boolean }
): Promise<ToolOutcome> {
  const events: AgentEvent[] = []
  const summary = summarizeToolArgs(call.name, call.arguments)
  events.push({
    type: 'tool_start',
    runId: ctx.runId,
    toolCallId: call.id,
    name: call.name,
    summary
  })
  emitToolStart(ctx, events[0]!)

  try {
    // Ask before doing anything: the tool_start event is already out, so the
    // renderer can show the approval card in the row the user is looking at.
    if (ctx.approval) {
      const verdict = await ctx.approval.authorize(call)
      if (!verdict.allowed) {
        const pathSummary = summarizeToolArgs(call.name, call.arguments) || call.name
        const toolMsg: ChatMessage = {
          role: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          content: verdict.reason,
          ok: false
        }
        events.push({
          type: 'tool_result',
          runId: ctx.runId,
          toolCallId: call.id,
          name: call.name,
          summary: pathSummary,
          ok: false,
          content: verdict.reason
        })
        return { ok: false, events, message: toolMsg }
      }
    }

    const toolArgs = toolArgsFromCall(call.arguments)
    const rereadNote = recentRereadNote(
      ctx.recentReadPaths,
      ctx.readStampStep,
      call.name,
      toolArgs
    )
    const unreadPaths =
      ctx.knownPaths != null
        ? unreadExistingEditPaths(ctx.knownPaths, call.name, toolArgs, (rel) => {
            try {
              return existsSync(resolveInsideWorkspace(ctx.workspace, rel))
            } catch {
              return false
            }
          })
        : []

    // Per-call signal: the run signal plus a deadline-only abort. The deadline
    // must not abort ctx.signal itself — that is shared with sibling tools in
    // the step, and cancelling it would cancel every one of them.
    const deadlineController = new AbortController()
    const toolSignal = composeAbortSignal(ctx.signal, deadlineController.signal)

    const pending = executeTool(call.name, call.arguments, ctx.workspace, toolSignal, {
      runDir: ctx.runDir,
      sessionWorkspace: ctx.sessionWorkspace,
      inlineInstance: ctx.inlineInstance,
      runId: ctx.runId,
      toolCallId: call.id,
      invokeId: ctx.invokeId,
      /** Hard run cancel only — soft stream interrupt stays on `signal`. */
      runSignal: ctx.runSignal,
      agentMode: ctx.getAgentMode?.() ?? ctx.agentMode,
      getAgentMode: ctx.getAgentMode,
      setAgentMode: ctx.setAgentMode,
      autoModeSwitch: ctx.autoModeSwitch,
      terminalShell: ctx.terminalShell,
      diagnosticsCommand: ctx.diagnosticsCommand,
      invokeSettings: ctx.invokeSettings,
      emitAgentEvent: ctx.emitLiveEvent,
      knownPaths: ctx.knownPaths,
      runEnabledMcpIds: ctx.runEnabledMcpIds,
      mcpToolPolicies: ctx.mcpToolPolicies,
      stepMcpToolNames: ctx.stepMcpToolNames,
      runPinnedMcpToolNames: ctx.runPinnedMcpToolNames,
      runStickyToolNames: ctx.runStickyToolNames,
      mcpLastUsedByName: ctx.mcpLastUsedByName,
      currentStep: ctx.currentStep,
      invalidateMcpToolCatalogCache: ctx.invalidateMcpToolCatalogCache,
      mcpNotInCatalogCounts: ctx.mcpNotInCatalogCounts,
      mutationPaths: ctx.mutationPaths,
      approval: ctx.approval,
      onTerminalOutput: ctx.emitLiveEvent
        ? (chunk) =>
            ctx.emitLiveEvent?.({
              type: 'terminal_output_delta',
              runId: ctx.runId,
              toolCallId: call.id,
              text: chunk.text,
              stream: chunk.stream
            })
        : undefined
    })

    const result = await (DEADLINE_EXEMPT_TOOLS.has(call.name)
      ? pending
      : raceToolDeadline(pending, call.name, () => deadlineController.abort()))
    let content = result.content
    if (result.ok && unreadPaths.length > 0) {
      content = `${content}\n\n[Soft warning: edited existing file(s) without a prior read/grep/glob/codebase_search inspect: ${unreadPaths.join(', ')}]`
    }
    if (result.ok && rereadNote) {
      content = `${content}\n\n${rereadNote}`
    }
    if (
      result.ok &&
      stepFlags?.softDiagnosticsNudge &&
      isFileMutationToolName(call.name)
    ) {
      content = `${content}\n\n${SOFT_WARN_MUTATION_WITHOUT_DIAGNOSTICS}`
    }
    if (ctx.knownPaths) {
      applyToolCallToKnownPaths(
        ctx.knownPaths,
        call.name,
        toolArgs,
        result.ok,
        result.ok ? result.content : undefined
      )
    }
    if (ctx.mutationPaths) {
      applyToolCallToMutationPaths(ctx.mutationPaths, call.name, toolArgs, result.ok)
    }
    recordRecentReads(
      ctx.recentReadPaths,
      ctx.readStampStep,
      call.name,
      toolArgs,
      result.ok,
      result.ok ? result.content : undefined
    )
    const resultSummary = result.summary || summary
    const toolMsg: ChatMessage = {
      role: 'tool',
      toolCallId: call.id,
      toolName: call.name,
      content,
      ok: result.ok
    }
    events.push({
      type: 'tool_result',
      runId: ctx.runId,
      toolCallId: call.id,
      name: call.name,
      summary: resultSummary,
      ok: result.ok,
      content
    })
    if (!result.ok && !result.failureLogged) {
      // The args summary (e.g. "2 tasks") is not a failure reason. The real
      // error text lives in content — log its first line, bounded, so logs
      // and chips are actionable without dumping full tool output.
      const firstLine = result.content.split('\n', 1)[0]!.trim()
      const failureReason = (firstLine || result.summary).slice(0, 300)
      logger.warn('Tool returned failure', {
        scope: 'agent',
        code: 'TOOL_EXEC',
        correlationId: ctx.runId,
        tool: call.name,
        reason: failureReason === 'error' ? undefined : failureReason
      })
    }
    return {
      ok: result.ok,
      events,
      message: toolMsg
    }
  } catch (err) {
    if (isAbortError(err)) {
      const content = abortToolContent(ctx)
      const summary = abortToolSummary(ctx)
      const toolMsg: ChatMessage = {
        role: 'tool',
        toolCallId: call.id,
        toolName: call.name,
        content,
        ok: false
      }
      events.push({
        type: 'tool_result',
        runId: ctx.runId,
        toolCallId: call.id,
        name: call.name,
        summary,
        ok: false,
        content
      })
      return { ok: false, events, message: toolMsg }
    }
    throw err
  }
}

/** Write the settled result to disk once the repeat-failure hint has been applied. */
function persistToolResult(ctx: ToolStepContext, outcome: ToolOutcome): void {
  for (const ev of outcome.events) {
    if (ev.type === 'tool_result') ctx.appendEvent(toolResultEventForPersistence(ev))
  }
}

function abortedToolResult(
  call: ToolCall,
  ctx: ToolStepContext,
  options?: { emitStart?: boolean }
): ToolOutcome {
  const content = abortToolContent(ctx)
  const summary = abortToolSummary(ctx)
  const toolMsg: ChatMessage = {
    role: 'tool',
    toolCallId: call.id,
    toolName: call.name,
    content,
    ok: false
  }
  const startEv: AgentEvent = {
    type: 'tool_start',
    runId: ctx.runId,
    toolCallId: call.id,
    name: call.name,
    summary: summarizeToolArgs(call.name, call.arguments)
  }
  const ev: AgentEvent = {
    type: 'tool_result',
    runId: ctx.runId,
    toolCallId: call.id,
    name: call.name,
    summary,
    ok: false,
    content
  }
  const emitStart = options?.emitStart !== false
  if (emitStart) {
    emitToolStart(ctx, startEv)
    return { ok: false, events: [startEv, ev], message: toolMsg }
  }
  return { ok: false, events: [ev], message: toolMsg }
}

async function runParallelBatch(
  calls: ToolCall[],
  ctx: ToolStepContext,
  parallelLimit: number,
  stepFlags?: { softDiagnosticsNudge?: boolean },
  onSettled?: (call: ToolCall, outcome: ToolOutcome) => void
): Promise<Map<string, ToolOutcome>> {
  const results = new Map<string, ToolOutcome>()
  const startedIds = new Set<string>()
  let index = 0
  let firstError: unknown
  const workers = Array.from({ length: Math.min(parallelLimit, calls.length) }, async () => {
    // A thrown tool must stop its siblings: the step is already failing, and
    // letting detached workers run on would persist results into a dead step.
    while (index < calls.length && firstError === undefined) {
      if (ctx.signal.aborted) break
      const i = index++
      const call = calls[i]
      if (!call) break
      startedIds.add(call.id)
      try {
        const result = await runSingleTool(call, ctx, stepFlags)
        results.set(call.id, result)
        onSettled?.(call, result)
      } catch (err) {
        if (firstError === undefined) firstError = err
        return
      }
    }
  })
  await Promise.all(workers)
  if (firstError !== undefined) throw firstError
  // After abort, keep settled outcomes; only synthesize abort results for tools
  // that never produced a ToolOutcome. Never re-emit tool_start for started ids.
  if (ctx.signal.aborted) {
    for (const call of calls) {
      const existing = results.get(call.id)
      if (existing) continue
      results.set(
        call.id,
        abortedToolResult(call, ctx, { emitStart: !startedIds.has(call.id) })
      )
    }
  }
  return results
}

function chunkSizeForClass(cls: StepToolBatchClass, batchLength: number): number {
  const cap = parallelLimitForBatchClass(cls)
  if (!Number.isFinite(cap)) return batchLength
  return Math.min(Math.max(cap, 1), batchLength)
}

/**
 * Consecutive same-class groups only — never reorder a step.
 * Same-path `edit`/`str_replace` flush before sharing a mutation group.
 */
export function groupStepToolCalls(calls: ToolCall[]): ToolCall[][] {
  const groups: ToolCall[][] = []
  const batch: ToolCall[] = []
  let batchClass: StepToolBatchClass | null = null
  const batchPaths = new Set<string>()

  const flushBatch = (): void => {
    if (batch.length === 0) {
      batchClass = null
      batchPaths.clear()
      return
    }
    const size = batchClass == null ? batch.length : chunkSizeForClass(batchClass, batch.length)
    while (batch.length > 0) {
      groups.push(batch.splice(0, Math.min(size, batch.length)))
    }
    batchClass = null
    batchPaths.clear()
  }

  for (const call of calls) {
    const cls = stepToolBatchClass(call.name, toolArgsFromCall(call.arguments))
    if (cls === 'serial') {
      flushBatch()
      groups.push([call])
      continue
    }

    if (cls === 'mutation') {
      const path = parallelMutationPathKey(toolArgsFromCall(call.arguments), call.name)
      if (path == null) {
        flushBatch()
        groups.push([call])
        continue
      }
      if (batchClass !== 'mutation') {
        flushBatch()
        batchClass = 'mutation'
      } else if (batchPaths.has(path)) {
        flushBatch()
        batchClass = 'mutation'
      }
      batch.push(call)
      batchPaths.add(path)
      continue
    }

    if (batchClass !== cls) {
      flushBatch()
      batchClass = cls
    }
    batch.push(call)
    const cap = parallelLimitForBatchClass(cls)
    if (Number.isFinite(cap) && batch.length >= cap) flushBatch()
  }
  flushBatch()
  return groups
}

/** Agent: run todo_write first so this step's list is recorded before mutations. */
function hoistTodoWriteCalls(calls: ToolCall[]): ToolCall[] {
  const todoWrites: ToolCall[] = []
  const rest: ToolCall[] = []
  for (const call of calls) {
    if (call.name === 'todo_write') todoWrites.push(call)
    else rest.push(call)
  }
  if (todoWrites.length === 0) return calls
  return [...todoWrites, ...rest]
}

/** Execute tool calls with classed parallelism; persist results in call order. */
export async function executeStepToolCalls(
  rawCalls: ToolCall[],
  ctx: ToolStepContext
): Promise<{ messages: ChatMessage[]; events: AgentEvent[]; stepToolsOk: boolean }> {
  const calls = ensureToolCallIds(
    rawCalls.map((call) => {
      const name = canonicalizeAgentToolName(call.name)
      return name === call.name ? call : { ...call, name }
    }),
    { prefix: 'call_exec' }
  )
  const agentMode = ctx.getAgentMode?.() ?? ctx.agentMode ?? 'agent'
  const orderedCalls = agentMode === 'agent' ? hoistTodoWriteCalls(calls) : calls
  const messages: ChatMessage[] = []
  const events: AgentEvent[] = []
  let stepToolsOk = true
  const hasDiagnosticsSurface =
    Boolean(ctx.diagnosticsCommand?.trim()) ||
    hasJavaScriptProject(ctx.workspace) ||
    hasTypeScriptProject(ctx.workspace)
  const softDiagnosticsNudge =
    hasDiagnosticsSurface &&
    calls.some((c) => isFileMutationToolName(c.name)) &&
    !calls.some((c) => c.name === 'diagnostics')
  const stepFlags = softDiagnosticsNudge ? { softDiagnosticsNudge } : undefined

  // Approval authorize() is awaited per call; consecutive same-class groups may still batch.
  const groups = groupStepToolCalls(orderedCalls)

  /** Stream the result to the UI as soon as it settles, ahead of ordered persistence. */
  const emitLive = (outcome: ToolOutcome): void => {
    for (const ev of outcome.events) emitToolResult(ctx, ev)
  }

  const collect = async (outcome: ToolOutcome, alreadyEmitted = false): Promise<void> => {
    // Live tool_result before persist so UI updates without waiting on disk.
    if (!alreadyEmitted) emitLive(outcome)
    await ctx.appendMessage(outcome.message)
    persistToolResult(ctx, outcome)
    messages.push(outcome.message)
    events.push(...outcome.events)
    if (!outcome.ok) stepToolsOk = false
  }

  for (const group of groups) {
    if (ctx.signal.aborted) {
      for (const call of group) await collect(abortedToolResult(call, ctx))
      continue
    }

    const head = group[0]
    const batchClass = head ? stepToolBatchClass(head.name, toolArgsFromCall(head.arguments)) : 'serial'
    const parallel = group.length > 1 && isParallelBatchClass(batchClass)
    if (parallel) {
      const liveEmitted = new Set<string>()
      const cap = parallelLimitForBatchClass(batchClass)
      const parallelLimit = Number.isFinite(cap) ? cap : group.length
      const batch = await runParallelBatch(group, ctx, parallelLimit, stepFlags, (call, outcome) => {
        liveEmitted.add(call.id)
        emitLive(outcome)
      })
      // Persist and report in call order — settle order is not reproducible.
      for (const call of group) {
        const outcome = batch.get(call.id) ?? abortedToolResult(call, ctx)
        await collect(outcome, liveEmitted.has(call.id))
      }
      await yieldToEventLoop()
    } else {
      for (const call of group) {
        if (ctx.signal.aborted) {
          await collect(abortedToolResult(call, ctx))
          continue
        }
        await collect(await runSingleTool(call, ctx, stepFlags))
        await yieldToEventLoop()
      }
    }
  }

  return { messages, events, stepToolsOk }
}
