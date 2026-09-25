import { logger, logErrorSummary } from '../../../shared/logger'
import { formatError, formatToolResultError, isAbortError, isExpectedToolError } from '../../../shared/errors'
import { duplicateTopLevelJsonKeyError } from '../../../shared/utils/jsonish'
import { summarizeToolArgsFromRecord } from '../../../shared/toolSummary'
import { isTerminalSessionInProgress } from '../../../shared/utils/terminalFormat'
import {
  canonicalizeAgentToolName,
  formatMalformedToolArgsError,
  formatUnknownToolError,
  validateParsedToolArgs,
  type AgentToolName
} from '../schemas/tools'
import { invokeMcpTool, parseMcpToolName, getMcpToolDefinition } from '../mcp'
import { isMcpToolPermitted } from '../../../shared/utils/mcpToolPolicy'
import { toolRead } from './read'
import { toolEditAsync } from './edit'
import { readPathArg, readEditBody, requirePathArg, readString, readTrimmed } from './argAccess'
import { toolSearch } from './search'
import { toolGlob } from './glob'
import { toolGrep } from './grep'
import { toolCodebaseSearch, CODEBASE_SEARCH_DEFAULT_LIMIT } from './codebaseSearch'
import { toolConceptSearch, CONCEPT_SEARCH_DEFAULT_LIMIT } from './conceptSearch'
import { scheduleWorkspaceIndexSync } from '../workspaceIndex'
import { isSkillRelatedRelPath } from '../skills/local'
import { isRuleRelatedRelPath, clearRulesCache } from '../context/rules'
import { notifySkillsChanged } from '../skills/notify'
import { toolListDir } from './listDir'
import { toolStrReplaceAsync } from './strReplace'
import { executeCheckDoneWhen } from '../doneWhenChecks'
import { toolDeleteAsync } from './deletePath'
import {
  assertInlineInstancePathScope,
  assertNotRetiredAgentDataPath,
  assertInlineInstancePushDenied,
  assertInlineInstanceTerminalAllowed,
  assertInlineInstanceUnscopedToolAllowed
} from './writeGuard'
import { toolTodoWrite, type TodoItem } from './todo'
import { proposeGoal, updateGoalStatus, goalToolContent } from '../runGoal'
import { emitGoalUpdate } from '../goalEvents'
import { truncateGoalObjective } from '../../../shared/goalRuntime'
import { executeCreatePlan } from './createPlan'
import {
  isFindstrNoMatchContent,
  isDirMissingPathContent,
  isCommandProbeNoTargetContent,
  isRemoteGrepNoMatchContent,
  isElevationDeniedContent,
  isProcessKillSweepContent
} from './terminal'
import { toolMemoryList, toolMemoryRead, toolMemoryWrite } from './memory'
import { toolSkill, summarizeSkillArgs } from './skill'
import { toolDiagnosticsAsync } from './diagnostics'
import { toolRunTestsAsync } from './runTests'
import { toolEditNotebookAsync, type EditNotebookArgs } from './editNotebook'
import { toolLsp, applyLspRenameEdits } from './lsp'
import { getSettings } from '@main/settings/settings'
import { getWriteCheckpoint } from '../checkpoints'
import { applyMcpFilesystemMutations, recordMcpFilesystemPriors } from './mcpCheckpoint'
import { noteInlineInstanceDeniedTool } from '../agentInstances'
import { withWorkspaceMutation } from '@main/workspace/mutationQueue'
import { clearWorkspaceSnapshotCache } from '../context/workspaceSnapshot'
import { invalidateGitStatusCache } from '@main/git/gitStatusCache'
import { invalidateSlashCommandsCache } from '../slashCommands/listCache'
import { clearGitignoreMatcherCache, isGitignoreRelPath } from './gitignore'
import { browserHandlers } from './browserTools'
import { mcpHandlers } from './mcpTools'
import { terminalHandlers } from './terminalHandlers'
import { gitGithubHandlers } from './gitGithubTools'
import { instanceHandlers } from './instanceTools'
import { handler as buildToolHandler } from './buildTool'
import { resolveAgentToolsDir } from '../agentTools/paths'
import { loadAgentToolsSnapshot } from '../agentTools/loader'
import { BUILTIN_TOOL_NAMES as BUILTIN_TOOL_NAMES_FOR_SCAN } from '../schemas/tools'
import { runAgentTool } from '../agentTools/runner'
import type { AgentToolDef } from '../agentTools/types'
import type { ToolApprovalGate } from '../toolApproval'
import {
  MCP_NOT_IN_CATALOG_FAIL_FAST_THRESHOLD,
  mcpNotInCatalogErrorMessage,
  mcpNotInCatalogFailFastMessage,
  recordMcpNotInCatalogFailure
} from '../loopPolicy'
import { toolCallArgumentsUnusable, wireToolCallArguments } from '../toolArgWire'
import { parseJsonish } from '../../../shared/utils/jsonish'
import {
  assertToolAllowedInMode,
  isRunContractPath,
  isRunPlanPath
} from './modePolicy'
import type {
  AgentEvent,
  AgentInteractionMode,
  AgentQuestionAnswer,
  AgentQuestionRequest,
  RunGoal,
  Settings,
  TerminalShell
} from '../../../shared/ipc'
import { basename, join } from 'path'
import { existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { askQuestionThroughRenderer } from '../agentQuestion'
import {
  ASK_QUESTION_AUTONOMOUS_SKIP_GUIDANCE,
  ASK_QUESTION_NO_ANSWER_GUIDANCE,
  askQuestionSummary,
  formatQuestionAnswers,
  normalizeAskQuestionArgs
} from '../../../shared/utils/agentQuestionForm'

export interface ToolResult {
  ok: boolean
  summary: string
  content: string
  /** True when tools layer already logged this failure (avoid duplicate agent warn). */
  failureLogged?: boolean
}

/** Run-scoped state a handler may need beyond the workspace path. */
export type ToolExecutionContext = {
  /** Directory of the run that issued the call; absent outside a run. */
  runDir?: string
  /**
   * Session/storage workspace (parent tree). When a worktree remaps the tool
   * cwd, only memory_* tools still bind here so SQLite survives worktree
   * removal. Live file tools (read, grep, glob, search, codebase_search, edits)
   * stay on the worktree.
   */
  sessionWorkspace?: string
  /** True when this invoke is a depth-1 inline instance (avoids extra status.json reads). */
  inlineInstance?: boolean
  /** Run that owns this call; required for ask_question. */
  runId?: string
  /** Provider tool-call id; required for ask_question. */
  toolCallId?: string
  /** ChatStart invoke that owns this call; scopes cancel on abort. */
  invokeId?: number
  /**
   * Hard run-cancel signal only (not soft stream / follow-up interrupt).
   */
  runSignal?: AbortSignal
  /** Ask / Agent mode for this invoke (prefer getAgentMode when mutable). */
  agentMode?: AgentInteractionMode
  getAgentMode?: () => AgentInteractionMode
  setAgentMode?: (mode: AgentInteractionMode) => void | Promise<void>
  /** autoModeSwitch at last step boundary (refreshed each loop step from Settings). */
  autoModeSwitch?: boolean
  /** Snapshot of settings.terminalShell for this invoke (not live mid-run). */
  terminalShell?: TerminalShell
  /** Snapshot of settings.diagnosticsCommand for this invoke (not live mid-run). */
  diagnosticsCommand?: string
  /** Paths already inspected or edited this run (read-before-edit soft warn). */
  knownPaths?: ReadonlySet<string>
  /**
   * Invoke-snapshotted settings for tools that must not read live Settings mid-run.
   */
  invokeSettings?: Settings
  /** Emit live agent events (e.g. mode_changed) while a tool is running. */
  emitAgentEvent?: (event: AgentEvent) => void
  /** Overridable in tests; defaults to renderer IPC round trip. */
  askQuestion?: (
    request: AgentQuestionRequest,
    signal: AbortSignal
  ) => Promise<AgentQuestionAnswer[]>
  /** Skip write-checkpoint priors (Plan run artifacts are not workspace writes). */
  skipWriteCheckpoint?: boolean
  /** Incremental terminal stdout/stderr for live UI streaming. */
  onTerminalOutput?: (chunk: { text: string; stream: 'stdout' | 'stderr' }) => void
  /**
   * MCP servers enabled for this run (workspace overrides applied).
   * When set, MCP invokes outside this set are rejected even if globally connected.
   */
  runEnabledMcpIds?: ReadonlySet<string>
  /** Per-server allow/deny policy for bare MCP tool names. */
  mcpToolPolicies?: ReadonlyMap<string, { allowedTools?: string[]; deniedTools?: string[] }>
  /**
   * MCP tool full names offered to the model this step (post budget trim).
   * When set, MCP invokes outside this set are rejected.
   */
  stepMcpToolNames?: ReadonlySet<string>
  /**
   * Whole MCP servers this run loaded with request_mcp_tools. Their tools join
   * the catalog on the next refresh (not mid-stream).
   */
  runAttachedMcpServerIds?: Set<string>
  /**
   * Run-scoped MCP tools the agent pinned via request_mcp_tools.
   * Applied on the next refresh/trim (not mid-stream).
   */
  runPinnedMcpToolNames?: Set<string>
  /**
   * Sticky step-catalog names (prompt-cache continuity). Also used to admit
   * deferred optional builtins pinned via request_mcp_tools.
   */
  runStickyToolNames?: Set<string>
  /** Last step each MCP tool was pinned or invoked (pin tracking). */
  mcpLastUsedByName?: Map<string, number>
  /** Current agent step (for pin / invoke last-used stamps). */
  currentStep?: number
  /** Invalidate the loop MCP catalog cache after pinning. */
  invalidateMcpToolCatalogCache?: () => void
  /**
   * Run-scoped counts of MCP not-in-catalog rejections (per full tool name).
   * Used to fail-fast after repeated retries of the same omitted tool.
   */
  mcpNotInCatalogCounts?: Map<string, number>
  /** Paths the agent changed this run — scopes git_commit staging when present. */
  mutationPaths?: Set<string>
  /**
   * Parent tool-approval gate.
   */
  approval?: ToolApprovalGate
}

export type ToolHandler = (
  workspace: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  context: ToolExecutionContext
) => Promise<ToolResult> | ToolResult

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }
}

