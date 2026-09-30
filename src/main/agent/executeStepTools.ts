import type { AgentEvent, AgentInteractionMode, ChatMessage, Settings } from '../../shared/ipc'
import { toolContentWithImages } from '../../shared/ipc'
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
import { createWorkspacePathResolver } from '../workspace/safePath'
import {
  applyToolCallToKnownPaths,
  applyToolCallToMutationPaths,
  deletePathFromToolCall,
  editPathsFromToolCall,
  isFileMutationToolName,
  isInspectToolName,
  isRunArtifactEditPath,
  readPathFromToolCall,
  toolArgsFromCall,
  unreadExistingEditPaths
} from './loopPolicy'
import { formatAttachedInstructions, type NestedInstructions } from './context/nestedInstructions'
import type { RunHooks } from './hooks'
import { isConcreteWorkspacePath, normalizeWorkspaceRelPath } from './pathPlausibility'
import { searchHitPathsFromResult } from './tools/search'
import { codebaseSearchHitPathsFromResult } from './codeindex/query'
import { readPathArg } from './tools/argAccess'
import { hasJavaScriptProject, hasTypeScriptProject } from './tools/diagnostics'
import { ensureToolCallIds } from './dedupeToolCalls'
import { parseTerminalOutput } from '../../shared/utils/terminalFormat'
import { yieldToEventLoop } from './tools/walk'
import type { VerificationTracker } from './feedback/verification'
import { getWriteCheckpoint } from './checkpoints'
export const SOFT_WARN_MUTATION_WITHOUT_DIAGNOSTICS =
  '[Soft warning: this step mutated file(s) without calling diagnostics. Run diagnostics (typecheck/lint) before treating the change as done.]'

/** The path an edit-family call writes (`edit_notebook` names it `target_notebook`). */
function editTargetPath(name: string, args: Record<string, unknown>): string | undefined {
  if (name === 'edit_notebook' && typeof args.target_notebook === 'string') return args.target_notebook
  return readPathArg(args)
}

/**
 * An edit-family call that writes workspace code. `plan.md` / `contract.md`
 * are remapped into the run directory, so editing them changes no code and
 * neither needs a check nor makes one stale.
 */
function isWorkspaceCodeEdit(call: ToolCall): boolean {
  if (!isFileMutationToolName(call.name)) return false
  return !isRunArtifactEditPath(editTargetPath(call.name, toolArgsFromCall(call.arguments)))
}

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
function recentRereadNote(
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
  /** `at`: when it happened, if not now (a parallel result persisted after its batch). */
  appendEvent: (ev: AgentEvent, at?: string) => void
  /** Session-scoped paths already inspected or edited (read-before-edit soft warn). */
  knownPaths?: Set<string>
  /** Sub-folder instruction files and path rules, attached on first work under them. */
  nestedInstructions?: NestedInstructions
  /** The person's hooks, and the workspace's once allowed (hooks.ts). */
  hooks?: RunHooks
  /** Run-scoped paths the agent actually changed (scopes git_commit staging). */
  mutationPaths?: Set<string>
  /** Present when tool approval is on, or MCP tools protection is on. */
  approval?: ToolApprovalGate
  /** ChatStart invoke that owns this step; scopes interactive cancel. */
  invokeId?: number
  /** Ask / Agent for this invoke (mutable via switch_mode). */
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
  /** Whole MCP servers loaded this run via request_mcp_tools. */
  runAttachedMcpServerIds?: Set<string>
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
  /** Invoke-scoped mutation/check tracker feeding the turn-end verification gate. */
  verification?: VerificationTracker
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
 *
 * await_agent_instance waits on a child run for the same reason, and carries its
 * own bounded `timeout_ms` (AWAIT_AGENT_INSTANCE_MAX_MS). The generic deadline
 * always pre-empted it — measured 18 of 21 awaits failing at a median 600031ms,
 * exactly this deadline, burning ~3h — and reported "the tool is stuck" for a
 * child that was running normally, while the child itself kept going. Its own
 * timeout returns the truthful message (child still running; cancel, re-await,
 * or pull), so let that be the bound.
 */
const DEADLINE_EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  'ask_question',
  'await_agent_instance'
])

/** A tool whose own bound governs it; the generic soft deadline does not apply. */
export function isDeadlineExemptTool(name: string): boolean {
  return DEADLINE_EXEMPT_TOOLS.has(name)
}

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

