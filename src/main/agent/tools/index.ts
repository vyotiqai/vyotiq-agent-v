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
import { readPathArg, readEditBody, requirePathArg, readString } from './argAccess'
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
import { toolDeleteAsync } from './deletePath'
import {
  assertInlineInstancePathScope,
  assertInlineInstancePushDenied,
  assertInlineInstanceTerminalAllowed,
  assertInlineInstanceUnscopedToolAllowed
} from './writeGuard'
import { toolTodoWrite, type TodoItem } from './todo'
import { createGoal, updateGoalStatus, goalToolContent } from '../runGoal'
import { emitGoalUpdate } from '../goalEvents'
import { truncateGoalObjective } from '../../../shared/goalRuntime'
import { executeCreatePlan } from './createPlan'
import { ensurePlanStub } from '../planArtifacts'
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
import { clearGitignoreMatcherCache } from './gitignore'
import { browserHandlers } from './browserTools'
import { mcpHandlers } from './mcpTools'
import { terminalHandlers } from './terminalHandlers'
import { gitGithubHandlers } from './gitGithubTools'
import { instanceHandlers } from './instanceTools'
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
  isPlanArtifactPath,
  isRunContractPath,
  isRunPlanPath
} from './modePolicy'
import type {
  AgentEvent,
  AgentInteractionMode,
  AgentQuestionAnswer,
  AgentQuestionRequest,
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
  /** Ask / Plan / Agent mode for this invoke (prefer getAgentMode when mutable). */
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
  /**
   * Agent-profile memory namespace — routes memory_* tools (and the injected
   * <memory> prompt section) to `.vyotiq/agents/<namespace>/memory/` so
   * teammate profiles never share one brain. Absent = shared workspace memory.
   */
  memoryNamespace?: string
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
  const fields: {
    scope: 'tools'
    code: 'TOOL_EXEC'
    tool: string
    err: unknown
    kind?: string
  } = {
    scope: 'tools',
    code: 'TOOL_EXEC',
    tool: name,
    err
  }
  const kind = toolFailureKind(err)
  if (kind) fields.kind = kind
  const summary = logErrorSummary(err, 'TOOL_EXEC')
  const line = kind
    ? `Tool execution failed: ${summary} (${kind})`
    : `Tool execution failed: ${summary}`
  if (isExpectedToolError(formatError(err))) {
    logger.warn(line, fields)
  } else {
    logger.error(line, fields)
  }
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
  if (/Failed to parse tool arguments/i.test(message)) return 'bad_args'
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
  clearGitignoreMatcherCache(workspace)
  scheduleWorkspaceIndexSync(workspace)
  const paths =
    mutatedRelPath == null ? [] : Array.isArray(mutatedRelPath) ? mutatedRelPath : [mutatedRelPath]
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
    const goal = createGoal(context.runDir ?? '', objective)
    if (context.runId) {
      emitGoalUpdate({
        workspacePath: context.sessionWorkspace ?? _workspace,
        runId: context.runId,
        runDir: context.runDir ?? '',
        goal
      })
    }
    return toolOk('create_goal', truncateGoalObjective(goal.objective), goalToolContent(goal))
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
    const goal = updateGoalStatus(context.runDir ?? '', statusArg)
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
    // Deterministic mode contract: publishing the plan switches the run to
    // Plan mode when automatic mode switching is on — no deny/retry loop.
    let switched = false
    if (
      context.autoModeSwitch &&
      resolveAgentMode(context) === 'agent' &&
      context.setAgentMode
    ) {
      await context.setAgentMode('plan')
      switched = true
      if (context.runId) {
        context.emitAgentEvent?.({
          type: 'mode_changed',
          runId: context.runId,
          mode: 'plan',
          ...(context.invokeId != null ? { invokeId: context.invokeId } : {})
        })
      }
    }
    return toolOk(
      'create_plan',
      result.summary,
      switched
        ? `${result.content} Switched to Plan mode; switch back to \`agent\` to implement.`
        : result.content
    )
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
        'Automatic mode switching is off. Only the user can change Ask / Plan / Agent (composer or slash).'
      )
    }
    const mode = args.mode
    if (mode !== 'ask' && mode !== 'plan' && mode !== 'agent') {
      return toolFail('switch_mode', 'mode', 'mode must be ask, plan, or agent')
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
    if (mode === 'plan' && context.runDir) {
      ensurePlanStub(context.runDir)
    }
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
  memory_list: (workspace, _args, signal, context) => {
    throwIfAborted(signal)
    return toolOk('memory_list', 'memory', toolMemoryList(workspace, context.memoryNamespace))
  },
  memory_read: (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const path = requirePathArg('memory_read', args)
    const content = toolMemoryRead(workspace, path, context.memoryNamespace)
    return toolOk('memory_read', path, content)
  },
  memory_write: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const path = requirePathArg('memory_write', args)
    const contents = readString(args, 'contents') ?? readString(args, 'content') ?? ''
    const namespace = context.memoryNamespace
    const memoryPrefix = namespace
      ? `.vyotiq/agents/${namespace}/memory/`
      : '.vyotiq/memory/'
    const relUnderWorkspace = `${memoryPrefix}${path.trim().replace(/^[/\\]+/, '').replace(/\\/g, '/')}`
    const content = await withWorkspaceMutation(workspace, relUnderWorkspace, () =>
      toolMemoryWrite(workspace, path, contents, namespace)
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
  ...instanceHandlers
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
  if (name === 'spawn_agent_instance' && typeof normalized.goal !== 'string') {
    const prompt = readString(normalized, 'prompt') ?? readString(normalized, 'description')
    if (prompt) {
      normalized.goal = prompt
      // Legacy alias calls (Task/subagent) carry only a free-form prompt.
      // Derive the structured fields the strict schema requires so the call
      // reaches the handler, which re-validates with its own actionable errors.
      if (typeof normalized.outcome !== 'string') normalized.outcome = prompt
      if (typeof normalized.done_when !== 'string') normalized.done_when = prompt
      if (!Array.isArray(normalized.sub_tasks) || normalized.sub_tasks.length === 0) {
        normalized.sub_tasks = [prompt]
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
    if (context.stepMcpToolNames && !context.stepMcpToolNames.has(name)) {
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
          alreadyPinned: context.runPinnedMcpToolNames?.has(name) === true
        })
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

  // Remap run artifacts to the run directory (not the workspace root):
  // Plan: plan.md + contract.md; Agent: contract.md + existing plan.md.
  // Ask: read-only remap of the same artifacts so `read plan.md` resolves to
  // the run artifact instead of a workspace-root lookalike (Ask cannot run
  // edit/delete, so read is the only reachable consumer).
  let effectiveWorkspace = workspace
  let effectiveArgs = validatedArgs
  let effectiveContext = context

  const shouldRemapPath = (pathArg: string): boolean => {
    if (!pathArg) return false
    if (agentMode === 'plan' && isPlanArtifactPath(pathArg)) return true
    if (agentMode === 'agent' && isRunContractPath(pathArg)) return true
    if (
      agentMode === 'agent' &&
      isRunPlanPath(pathArg) &&
      context.runDir &&
      existsSync(join(context.runDir, 'plan.md'))
    ) {
      return true
    }
    if (
      agentMode === 'ask' &&
      (isRunContractPath(pathArg) ||
        (isRunPlanPath(pathArg) &&
          context.runDir &&
          existsSync(join(context.runDir, 'plan.md'))))
    ) {
      return true
    }
    return false
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