function logToolSuccess(name: string): void {
  logger.info('Tool succeeded', {
    scope: 'tools',
    tool: name
  })
}

export function toolOk(name: string, summary: string, content: string): ToolResult {
  logToolSuccess(name)
  return { ok: true, summary, content }
}

export function toolFail(
  name: string,
  summary: string,
  content: string,
  opts?: { failureLogged?: boolean }
): ToolResult {
  return { ok: false, summary, content, failureLogged: opts?.failureLogged }
}

function logToolFailure(name: string, err: unknown): void {
  const kind = toolFailureKind(err)
  // Expected failures are the model exploring or mis-aiming: their messages are
  // the model-facing remedy, which deliberately carries workspace content (the
  // path it asked for, the closest matching line, an expected-context preview).
  // An operator needs the class, not that prose — and the full text is already
  // in messages.jsonl — so drop the message and the `err` field entirely rather
  // than trusting the scrubber with file content. Unexpected failures are real
  // app faults and keep their summary and captured exception.
  // `past_end` is model mis-aim like the rest, but the EXPECTED_* regexes in
  // shared/utils/errors.ts are frozen this tranche — admit it by kind here.
  if (isExpectedToolError(formatError(err)) || kind === 'past_end') {
    logger.warn(`Tool failed as expected (${kind ?? 'unclassified'})`, {
      scope: 'tools',
      code: 'TOOL_EXEC',
      tool: name,
      ...(kind ? { kind } : {})
    })
    return
  }
  const summary = logErrorSummary(err, 'TOOL_EXEC')
  logger.error(
    kind ? `Tool execution failed: ${summary} (${kind})` : `Tool execution failed: ${summary}`,
    {
      scope: 'tools',
      code: 'TOOL_EXEC',
      tool: name,
      err,
      ...(kind ? { kind } : {})
    }
  )
}