/**
 * Does this workspace have any diagnostics surface worth nudging about?
 *
 * `hasJavaScriptProject` / `hasTypeScriptProject` stat and read the workspace
 * (a directory read for the tsconfig scan) and the verdict cannot change over
 * the life of a run, so probing it on every step was a per-step sync fs cost
 * on the main thread for a constant. Memoised per workspace: one probe per
 * workspace per process, then a map read. Only soft-warn text depends on it,
 * never control flow.
 */
const diagnosticsSurfaceByWorkspace = new Map<string, boolean>()

function workspaceHasDiagnosticsSurface(workspace: string): boolean {
  const cached = diagnosticsSurfaceByWorkspace.get(workspace)
  if (cached !== undefined) return cached
  const hasSurface = hasJavaScriptProject(workspace) || hasTypeScriptProject(workspace)
  diagnosticsSurfaceByWorkspace.set(workspace, hasSurface)
  return hasSurface
}

/** Per-step path resolver: async containment + symlink checks, directory memoised. */
type StepPathResolver = ReturnType<typeof createWorkspacePathResolver>

/** Per-step flags handed to every tool call in the step. */
type StepFlags = {
  softDiagnosticsNudge?: boolean
  /** Present when this step tracks known paths (read-before-edit probe). */
  resolvePaths?: StepPathResolver
}

/**
 * Read-before-edit probe for one call. `unreadExistingEditPaths` still owns the
 * rule (write tools only, minus paths already inspected); existence is resolved
 * through the async workspace resolver and handed back as a settled map, so the
 * predicate it runs is a lookup instead of a blocking `existsSync` on the main
 * thread (performance.mdc: never block main). Same result as the sync probe.
 */
async function unreadExistingEditPathsForStep(
  known: ReadonlySet<string>,
  name: string,
  toolArgs: Record<string, unknown>,
  resolve: StepPathResolver
): Promise<string[]> {
  const candidates = editPathsFromToolCall(name, toolArgs).filter((path) => !known.has(path))
  if (candidates.length === 0) return []
  const resolved = await Promise.all(candidates.map((path) => resolve(path)))
  const exists = new Map<string, boolean>()
  candidates.forEach((path, i) => {
    // null = escapes the workspace or is unreadable → same answer the sync
    // probe gave, which caught the resolve throw and answered false.
    exists.set(path, resolved[i]?.exists === true)
  })
  return unreadExistingEditPaths(known, name, toolArgs, (rel) => exists.get(rel) === true)
}