/** Stable, path-free classifier for tool failures (safe for structured logs). */
function toolFailureKind(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined
  const message = err.message ?? ''
  if (/^File not found/i.test(message)) return 'not_found'
  if (/^Not a file/i.test(message)) return 'not_a_file'
  if (/Path is a directory/i.test(message)) return 'is_directory'
  if (/Binary file detected/i.test(message)) return 'binary'
  if (/File too large/i.test(message)) return 'too_large'
  if (/Path escapes workspace/i.test(message)) return 'path_escape'
  // A read window aimed past EOF (read.ts throws `startLine|offset N is past the end of …`).
  if (/^(?:startLine|offset) \d+ is past the end of /.test(message)) return 'past_end'
  if (/Failed to parse tool arguments/i.test(message)) return 'bad_args'
  // Edit-family aim misses. Classified so the expected-failure line still says
  // which way the edit missed once its message is dropped.
  if (/old_string not found/i.test(message)) return 'old_string_no_match'
  if (/old_string matched \d+ times/i.test(message)) return 'old_string_ambiguous'
  if (/str_replace left .+ unchanged/i.test(message)) return 'edit_no_change'
  if (/context\/removal mismatch/i.test(message)) return 'hunk_mismatch'
  if (/No unified-diff hunks found/i.test(message)) return 'no_hunks'
  if (err.name === 'AbortError') return 'aborted'
  const code = (err as Error & { code?: unknown }).code
  if (typeof code === 'string') return code
  return undefined
}

export function terminalResultOk(command: string, content: string): boolean {
  // Background session frames: in-progress statuses are a healthy session, not
  // a failure — the placeholder `exit_code: -1` would otherwise fail them.
  if (isTerminalSessionInProgress(/^status: (\w+)/m.exec(content)?.[1])) return true
  if (!content.includes('exit_code: ')) return true
  if (/exit_code: 0\b/.test(content)) return true
  // Informative non-zero exits (any shell): environment probes answered
  // "not installed" and elevation denials answer the question asked — they
  // are evidence, not tool faults (run 1de9344a).
  if (isCommandProbeNoTargetContent(command, content)) return true
  if (isRemoteGrepNoMatchContent(command, content)) return true
  if (isElevationDeniedContent(command, content)) return true
  // A kill sweep that confirmed its kills (taskkill exit 128 = a raced PID
  // already exited) answered the question asked — evidence, not a tool fault.
  if (isProcessKillSweepContent(command, content)) return true
  // Soft-success helpers are cmd-oriented only.
  const shellLine = /^shell:\s*(\S+)/m.exec(content)
  const shell = shellLine?.[1]
  if (shell && shell !== 'cmd') return false
  if (isFindstrNoMatchContent(command, content)) return true
  return isDirMissingPathContent(command, content)
}

export function resolveAgentMode(context: ToolExecutionContext): AgentInteractionMode {
  return context.getAgentMode?.() ?? context.agentMode ?? 'agent'
}

/** Memory tools bind to the session workspace SQLite; live file tools do not. */
export function usesSessionWorkspaceIndex(name: string): boolean {
  return name === 'memory_list' || name === 'memory_read' || name === 'memory_write'
}

/** Drop short-lived FS views that mutate with writes/git (git status, snapshot, gitignore). */
export function invalidateAfterWorkspaceMutation(
  workspace: string,
  mutatedRelPath?: string | string[]
): void {
  invalidateGitStatusCache(workspace)
  clearWorkspaceSnapshotCache(workspace)
  scheduleWorkspaceIndexSync(workspace)
  const paths =
    mutatedRelPath == null ? [] : Array.isArray(mutatedRelPath) ? mutatedRelPath : [mutatedRelPath]
  // Rebuilding every matcher costs the next walk of this repo ~150ms, so only
  // drop them when a `.gitignore` actually changed. Unknown mutations
  // (terminal/git) may have rewritten one, so those still flush.
  if (paths.length === 0 || paths.some(isGitignoreRelPath)) {
    clearGitignoreMatcherCache(workspace)
  }
  // Unknown mutations (terminal/git) may write SKILL.md; skill-related paths always refresh.
  if (
    paths.length === 0 ||
    paths.some((p) => isSkillRelatedRelPath(p) || isRuleRelatedRelPath(p))
  ) {
    if (paths.length === 0 || paths.some((p) => isRuleRelatedRelPath(p))) {
      clearRulesCache(workspace)
    }
    notifySkillsChanged(workspace)
  } else {
    invalidateSlashCommandsCache(workspace)
  }
}

export const BUILTIN_HANDLERS: Record<AgentToolName, ToolHandler> = {
  read: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const path = requirePathArg('read', args)
    const offset = typeof args.offset === 'number' ? args.offset : undefined
    const limit = typeof args.limit === 'number' ? args.limit : undefined
    const startLine = typeof args.startLine === 'number' ? args.startLine : undefined
    const endLine = typeof args.endLine === 'number' ? args.endLine : undefined
    const content = await toolRead(workspace, path, { offset, limit, startLine, endLine })
    throwIfAborted(signal)
    return toolOk('read', path, content)
  },
  edit: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const path = requirePathArg('edit', args)
    const { contents, diff } = readEditBody(args)
    const hasBody =
      typeof contents === 'string' ||
      (typeof diff === 'string' && diff.trim().length > 0)
    if (!hasBody) throw new Error('edit requires contents or diff')
    if (!context.skipWriteCheckpoint) {
      await getWriteCheckpoint(context.runDir)?.recordPrior(path, 'write')
    }
    const content = await toolEditAsync(workspace, path, contents, diff)
    invalidateAfterWorkspaceMutation(workspace, path)
    return toolOk('edit', path, content)
  },
  search: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const query = args.query as string
    const maxResults = typeof args.maxResults === 'number' ? args.maxResults : undefined
    const regex = args.regex === true
    const content = await toolSearch(workspace, query, maxResults, signal, regex)
    throwIfAborted(signal)
    return toolOk('search', query, content)
  },
  glob: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const pattern = args.pattern as string
    const maxResults = typeof args.maxResults === 'number' ? args.maxResults : undefined
    const content = await toolGlob(workspace, pattern, maxResults, signal)
    throwIfAborted(signal)
    return toolOk('glob', pattern, content)
  },
  codebase_search: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const query = args.query as string
    const content = await toolCodebaseSearch(workspace, query, {
      maxResults:
        typeof args.maxResults === 'number' ? args.maxResults : CODEBASE_SEARCH_DEFAULT_LIMIT,
      refresh: args.refresh === true,
      signal
    })
    throwIfAborted(signal)
    return toolOk('codebase_search', query, content)
  },
  concept_search: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const query = args.query as string
    const content = await toolConceptSearch(workspace, query, {
      maxResults:
        typeof args.maxResults === 'number' ? args.maxResults : CONCEPT_SEARCH_DEFAULT_LIMIT,
      signal
    })
    throwIfAborted(signal)
    return toolOk('concept_search', query, content)
  },
  grep: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const pattern = args.pattern as string
    const content = await toolGrep(
      workspace,
      pattern,
      {
        include: typeof args.include === 'string' ? args.include : undefined,
        caseSensitive: args.caseSensitive === true,
        contextLines: typeof args.contextLines === 'number' ? args.contextLines : undefined,
        maxResults: typeof args.maxResults === 'number' ? args.maxResults : undefined
      },
      signal
    )
    throwIfAborted(signal)
    return toolOk('grep', pattern, content)
  },
  list_dir: (workspace, args, signal) => {
    throwIfAborted(signal)
    const path = typeof args.path === 'string' && args.path.trim() ? args.path : '.'
    return toolOk('list_dir', path, toolListDir(workspace, path))
  },
  str_replace: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const path = requirePathArg('str_replace', args)
    if (!context.skipWriteCheckpoint) {
      await getWriteCheckpoint(context.runDir)?.recordPrior(path, 'write')
    }
    const content = await toolStrReplaceAsync(
      workspace,
      path,
      readString(args, 'old_string') ?? '',
      readString(args, 'new_string') ?? '',
      args.replace_all === true
    )
    invalidateAfterWorkspaceMutation(workspace, path)
    return toolOk('str_replace', path, content)
  },
  delete: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const path = requirePathArg('delete', args)
    const recursive = args.recursive === true
    if (!context.skipWriteCheckpoint) {
      await getWriteCheckpoint(context.runDir)?.recordPrior(path, 'delete', {
        recursiveDir: recursive
      })
    }
    const content = await toolDeleteAsync(workspace, path, recursive)
    invalidateAfterWorkspaceMutation(workspace, path)
    return toolOk('delete', path, content)
  },
  todo_write: (_workspace, args, signal, context) => {
    throwIfAborted(signal)
    const todos = args.todos as TodoItem[]
    const { content, todos: next, notice } = toolTodoWrite(
      context.runDir ?? '',
      todos,
      args.merge === true
    )
    const n = next.length
    const countLabel = n === 1 ? '1 task' : `${n} tasks`
    return toolOk('todo_write', notice ? `${countLabel}; ${notice}` : countLabel, content)
  },
  create_goal: (_workspace, args, signal, context) => {
    throwIfAborted(signal)
    if (context.inlineInstance) {
      return toolFail('create_goal', 'Root chat only', 'create_goal is only available on the root chat.')
    }
    const objective = typeof args.objective === 'string' ? args.objective : ''
    // Agent-created goals are proposals: inert until the user starts one from
    // the banner. `/goal` seeds an active goal on its own path (loop.ts).
    let goal: RunGoal
    try {
      goal = proposeGoal(context.runDir ?? '', objective)
    } catch (err) {
      return toolFail(
        'create_goal',
        'Not proposed',
        err instanceof Error ? err.message : String(err)
      )
    }
    if (context.runId) {
      emitGoalUpdate({
        workspacePath: context.sessionWorkspace ?? _workspace,
        runId: context.runId,
        runDir: context.runDir ?? '',
        goal
      })
    }
    return toolOk(
      'create_goal',
      truncateGoalObjective(goal.objective),
      `${goalToolContent(goal)}\nAwaiting user confirmation — it grants nothing until the user starts it. Continue this turn on your own; do not wait for it and do not try to activate it.`
    )
  },
  check_done_when: (_workspace, args, signal, context) => {
    throwIfAborted(signal)
    const result = executeCheckDoneWhen(context.runDir, args)
    return result.ok
      ? toolOk('check_done_when', result.summary, result.content)
      : toolFail('check_done_when', result.summary, result.content)
  },
  update_goal: (_workspace, args, signal, context) => {
    throwIfAborted(signal)
    if (context.inlineInstance) {
      return toolFail('update_goal', 'Root chat only', 'update_goal is only available on the root chat.')
    }
    const statusArg = args.status
    if (statusArg !== 'complete' && statusArg !== 'active') {
      return toolFail(
        'update_goal',
        'Invalid status',
        'update_goal accepts only "active" (resume) or "complete" (objective done).'
      )
    }
    let goal: RunGoal
    try {
      goal = updateGoalStatus(context.runDir ?? '', statusArg)
    } catch (err) {
      return toolFail(
        'update_goal',
        'Not updated',
        err instanceof Error ? err.message : String(err)
      )
    }
    if (context.runId) {
      emitGoalUpdate({
        workspacePath: context.sessionWorkspace ?? _workspace,
        runId: context.runId,
        runDir: context.runDir ?? '',
        goal
      })
    }
    return toolOk('update_goal', goal.status, goalToolContent(goal))
  },
  create_plan: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const result = executeCreatePlan(workspace, args, {
      runDir: context.runDir
    })
    if (!result.ok) {
      return toolFail('create_plan', result.summary, result.content)
    }
    // No mode change here any more. This used to promote a Plan-mode run to
    // Agent so it could act on what it had just published; with Plan merged
    // into Agent the run is already in the mode that implements the plan, so
    // publishing is a plain tool result and the prior promotion — plus the
    // `switch_mode` step it existed to save — is simply gone.
    return toolOk('create_plan', result.summary, result.content)
  },
  ...browserHandlers,
  ...mcpHandlers,
  ask_question: async (_workspace, args, signal, context) => {
    throwIfAborted(signal)
    const normalized = normalizeAskQuestionArgs(args)
    if (!normalized.ok) {
      const summary = summarizeToolArgsFromRecord('ask_question', args) || 'Invalid arguments'
      return toolFail('ask_question', summary, normalized.error)
    }
    const form = normalized.form
    const summary = askQuestionSummary(form)
    if (!context.runId || !context.toolCallId) {
      return toolFail('ask_question', summary, 'ask_question requires an active run')
    }
    const request: AgentQuestionRequest = {
      requestId: randomUUID(),
      runId: context.runId,
      toolCallId: context.toolCallId,
      ...(form.title ? { title: form.title } : {}),
      questions: form.questions
    }
    const liveSettings = context.invokeSettings ?? getSettings()
    if (liveSettings.autonomousMode && liveSettings.autonomousSkipQuestions === 'skip') {
      return toolOk('ask_question', summary, ASK_QUESTION_AUTONOMOUS_SKIP_GUIDANCE)
    }
    const ask =
      context.askQuestion ??
      ((req, sig) => askQuestionThroughRenderer(req, sig, context.invokeId))
    // Hard run cancel only — soft stream interrupt (Send now) must not dismiss the card.
    const waitSignal = context.runSignal ?? signal
    try {
      const answers = await ask(request, waitSignal)
      if (answers.length === 0) {
        return toolOk('ask_question', summary, ASK_QUESTION_NO_ANSWER_GUIDANCE)
      }
      return toolOk('ask_question', summary, formatQuestionAnswers(form, answers))
    } catch (err) {
      if (isAbortError(err)) throw err
      const message = err instanceof Error ? err.message : 'Question failed'
      return toolFail(
        'ask_question',
        summary,
        /window is listening|none is listening/i.test(message)
          ? `${message} This is transient - retry ask_question once the UI is ready.`
          : message
      )
    }
  },
  switch_mode: async (_workspace, args, signal, context) => {
    throwIfAborted(signal)
    if (!context.autoModeSwitch) {
      return toolFail(
        'switch_mode',
        'mode',
        'Automatic mode switching is off. Only the user can change Ask / Agent (composer or slash).'
      )
    }
    // `'plan'` is accepted and folded to `'agent'`: a model that learned the
    // old three-mode vocabulary asks for the mode that no longer exists, and
    // agent is exactly what plan became. Failing would cost it a wasted step.
    const mode = args.mode === 'plan' ? 'agent' : args.mode
    if (mode !== 'ask' && mode !== 'agent') {
      return toolFail('switch_mode', 'mode', 'mode must be ask or agent')
    }
    const previous = resolveAgentMode(context)
    if (!context.setAgentMode) {
      return toolFail(
        'switch_mode',
        'mode',
        'Mode switch unavailable: setAgentMode is not wired for this invoke.'
      )
    }
    await context.setAgentMode(mode)
    if (context.runId) {
      context.emitAgentEvent?.({
        type: 'mode_changed',
        runId: context.runId,
        mode,
        ...(context.invokeId != null ? { invokeId: context.invokeId } : {})
      })
    }
    const content =
      previous === mode
        ? `Already in ${mode} mode.`
        : `Mode switched from ${previous} to ${mode}. Tool gating applies immediately; the visible tool catalog refreshes for subsequent steps.`
    return toolOk('switch_mode', mode, content)
  },
  ...terminalHandlers,
  memory_list: (workspace, _args, signal) => {
    throwIfAborted(signal)
    return toolOk('memory_list', 'memory', toolMemoryList(workspace))
  },
  memory_read: (workspace, args, signal) => {
    throwIfAborted(signal)
    const path = requirePathArg('memory_read', args)
    const content = toolMemoryRead(workspace, path)
    return toolOk('memory_read', path, content)
  },
  memory_write: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const path = requirePathArg('memory_write', args)
    const contents = readString(args, 'contents') ?? readString(args, 'content') ?? ''
    const relUnderWorkspace = `.vyotiq/memory/${path.trim().replace(/^[/\\]+/, '').replace(/\\/g, '/')}`
    const content = await withWorkspaceMutation(workspace, relUnderWorkspace, () =>
      toolMemoryWrite(workspace, path, contents)
    )
    clearWorkspaceSnapshotCache(workspace)
    return toolOk('memory_write', path, content)
  },
  Skill: (workspace, args, signal) => {
    throwIfAborted(signal)
    const name = args.name as string
    const path = typeof args.path === 'string' ? args.path : undefined
    try {
      const content = toolSkill(workspace, name, path)
      return toolOk('Skill', summarizeSkillArgs(name, path), content)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return toolFail('Skill', summarizeSkillArgs(name, path), msg)
    }
  },
  ...gitGithubHandlers,
  diagnostics: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const kind = args.kind === 'lint' ? 'lint' : 'typecheck'
    const result = await toolDiagnosticsAsync(
      workspace,
      kind,
      signal,
      context.diagnosticsCommand
    )
    throwIfAborted(signal)
    if (!result.ok) return toolFail('diagnostics', kind, result.content)
    return toolOk('diagnostics', kind, result.content)
  },
  run_tests: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const result = await toolRunTestsAsync(workspace, args, signal)
    throwIfAborted(signal)
    if (!result.ok) return toolFail('run_tests', result.command, result.content)
    return toolOk('run_tests', result.command, result.content)
  },
  edit_notebook: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const path = String(args.target_notebook ?? '')
    if (!context.skipWriteCheckpoint) {
      await getWriteCheckpoint(context.runDir)?.recordPrior(path, 'write')
    }
    const content = await toolEditNotebookAsync(workspace, args as EditNotebookArgs)
    invalidateAfterWorkspaceMutation(workspace, path)
    return toolOk('edit_notebook', path, content)
  },
  lsp: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const result = await toolLsp(workspace, args)
    throwIfAborted(signal)
    if (result.pendingRenameEdits && result.pendingRenameEdits.length > 0) {
      const paths = [...new Set(result.pendingRenameEdits.map((edit) => edit.path))]
      try {
        assertInlineInstancePathScope(context.runDir, paths, {
          inlineInstance: context.inlineInstance
        })
      } catch (err) {
        return toolFail('lsp', result.summary, formatError(err))
      }
      if (!context.skipWriteCheckpoint) {
        const cp = getWriteCheckpoint(context.runDir)
        if (cp) {
          for (const path of paths) await cp.recordPrior(path, 'write')
        }
      }
      const mutated = await applyLspRenameEdits(workspace, result.pendingRenameEdits)
      invalidateAfterWorkspaceMutation(workspace, mutated)
      return toolOk(
        'lsp',
        result.summary,
        `Applied ${result.pendingRenameEdits.length} edit(s) in ${mutated.length} file(s):\n${result.content}`
      )
    }
    if (!result.ok) return toolFail('lsp', result.summary, result.content)
    return toolOk('lsp', result.summary, result.content)
  },
  ...instanceHandlers,
  build_tool: async (_workspace, args, signal) => {
    throwIfAborted(signal)
    const written = await buildToolHandler(args)
    return toolOk(
      'build_tool',
      `built ${String(args.name ?? '')}`,
      `Wrote ${written.written}.\n\nIt joins the tool catalog on your next step. Calling it asks the user — every time the file changes, because the approval is granted against the code, not the name.`
    )
  }
}