async function runSingleTool(
  call: ToolCall,
  ctx: ToolStepContext,
  stepFlags?: StepFlags
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
    // Ask before doing anything. The request goes to the renderer directly and
    // can overtake this tool_start, which waits in the loop's live queue; the
    // card still lands in the call's row, which the step's assistant_message
    // (sent before any call ran) already made, and keeps its own request time.
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
    if (ctx.hooks) {
      const blocked = await ctx.hooks.preToolUse(call.name, toolArgs, ctx.signal)
      if (blocked) {
        const reason = `Blocked by a PreToolUse hook: ${blocked}`
        events.push({
          type: 'tool_result',
          runId: ctx.runId,
          toolCallId: call.id,
          name: call.name,
          summary: summarizeToolArgs(call.name, call.arguments) || call.name,
          ok: false,
          content: reason
        })
        return {
          ok: false,
          events,
          message: { role: 'tool', toolCallId: call.id, toolName: call.name, content: reason, ok: false }
        }
      }
    }
    const rereadNote = recentRereadNote(
      ctx.recentReadPaths,
      ctx.readStampStep,
      call.name,
      toolArgs
    )
    const unreadPaths =
      ctx.knownPaths != null
        ? await unreadExistingEditPathsForStep(
            ctx.knownPaths,
            call.name,
            toolArgs,
            stepFlags?.resolvePaths ?? createWorkspacePathResolver(ctx.workspace)
          )
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
      runAttachedMcpServerIds: ctx.runAttachedMcpServerIds,
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
      isWorkspaceCodeEdit(call)
    ) {
      content = `${content}\n\n${SOFT_WARN_MUTATION_WITHOUT_DIAGNOSTICS}`
    }
    if (result.ok && ctx.nestedInstructions) {
      const read = readPathFromToolCall(call.name, toolArgs)
      const touched = [...(read ? [read] : []), ...editPathsFromToolCall(call.name, toolArgs)]
      if (touched.length > 0) {
        try {
          const attached = await ctx.nestedInstructions.forPaths(touched)
          if (attached.length > 0) content = `${content}\n\n${formatAttachedInstructions(attached)}`
        } catch {
          // An unreadable instruction file never fails the tool call it rides on.
        }
      }
    }
    if (ctx.hooks) {
      const note = await ctx.hooks.postToolUse(call.name, toolArgs, { ok: result.ok, content: result.content }, ctx.signal)
      if (note) content = `${content}\n\n[PostToolUse hook]\n${note}`
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
    if (ctx.verification) {
      // `content`, not `result.content`: this is the text that gets persisted,
      // so the live verdict reads exactly what the receipt will re-read later.
      const editPath = editTargetPath(call.name, toolArgs)
      if (isFileMutationToolName(call.name) && !isRunArtifactEditPath(editPath)) {
        ctx.verification.noteMutation(editPath, result.ok)
      }
      // Writes this call made through anything but an edit tool — a terminal
      // command, an MCP writer, an lsp rename, a merge, git_apply — noted here,
      // in call order, so one that follows a check makes it stale.
      const cp = getWriteCheckpoint(ctx.runDir)
      ctx.verification.noteOtherWriteCount(cp?.otherWriteCount, cp?.id)
      ctx.verification.noteToolResult(
        call.name,
        content,
        result.ok,
        typeof toolArgs.command === 'string' ? toolArgs.command : undefined
      )
    }
    const resultSummary = result.summary || summary
    const images = result.images?.length ? result.images : undefined
    const toolMsg: ChatMessage = {
      role: 'tool',
      toolCallId: call.id,
      toolName: call.name,
      // Images ride as run-dir references; main hydrates them just before send.
      content: toolContentWithImages(content, images),
      ok: result.ok
    }
    events.push({
      type: 'tool_result',
      runId: ctx.runId,
      toolCallId: call.id,
      name: call.name,
      summary: resultSummary,
      ok: result.ok,
      content,
      ...(images ? { images } : {})
    })
    if (!result.ok && !result.failureLogged) {
      // The args summary (e.g. "2 tasks") is not a failure reason. The real
      // error text lives in content — log its first line, bounded, so logs
      // and chips are actionable without dumping full tool output.
      const firstLine = result.content.split('\n', 1)[0]!.trim()
      const failureReason = (
        toolFailureReasonForLog(call.name, result.content) ||
        firstLine ||
        result.summary
      ).slice(0, 300)
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
function persistToolResult(ctx: ToolStepContext, outcome: ToolOutcome, settledAt?: string): void {
  for (const ev of outcome.events) {
    if (ev.type === 'tool_result') ctx.appendEvent(toolResultEventForPersistence(ev), settledAt)
  }
}

/**
 * A log-safe failure reason for a handler-returned failure.
 *
 * A terminal frame opens with a unique `session_id:` and carries its verdict on
 * the last line, so the generic first-line rule logged a bare UUID for every
 * terminal failure — twice in run 874dad8f, and terminal is the run's
 * most-failed tool. Report the exit code and session status instead, and never
 * the command: that is a tool argument, which the logging policy keeps off disk.
 *
 * Returns '' when the generic first line is already the better reason.
 */
function toolFailureReasonForLog(toolName: string, content: string): string {
  if (toolName !== 'terminal') return ''
  const parsed = parseTerminalOutput(content)
  const parts = [
    parsed.exitCode != null ? `exit ${parsed.exitCode}` : null,
    parsed.sessionStatus ? `status ${parsed.sessionStatus}` : null
  ].filter((part): part is string => Boolean(part))
  return parts.join(' · ')
}

/**
 * Result for a call that came after ask_question in the same step. It was
 * written before the user answered, so running it could act against the answer
 * (`[ask_question("Delete X?"), delete X]` deleting after a "No").
 */
export const HELD_FOR_ANSWER_CONTENT =
  'Not run: this call came after ask_question in the same step, so it was written before the user answered. Re-issue it next step if the answer still calls for it.'

function heldForAnswerResult(call: ToolCall, ctx: ToolStepContext): ToolOutcome {
  return abortedToolResult(call, ctx, {
    content: HELD_FOR_ANSWER_CONTENT,
    summary: 'not run'
  })
}

function abortedToolResult(
  call: ToolCall,
  ctx: ToolStepContext,
  options?: { emitStart?: boolean; content?: string; summary?: string }
): ToolOutcome {
  const content = options?.content ?? abortToolContent(ctx)
  const summary = options?.summary ?? abortToolSummary(ctx)
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

/**
 * Settled outcomes for a parallel batch plus the first tool that threw, if any.
 *
 * The error travels back as a value instead of being thrown from here: the
 * siblings that already finished wrote to disk, and throwing first would drop
 * their results on the floor. The caller persists everything that settled and
 * only then rethrows, so a failing step still ends exactly as it did before.
 */
type ParallelBatchResult = {
  results: Map<string, ToolOutcome>
  error?: unknown
}

async function runParallelBatch(
  calls: ToolCall[],
  ctx: ToolStepContext,
  parallelLimit: number,
  stepFlags?: StepFlags,
  onSettled?: (call: ToolCall, outcome: ToolOutcome) => void
): Promise<ParallelBatchResult> {
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
  if (firstError !== undefined) return { results, error: firstError }
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
  return { results }
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
): Promise<{ messages: ChatMessage[]; events: AgentEvent[] }> {
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
  const hasDiagnosticsSurface =
    Boolean(ctx.diagnosticsCommand?.trim()) ||
    workspaceHasDiagnosticsSurface(ctx.workspace)
  const softDiagnosticsNudge =
    hasDiagnosticsSurface &&
    calls.some(isWorkspaceCodeEdit) &&
    !calls.some((c) => c.name === 'diagnostics')
  // One path resolver for the whole step: the read-before-edit probe repeats
  // per call, and the resolver memoises each directory it walks.
  const stepFlags: StepFlags | undefined =
    softDiagnosticsNudge || ctx.knownPaths != null
      ? {
          ...(softDiagnosticsNudge ? { softDiagnosticsNudge } : {}),
          ...(ctx.knownPaths != null
            ? { resolvePaths: createWorkspacePathResolver(ctx.workspace) }
            : {})
        }
      : undefined

  // Approval authorize() is awaited per call; consecutive same-class groups may still batch.
  const groups = groupStepToolCalls(orderedCalls)

  /** Stream the result to the UI as soon as it settles, ahead of ordered persistence. */
  const emitLive = (outcome: ToolOutcome): void => {
    for (const ev of outcome.events) emitToolResult(ctx, ev)
  }

  /**
   * @param settledAt When the call finished. Parallel results are written in
   *   call order after the whole batch settles; each keeps its own moment, or
   *   a fast call beside a slow one would read as taking as long.
   */
  const collect = async (
    outcome: ToolOutcome,
    alreadyEmitted = false,
    settledAt = new Date().toISOString()
  ): Promise<void> => {
    // Live tool_result before persist so UI updates without waiting on disk.
    if (!alreadyEmitted) emitLive(outcome)
    const message = outcome.message.at ? outcome.message : { ...outcome.message, at: settledAt }
    await ctx.appendMessage(message)
    persistToolResult(ctx, outcome, settledAt)
    messages.push(message)
    events.push(...outcome.events)
  }

  // Set once an ask_question call settles: nothing after it in this step runs.
  let heldForAnswer = false

  for (const group of groups) {
    if (ctx.signal.aborted) {
      for (const call of group) await collect(abortedToolResult(call, ctx))
      continue
    }
    if (heldForAnswer) {
      for (const call of group) await collect(heldForAnswerResult(call, ctx))
      continue
    }

    const head = group[0]
    const batchClass = head ? stepToolBatchClass(head.name, toolArgsFromCall(head.arguments)) : 'serial'
    const parallel = group.length > 1 && isParallelBatchClass(batchClass)
    if (parallel) {
      const liveEmitted = new Set<string>()
      const settledAt = new Map<string, string>()
      const cap = parallelLimitForBatchClass(batchClass)
      const parallelLimit = Number.isFinite(cap) ? cap : group.length
      const batch = await runParallelBatch(group, ctx, parallelLimit, stepFlags, (call, outcome) => {
        liveEmitted.add(call.id)
        settledAt.set(call.id, new Date().toISOString())
        emitLive(outcome)
      })
      // Persist and report in call order — settle order is not reproducible —
      // each with the moment it settled.
      for (const call of group) {
        const settled = batch.results.get(call.id)
        // On the error path a call that never settled has no result and no
        // abort reason of its own, so it stays absent, exactly as before;
        // every sibling that did settle is written first, so a sibling's work
        // is recorded even though this batch is about to fail.
        if (!settled && batch.error !== undefined) continue
        const outcome = settled ?? abortedToolResult(call, ctx)
        await collect(outcome, liveEmitted.has(call.id), settledAt.get(call.id))
      }
      if (batch.error !== undefined) throw batch.error
      await yieldToEventLoop()
    } else {
      for (const call of group) {
        if (ctx.signal.aborted) {
          await collect(abortedToolResult(call, ctx))
          continue
        }
        if (heldForAnswer) {
          await collect(heldForAnswerResult(call, ctx))
          continue
        }
        await collect(await runSingleTool(call, ctx, stepFlags))
        if (call.name === 'ask_question') heldForAnswer = true
        await yieldToEventLoop()
      }
    }
  }

  return { messages, events }
}