export { BUILTIN_TOOL_NAMES, canonicalizeAgentToolName } from '../schemas/tools'

function normalizeParsedToolArgs(
  name: string,
  parsed: Record<string, unknown>
): Record<string, unknown> {
  const normalized = { ...parsed }

  if (
    (name === 'read' ||
      name === 'edit' ||
      name === 'str_replace' ||
      name === 'delete' ||
      name === 'list_dir' ||
      name === 'memory_read' ||
      name === 'memory_write') &&
    typeof normalized.path !== 'string'
  ) {
    const path = readPathArg(normalized)
    if (path) normalized.path = path
  }
  if (name === 'list_dir' && typeof normalized.path !== 'string') {
    const directory = readString(normalized, 'directory')
    if (directory !== undefined) normalized.path = directory
  }
  if (name === 'grep' && typeof normalized.include !== 'string') {
    // Models often pass `path` for a file/glob filter; map it to the real field.
    const path = typeof normalized.path === 'string' ? normalized.path.trim() : ''
    if (path) normalized.include = path
  }
  if (name === 'edit' && typeof normalized.contents !== 'string') {
    const content = readString(normalized, 'content')
    if (content !== undefined) normalized.contents = content
  }
  if (name === 'todo_write' && typeof normalized.todos === 'string') {
    const parsedTodos = parseJsonish(normalized.todos)
    if (Array.isArray(parsedTodos)) normalized.todos = parsedTodos
  }
  if (name === 'terminal') {
    if (typeof normalized.command !== 'string') {
      const command = readString(normalized, 'cmd')
      if (command !== undefined) normalized.command = command
    }
    const command = typeof normalized.command === 'string' ? normalized.command : ''
    if (command.trim()) {
      delete normalized.session_id
    }
    if (typeof normalized.pattern === 'string' && normalized.pattern.trim() === '') {
      delete normalized.pattern
    }
  }
  if (typeof normalized.serverId !== 'string' && typeof normalized.server_id === 'string') {
    normalized.serverId = normalized.server_id
  }
  if (name === 'spawn_agent_instance') {
    // Two callers arrive without the full structured brief. Legacy alias calls
    // (Task/subagent) carry only a free-form prompt; models that read `goal` as
    // "the whole brief" send a rich goal and omit its siblings (run 874dad8f:
    // 6/6 spawns rejected with `outcome: Required`, the model re-sending the
    // identical payload because a bare Zod complaint names no remedy). Derive
    // whatever is missing from the goal text so the brief still composes — the
    // handler re-validates with its own actionable errors.
    const goal =
      readTrimmed(normalized, 'goal') ||
      readTrimmed(normalized, 'prompt') ||
      readTrimmed(normalized, 'description')
    if (goal) {
      normalized.goal = goal
      if (!readTrimmed(normalized, 'outcome')) normalized.outcome = goal
      if (!readTrimmed(normalized, 'done_when')) normalized.done_when = goal
      if (
        !Array.isArray(normalized.sub_tasks) ||
        normalized.sub_tasks.filter((t) => typeof t === 'string' && t.trim()).length === 0
      ) {
        normalized.sub_tasks = [goal]
      }
    }
  }
  if (name === 'lsp') {
    if (typeof normalized.action !== 'string') {
      normalized.action = 'diagnostics'
    }
    if (typeof normalized.new_name !== 'string' && typeof normalized.newName === 'string') {
      normalized.new_name = normalized.newName
    }
    const path = readPathArg(normalized)
    if (path && typeof normalized.path !== 'string') normalized.path = path
  }
  if (name === 'edit_notebook' && typeof normalized.target_notebook !== 'string') {
    const path = readPathArg(normalized)
    if (path) normalized.target_notebook = path
  }

  return normalized
}

function parseToolArgs(name: string, argsJson: string | undefined): Record<string, unknown> {
  const wired = wireToolCallArguments(name, argsJson ?? '')

  try {
    const parsed: unknown = JSON.parse(wired)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return normalizeParsedToolArgs(name, parsed as Record<string, unknown>)
    }
  } catch {
    // fall through
  }
  return {}
}

/**
 * One agent-built tool by name, or null.
 *
 * The snapshot is mtime-cached, so this is a cheap directory sweep rather than
 * a rescan, and a tool written earlier in this run is found on the next step
 * without a restart.
 */
const BUILTIN_NAME_SET: ReadonlySet<string> = new Set<string>(BUILTIN_TOOL_NAMES_FOR_SCAN)

/**
 * One agent-built tool by name, or null.
 *
 * Builtins and MCP names short-circuit before any I/O, so the directory sweep
 * only runs for a name nothing else claims — which is exactly the agent-built
 * case. The snapshot is mtime-cached, so a tool written earlier in this run is
 * found on the next step without a restart.
 */
async function findAgentBuiltTool(name: string): Promise<AgentToolDef | null> {
  if (BUILTIN_NAME_SET.has(name)) return null
  if (name.startsWith('mcp__')) return null
  try {
    const defs = await loadAgentToolsSnapshot(await resolveAgentToolsDir())
    return defs.find((def) => def.name === name) ?? null
  } catch (err) {
    logger.warn('Agent tool scan failed', { scope: 'tools', tool: name, err })
    return null
  }
}

export async function executeTool(
  rawName: string,
  argsJson: string | undefined,
  workspace: string,
  signal: AbortSignal,
  context: ToolExecutionContext = {}
): Promise<ToolResult> {
  throwIfAborted(signal)

  if (typeof rawName !== 'string' || !rawName.trim()) {
    return toolFail('unknown', 'unknown', 'Tool call missing name')
  }
  const name = canonicalizeAgentToolName(rawName)

  const duplicateKey = duplicateTopLevelJsonKeyError(argsJson ?? '')
  if (duplicateKey) {
    return toolFail(name, name, duplicateKey)
  }

  const agentMode: AgentInteractionMode = resolveAgentMode(context)

  // Agent-built tools (`build_tool`). Resolved before the builtin lookup
  // because the name is not in the registry and never can be — build_tool
  // refuses a name that shadows one. The module's own JSON Schema is its
  // contract, so args go through as parsed rather than through
  // validateParsedToolArgs, which only knows builtin schemas.
  const agentBuilt = await findAgentBuiltTool(name)
  if (agentBuilt) {
    const parsed = parseToolArgs(name, argsJson)
    const modeGate = assertToolAllowedInMode(agentMode, name, parsed, {
      autoModeSwitch: context.autoModeSwitch,
      inlineInstance: context.inlineInstance === true
    })
    if (!modeGate.ok) return toolFail(name, name, modeGate.error)
    try {
      // Same guard MCP gets: an agent-built module is arbitrary Node with no
      // path scope, so a scope-shared instance running one would write straight
      // past the boundary its worktree exists to enforce.
      assertInlineInstanceUnscopedToolAllowed(context.runDir, 'Agent-built tool', {
        inlineInstance: context.inlineInstance
      })
    } catch (err) {
      return toolFail(name, name, formatError(err))
    }
    const summary = `${name} (agent-built)`
    try {
      const outcome = await runAgentTool(agentBuilt, parsed)
      if (!outcome.ok) {
        return toolFail(name, summary, outcome.error ?? `${name} failed with no error message`)
      }
      const rendered =
        typeof outcome.result === 'string'
          ? outcome.result
          : JSON.stringify(outcome.result ?? null, null, 2)
      return toolOk(name, summary, rendered)
    } catch (err) {
      // A timeout or a child that died without answering arrives here.
      return toolFail(name, summary, formatError(err))
    }
  }

  const mcp = parseMcpToolName(name)
  if (mcp) {
    const parsed = parseToolArgs(name, argsJson)
    const modeGate = assertToolAllowedInMode(agentMode, name, parsed, {
      autoModeSwitch: context.autoModeSwitch,
      inlineInstance: context.inlineInstance === true
    })
    if (!modeGate.ok) {
      return toolFail(name, name, modeGate.error)
    }
    try {
      assertInlineInstanceUnscopedToolAllowed(context.runDir, 'MCP', {
        inlineInstance: context.inlineInstance
      })
    } catch (err) {
      return toolFail(name, name, formatError(err))
    }
    if (context.runEnabledMcpIds && !context.runEnabledMcpIds.has(mcp.serverId)) {
      return toolFail(
        name,
        name,
        `MCP server "${mcp.serverId}" is not enabled for this workspace run`
      )
    }
    const policy = context.mcpToolPolicies?.get(mcp.serverId)
    if (policy && !isMcpToolPermitted(mcp.toolName, policy)) {
      return toolFail(
        name,
        name,
        `MCP tool "${mcp.toolName}" is blocked by this server's allow/deny list`
      )
    }
    const def = getMcpToolDefinition(name)
    if (!def) {
      return toolFail(name, name, `Unknown or unavailable MCP tool: ${name}`)
    }
    // Catalog gate last: server enabled, name permitted and the tool really
    // exists, so a miss here means only that its schema was deferred. Admit it
    // for the next step instead of charging the agent a round trip through
    // request_mcp_tools to ask for something it just demonstrated it wants.
    // Policy and existence are checked first so a hallucinated or blocked name
    // can never load itself into the catalog.
    if (context.stepMcpToolNames && !context.stepMcpToolNames.has(name)) {
      const pinned = context.runPinnedMcpToolNames
      if (pinned && !pinned.has(name)) {
        pinned.add(name)
        context.mcpLastUsedByName?.set(name, Math.max(context.currentStep ?? 1, 1))
        context.invalidateMcpToolCatalogCache?.()
        return toolFail(name, name, mcpNotInCatalogErrorMessage(name, { autoLoaded: true }))
      }
      // Already admitted and still absent (or no run to admit into): this is
      // the same-step retry the fail-fast counter exists for.
      const counts = context.mcpNotInCatalogCounts
      const failureCount = counts
        ? recordMcpNotInCatalogFailure(counts, name)
        : 1
      if (failureCount >= MCP_NOT_IN_CATALOG_FAIL_FAST_THRESHOLD) {
        return toolFail(name, name, mcpNotInCatalogFailFastMessage(name, failureCount))
      }
      return toolFail(
        name,
        name,
        mcpNotInCatalogErrorMessage(name, {
          alreadyPinned: pinned?.has(name) === true
        })
      )
    }
    const stamp = Math.max(context.currentStep ?? 1, 1)
    context.mcpLastUsedByName?.set(name, stamp)
    await recordMcpFilesystemPriors(mcp.serverId, mcp.toolName, parsed, {
      runDir: context.runDir,
      skipWriteCheckpoint: context.skipWriteCheckpoint
    })
    const mcpResult = await invokeMcpTool(
      mcp.serverId,
      mcp.toolName,
      parsed,
      signal,
      name,
      context.runEnabledMcpIds,
      workspace
    )
    if (mcpResult.ok) {
      const mutated = new Set<string>()
      applyMcpFilesystemMutations(mutated, mcp.serverId, mcp.toolName, parsed)
      if (mutated.size > 0) {
        for (const p of mutated) context.mutationPaths?.add(p)
        invalidateAfterWorkspaceMutation(workspace, [...mutated])
      }
    }
    return mcpResult
  }

  const args = parseToolArgs(name, argsJson)
  const validation = toolCallArgumentsUnusable(name, argsJson)
    ? { ok: false as const, error: formatMalformedToolArgsError(name) }
    : validateParsedToolArgs(name, args)
  // The browser adapter intentionally accepts a selector with neither value
  // nor label and lets the live page report the available options.
  const browserSelectWithoutTarget =
    name === 'browser_select_option' &&
    !validation.ok &&
    /Provide value or label for browser_select_option/i.test(validation.error)
  if (!validation.ok && !browserSelectWithoutTarget) {
    const failSummary =
      summarizeToolArgsFromRecord(name, args) ||
      (name === 'ask_question' ? 'Invalid arguments' : name)
    return toolFail(name, failSummary, validation.error)
  }
  // Prefer schema-coerced data when validation succeeded (defaults / transforms).
  const validatedArgs =
    validation.ok && !browserSelectWithoutTarget ? validation.data : args
  const modeGate = assertToolAllowedInMode(agentMode, name, validatedArgs, {
    autoModeSwitch: context.autoModeSwitch,
    inlineInstance: context.inlineInstance === true
  })
  if (!modeGate.ok) {
    return toolFail(name, summarizeToolArgsFromRecord(name, validatedArgs), modeGate.error)
  }
  const summary = summarizeToolArgsFromRecord(name, validatedArgs)
  if (!Object.prototype.hasOwnProperty.call(BUILTIN_HANDLERS, name)) {
    return toolFail(name, name, formatUnknownToolError(name))
  }
  const handler = BUILTIN_HANDLERS[name as AgentToolName]

  // Remap run artifacts to the run directory (not the workspace root).
  // One rule for both surviving modes now that Plan is gone: `contract.md`
  // always, `plan.md` once the run artifact exists. The run seeds the plan stub
  // at start (see seedPlanStubIfMissing in loop.ts), so in practice it exists
  // from step 0 and an `edit plan.md` cannot escape to the workspace root —
  // that seeding is what replaced Plan mode's unconditional remap.
  //
  // Keeping the existence check rather than remapping `plan.md` outright is
  // deliberate: a workspace with its own root `plan.md` and no active run
  // artifact must still resolve to its own file.
  let effectiveWorkspace = workspace
  let effectiveArgs = validatedArgs
  let effectiveContext = context

  const shouldRemapPath = (pathArg: string): boolean => {
    if (!pathArg) return false
    if (isRunContractPath(pathArg)) return true
    return (
      isRunPlanPath(pathArg) &&
      Boolean(context.runDir) &&
      existsSync(join(context.runDir!, 'plan.md'))
    )
  }

  const remapPathArg = (pathArg: string): string => {
    const n = pathArg.replace(/\\/g, '/').replace(/^\.\//, '')
    return basename(n)
  }

  const pathArg = readPathArg(args) ?? ''
  const remapRunArtifact =
    (name === 'edit' ||
      name === 'str_replace' ||
      name === 'read' ||
      name === 'delete') &&
    shouldRemapPath(pathArg)
  if (remapRunArtifact) {
    if (!context.runDir) {
      return toolFail(name, summary, 'Run artifacts require an active run directory')
    }
    if (name === 'delete') {
      return toolFail(
        name,
        summary,
        'plan.md and contract.md are run artifacts and cannot be deleted. Edit or recreate the file instead.'
      )
    }
    effectiveWorkspace = context.runDir
    effectiveArgs = { ...args, path: remapPathArg(pathArg) }
    if (name === 'edit' || name === 'str_replace') {
      effectiveContext = { ...context, skipWriteCheckpoint: true }
    }
  }

  // The retired `.vyotiq/agents/` data root is legacy user data. `read` is
  // included where the path_scope block below cannot reach it: `.vyotiq` is
  // skipped by the walkers, so glob/grep/search/list_dir never surface these
  // files, but a direct path read had nothing stopping it.
  if (
    effectiveWorkspace === workspace &&
    (name === 'read' ||
      name === 'edit' ||
      name === 'str_replace' ||
      name === 'delete' ||
      name === 'edit_notebook')
  ) {
    const p = readPathArg(effectiveArgs)
    try {
      assertNotRetiredAgentDataPath(p ? [p] : [])
    } catch (err) {
      return toolFail(name, summary, formatToolResultError(err))
    }
  }

  // Enforce inline instance path_scope on product-file writers (not run artifacts).
  if (
    effectiveWorkspace === workspace &&
    (name === 'edit' || name === 'str_replace' || name === 'delete' || name === 'edit_notebook')
  ) {
    const writePaths: string[] = []
    if (name === 'edit_notebook') {
      const p =
        typeof effectiveArgs.target_notebook === 'string'
          ? effectiveArgs.target_notebook
          : readPathArg(effectiveArgs)
      if (p) writePaths.push(p)
    } else {
      const p = readPathArg(effectiveArgs)
      if (p) writePaths.push(p)
    }
    try {
      assertInlineInstancePathScope(effectiveContext.runDir, writePaths, {
        inlineInstance: effectiveContext.inlineInstance
      })
    } catch (err) {
      const message = formatToolResultError(err)
      return toolFail(name, summary, message)
    }
  }

  const unscopedOpts = { inlineInstance: effectiveContext.inlineInstance }
  if (name === 'terminal') {
    try {
      assertInlineInstanceTerminalAllowed(effectiveContext.runDir, unscopedOpts)
    } catch (err) {
      noteInlineInstanceDeniedTool(effectiveContext.runId)
      return toolFail(name, summary, formatError(err))
    }
  }
  if (name === 'diagnostics') {
    try {
      assertInlineInstanceUnscopedToolAllowed(effectiveContext.runDir, 'diagnostics', unscopedOpts)
    } catch (err) {
      noteInlineInstanceDeniedTool(effectiveContext.runId)
      return toolFail(name, summary, formatError(err))
    }
  }
  if (name === 'git_commit') {
    try {
      assertInlineInstanceUnscopedToolAllowed(effectiveContext.runDir, 'git_commit', unscopedOpts)
    } catch (err) {
      noteInlineInstanceDeniedTool(effectiveContext.runId)
      return toolFail(name, summary, formatError(err))
    }
    try {
      if (effectiveArgs.push === true) {
        assertInlineInstancePushDenied(effectiveContext.runDir, unscopedOpts)
      }
      const commitPaths: string[] = []
      if (Array.isArray(effectiveArgs.paths)) {
        for (const p of effectiveArgs.paths) {
          if (typeof p === 'string' && p.trim()) commitPaths.push(p)
        }
      }
      if (effectiveContext.mutationPaths) {
        commitPaths.push(...effectiveContext.mutationPaths)
      }
      assertInlineInstancePathScope(effectiveContext.runDir, commitPaths, unscopedOpts)
    } catch (err) {
      return toolFail(name, summary, formatError(err))
    }
  }

  // Memory stays on the session workspace (notes live there).
  // codebase_search, grep, glob, search, read, and edits run on the worktree
  // so child indexes and hits match the files the instance is editing.
  if (effectiveContext.sessionWorkspace && usesSessionWorkspaceIndex(name)) {
    effectiveWorkspace = effectiveContext.sessionWorkspace
  }

  try {
    return await handler(effectiveWorkspace, effectiveArgs, signal, effectiveContext)
  } catch (err) {
    if (isAbortError(err)) {
      logger.warn('Tool aborted', { scope: 'tools', tool: name })
      throw err
    }
    const message = formatToolResultError(err)
    logToolFailure(name, err)
    return toolFail(name, summary, message, { failureLogged: true })
  }
}
