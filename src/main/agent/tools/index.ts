import { logger, logErrorSummary } from '../../../shared/logger'
import { formatError, formatToolResultError, isAbortError, isExpectedToolError } from '../../../shared/errors'
import { duplicateTopLevelJsonKeyError } from '../../../shared/utils/jsonish'
import { summarizeToolArgsFromRecord } from '../../../shared/toolSummary'
import { isTerminalSessionInProgress, parseTerminalOutput } from '../../../shared/utils/terminalFormat'
import {
  canonicalizeAgentToolName,
  formatMalformedToolArgsError,
  formatUnknownToolError,
  validateParsedToolArgs,
  AWAIT_AGENT_INSTANCE_MAX_MS,
  type AgentToolName
} from '../schemas/tools'
import {
  invokeMcpTool,
  parseMcpToolName,
  getMcpToolDefinition,
  listMcpToolDefinitions,
  getMcpReadOnlyHint,
  assertMcpServerAccess,
  listMcpResources,
  readMcpResource,
  listMcpPrompts,
  getMcpPrompt,
  getMcpServerStatus
} from '../mcp'
import { resolveEffectiveMcpServers } from '@main/marketplace'
import { isMcpToolPermitted } from '../../../shared/utils/mcpToolPolicy'
import { isOptionalBuiltinName } from '../context/toolsBudget'
import { toolRead } from './read'
import { toolEditAsync } from './edit'
import { readPathArg, readEditBody, readTrimmed, requirePathArg, readString } from './argAccess'
import { toolSearch } from './search'
import { toolGlob } from './glob'
import { toolGrep } from './grep'
import { toolCodebaseSearch, CODEBASE_SEARCH_DEFAULT_LIMIT } from './codebaseSearch'
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
  isProcessKillSweepContent,
  toolTerminal,
  TERMINAL_DEFAULT_TIMEOUT_MS,
  resolveNewCommandBlockUntilMs,
  resolveSessionPollBlockUntilMs
} from './terminal'
import { toolMemoryList, toolMemoryRead, toolMemoryWrite } from './memory'
import { toolSkill, summarizeSkillArgs } from './skill'
import { toolGitDiffAsync, toolGitStatusAsync } from './gitHelpers'
import { toolDiagnosticsAsync } from './diagnostics'
import { toolRunTestsAsync } from './runTests'
import { toolApplyPatchAsync } from './applyPatch'
import { toolEditNotebookAsync, type EditNotebookArgs } from './editNotebook'
import { toolLsp, applyLspRenameEdits } from './lsp'
import { getSettings } from '@main/settings/settings'
import {
  navigateUrl,
  snapshotPage,
  clickSelector,
  typeText,
  scrollPage,
  fillSelector,
  manageTabs,
  goBack,
  goForward,
  waitForSelector,
  waitForUrl,
  pressKey,
  selectOption,
  hoverSelector,
  waitForText,
  handleDialog
} from '@main/app/agentBrowser'
import { startBackgroundTerminal, pollTerminalSession, registerTerminalSessionExitFinalize } from './terminalSessions'
import { buildSearchUrl } from '../../../shared/utils/searchEngine'
import { getWriteCheckpoint } from '../checkpoints'
import { needsOpaqueWatch, recordTerminalCommandPriors } from './terminalCheckpoint'
import { applyMcpFilesystemMutations, recordMcpFilesystemPriors } from './mcpCheckpoint'
import {
  cancelChildInstance,
  formatAgentInstanceLabel,
  mergeAgentInstanceBranch,
  noteInlineInstanceDeniedTool,
  pullChildRun,
  spawnAgentInstance,
  waitForChildTerminal,
  type PullAgentInstanceView
} from '../agentInstances'
import { loadStatus } from '../state'
import { resolveRunDir } from '@main/storage/paths'
import {
  applyWatchDiffToCheckpoint,
  diffSince,
  disposeWatch,
  startWatch
} from '../workspaceMutationWatch'
import { resolveInsideWorkspace } from '@main/workspace/safePath'
import { withWorkspaceMutation } from '@main/workspace/mutationQueue'
import { clearWorkspaceSnapshotCache } from '../context/workspaceSnapshot'
import { commitPaths } from '@main/git/git'
import {
  prCreate,
  reviewPullRequest,
  listGithubIssues,
  createGithubIssue
} from '@main/git/gh'
import { invalidateGitStatusCache } from '@main/git/gitStatusCache'
import { invalidateSlashCommandsCache } from '../slashCommands/listCache'
import { clearGitignoreMatcherCache } from './gitignore'
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
  /** Paths the agent changed this run — scopes git_commit staging when present. */
  mutationPaths?: Set<string>
  /**
   * Parent tool-approval gate.
   */
  approval?: ToolApprovalGate
}

type ToolHandler = (
  workspace: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  context: ToolExecutionContext
) => Promise<ToolResult> | ToolResult

function throwIfAborted(signal: AbortSignal): void {
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

function toolOk(name: string, summary: string, content: string): ToolResult {
  logToolSuccess(name)
  return { ok: true, summary, content }
}

function toolFail(
  name: string,
  summary: string,
  content: string,
  opts?: { failureLogged?: boolean }
): ToolResult {
  return { ok: false, summary, content, failureLogged: opts?.failureLogged }
}

/** Prefer the real shell command over a session UUID in logs and timeline titles. */
function terminalResultSummary(command: string, sessionId: string, content: string): string {
  const fromArgs = command.trim()
  if (fromArgs) return fromArgs.slice(0, 80)
  const fromContent = parseTerminalOutput(content).command?.trim() ?? ''
  if (fromContent) return fromContent.slice(0, 80)
  return (sessionId || 'session').slice(0, 80)
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
  // are evidence, not tool faults. Counting them as failures made runs stop
  // on LOOP_SAFETY while probing a machine's toolchain (run 1de9344a).
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

function resolveAgentMode(context: ToolExecutionContext): AgentInteractionMode {
  return context.getAgentMode?.() ?? context.agentMode ?? 'agent'
}

/** Memory tools bind to the session workspace SQLite; live file tools do not. */
export function usesSessionWorkspaceIndex(name: string): boolean {
  return name === 'memory_list' || name === 'memory_read' || name === 'memory_write'
}

/** Drop short-lived FS views that mutate with writes/git (git status, snapshot, gitignore). */
function invalidateAfterWorkspaceMutation(
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

type CheckpointWatchContext = { runDir?: string; skipWriteCheckpoint?: boolean }

/** Snapshot known + opaque terminal writes for undo. */
async function withTerminalCheckpointWatch<T>(
  workspace: string,
  command: string,
  context: CheckpointWatchContext,
  run: () => Promise<T>
): Promise<T> {
  await recordTerminalCommandPriors(workspace, command, context)
  const snap =
    !context.skipWriteCheckpoint && context.runDir && command.trim() && needsOpaqueWatch(command)
      ? await startWatch(workspace)
      : null
  try {
    return await run()
  } finally {
    if (snap) {
      await applyWatchDiffToCheckpoint(snap, await diffSince(snap), context)
      disposeWatch(snap)
    }
  }
}

/**
 * Background-terminal variant: the poll window can return while the shell
 * keeps running, so the final diff runs when the session's process exits (via
 * the session exit-finalizer hook) instead of at tool return. Otherwise later
 * mutations escape the write checkpoint and the scoped-commit mutation paths.
 */
async function withBackgroundTerminalCheckpointWatch(
  workspace: string,
  command: string,
  context: CheckpointWatchContext,
  run: (registerExitFinalize: (sessionId: string) => void) => Promise<string>
): Promise<string> {
  await recordTerminalCommandPriors(workspace, command, context)
  const snap =
    !context.skipWriteCheckpoint && context.runDir && command.trim() && needsOpaqueWatch(command)
      ? await startWatch(workspace)
      : null
  let deferred = false
  const diffAndDispose = async (): Promise<void> => {
    if (!snap) return
    try {
      await applyWatchDiffToCheckpoint(snap, await diffSince(snap), context)
      invalidateAfterWorkspaceMutation(workspace)
    } finally {
      disposeWatch(snap)
    }
  }
  try {
    return await run((sessionId) => {
      if (!snap) return
      deferred = registerTerminalSessionExitFinalize(sessionId, diffAndDispose)
    })
  } finally {
    if (!deferred) await diffAndDispose()
  }
}

function optionalBuiltinCatalogName(raw: string): string | undefined {
  const canonical = canonicalizeAgentToolName(raw)
  return isOptionalBuiltinName(canonical) ? canonical : undefined
}

function optionalMcpServerId(args: Record<string, unknown>): string | undefined {
  const value = args.serverId
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function mcpServerGate(
  toolName: string,
  serverId: string,
  summary: string,
  context: ToolExecutionContext,
  workspacePath?: string | null
): { ok: true } | { ok: false; result: ToolResult } {
  const access = assertMcpServerAccess(serverId, context.runEnabledMcpIds, workspacePath)
  if (!access.ok) {
    return { ok: false, result: toolFail(toolName, summary, access.error) }
  }
  return { ok: true }
}

function formatMcpResourceLines(entries: Awaited<ReturnType<typeof listMcpResources>>): string {
  return entries
    .map((entry) => {
      const label = entry.name ? `${entry.uri} (${entry.name})` : entry.uri
      const meta = [entry.mimeType, entry.description?.replace(/\s+/g, ' ').trim()]
        .filter(Boolean)
        .join(' — ')
      return `- [${entry.serverId}] ${label}${meta ? `: ${meta}` : ''}`
    })
    .join('\n')
}

function formatMcpPromptLines(entries: Awaited<ReturnType<typeof listMcpPrompts>>): string {
  return entries
    .map((entry) => {
      const argNames = (entry.arguments ?? []).map((arg) => arg.name).filter(Boolean)
      const argsNote = argNames.length ? ` args=[${argNames.join(', ')}]` : ''
      const desc = entry.description?.replace(/\s+/g, ' ').trim()
      return `- [${entry.serverId}] ${entry.name}${argsNote}${desc ? `: ${desc}` : ''}`
    })
    .join('\n')
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
    const modeRaw = typeof args.mode === 'string' ? args.mode : 'hybrid'
    const mode =
      modeRaw === 'semantic' || modeRaw === 'lexical' || modeRaw === 'hybrid' ? modeRaw : 'hybrid'
    const content = await toolCodebaseSearch(workspace, query, {
      maxResults:
        typeof args.maxResults === 'number' ? args.maxResults : CODEBASE_SEARCH_DEFAULT_LIMIT,
      mode,
      refresh: args.refresh === true,
      signal
    })
    throwIfAborted(signal)
    return toolOk('codebase_search', query, content)
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
  browser_search: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const query = readTrimmed(args, 'query')
    if (!query) throw new Error('browser_search requires query')
    // Invoke-snapshotted settings when present — avoid mid-run searchEngine drift.
    const settings = context.invokeSettings ?? getSettings()
    const url = buildSearchUrl(settings.searchEngine, query)
    const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined
    const allowLocal = resolveAgentMode(context) === 'agent'
    const nav = await navigateUrl(url, {
      signal,
      timeoutMs,
      workspacePath: workspace,
      allowLocal
    })
    throwIfAborted(signal)
    const snap = await snapshotPage({
      signal,
      workspacePath: workspace,
      runDir: context.runDir,
      maxChars: typeof args.maxChars === 'number' ? args.maxChars : undefined
    })
    throwIfAborted(signal)
    return toolOk('browser_search', query, `${nav}\n\n${snap}`)
  },
  browser_navigate: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const url = args.url as string
    const allowLocal = resolveAgentMode(context) === 'agent'
    const content = await navigateUrl(url, {
      signal,
      timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      workspacePath: workspace,
      allowLocal
    })
    throwIfAborted(signal)
    return toolOk('browser_navigate', url, content)
  },
  browser_snapshot: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const content = await snapshotPage({
      signal,
      maxChars: typeof args.maxChars === 'number' ? args.maxChars : undefined,
      runDir: context.runDir,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      workspacePath: workspace
    })
    throwIfAborted(signal)
    return toolOk('browser_snapshot', 'page', content)
  },
  browser_click: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const selector = args.selector as string
    const button =
      args.button === 'left' || args.button === 'right' || args.button === 'middle'
        ? args.button
        : undefined
    const content = await clickSelector(selector, {
      signal,
      button,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      settleMs: typeof args.settleMs === 'number' ? args.settleMs : undefined,
      workspacePath: workspace,
      includeSnapshot: args.includeSnapshot === true,
      runDir: context.runDir,
      maxChars: typeof args.maxChars === 'number' ? args.maxChars : undefined
    })
    throwIfAborted(signal)
    return toolOk('browser_click', selector, content)
  },
  browser_type: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const text = args.text as string
    let content = await typeText(text, {
      signal,
      selector: typeof args.selector === 'string' ? args.selector : undefined,
      clear: args.clear === true,
      pressEnter: args.pressEnter === true,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      settleMs: typeof args.settleMs === 'number' ? args.settleMs : undefined,
      workspacePath: workspace
    })
    if (args.includeSnapshot === true) {
      content = `${content}\n\n${await snapshotPage({
        signal,
        workspacePath: workspace,
        runDir: context.runDir,
        tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined
      })}`
    }
    throwIfAborted(signal)
    const target =
      typeof args.selector === 'string' && args.selector.trim()
        ? args.selector.trim()
        : 'active element'
    return toolOk('browser_type', target, content)
  },
  browser_scroll: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    let content = await scrollPage({
      signal,
      selector: typeof args.selector === 'string' ? args.selector : undefined,
      deltaX: typeof args.deltaX === 'number' ? args.deltaX : undefined,
      deltaY: typeof args.deltaY === 'number' ? args.deltaY : undefined,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      settleMs: typeof args.settleMs === 'number' ? args.settleMs : undefined,
      workspacePath: workspace
    })
    if (args.includeSnapshot === true) {
      content = `${content}\n\n${await snapshotPage({
        signal,
        workspacePath: workspace,
        runDir: context.runDir,
        tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined
      })}`
    }
    throwIfAborted(signal)
    const target =
      typeof args.selector === 'string' && args.selector.trim()
        ? args.selector.trim()
        : `Δ(${Number(args.deltaX) || 0},${Number(args.deltaY) || 0})`
    return toolOk('browser_scroll', target, content)
  },
  browser_fill: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const selector = args.selector as string
    const value = args.value as string
    let content = await fillSelector(selector, value, {
      signal,
      pressEnter: args.pressEnter === true,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      settleMs: typeof args.settleMs === 'number' ? args.settleMs : undefined,
      workspacePath: workspace
    })
    if (args.includeSnapshot === true) {
      content = `${content}\n\n${await snapshotPage({
        signal,
        workspacePath: workspace,
        runDir: context.runDir,
        tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined
      })}`
    }
    throwIfAborted(signal)
    return toolOk('browser_fill', selector, content)
  },
  browser_tabs: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const action = args.action
    if (action !== 'list' && action !== 'open' && action !== 'close' && action !== 'select') {
      return toolFail('browser_tabs', 'tabs', 'action must be list|open|close|select')
    }
    // Same Ask/Plan SSRF gate as browser_navigate — open must not default allowLocal=true.
    const allowLocal = resolveAgentMode(context) === 'agent'
    const content = await manageTabs(action, {
      signal,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      url: typeof args.url === 'string' ? args.url : undefined,
      workspacePath: workspace,
      allowLocal
    })
    throwIfAborted(signal)
    return toolOk('browser_tabs', action, content)
  },
  browser_back: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const allowLocal = resolveAgentMode(context) === 'agent'
    const content = await goBack({
      signal,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      workspacePath: workspace,
      allowLocal
    })
    throwIfAborted(signal)
    // Empty summary — "back"/"forward" duplicated the verb ("Going back back").
    return toolOk('browser_back', '', content)
  },
  browser_forward: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const allowLocal = resolveAgentMode(context) === 'agent'
    const content = await goForward({
      signal,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      workspacePath: workspace,
      allowLocal
    })
    throwIfAborted(signal)
    return toolOk('browser_forward', '', content)
  },
  browser_wait_for_selector: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const selector = args.selector as string
    const content = await waitForSelector(selector, {
      signal,
      timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      workspacePath: workspace
    })
    throwIfAborted(signal)
    return toolOk('browser_wait_for_selector', selector, content)
  },
  browser_wait_for_url: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const match = args.match as string
    const content = await waitForUrl(match, {
      signal,
      regex: args.regex === true,
      timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      workspacePath: workspace
    })
    throwIfAborted(signal)
    return toolOk('browser_wait_for_url', match.slice(0, 80), content)
  },
  browser_press_key: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const key = args.key as string
    const modifiers = Array.isArray(args.modifiers)
      ? args.modifiers.filter((m): m is string => typeof m === 'string')
      : undefined
    let content = await pressKey(key, {
      signal,
      modifiers,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      settleMs: typeof args.settleMs === 'number' ? args.settleMs : undefined,
      workspacePath: workspace
    })
    if (args.includeSnapshot === true) {
      content = `${content}\n\n${await snapshotPage({
        signal,
        workspacePath: workspace,
        runDir: context.runDir,
        tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined
      })}`
    }
    throwIfAborted(signal)
    return toolOk('browser_press_key', key, content)
  },
  browser_select_option: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const selector = args.selector as string
    let content = await selectOption(selector, {
      signal,
      value: typeof args.value === 'string' ? args.value : undefined,
      label: typeof args.label === 'string' ? args.label : undefined,
      pressEnter: args.pressEnter === true,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      settleMs: typeof args.settleMs === 'number' ? args.settleMs : undefined,
      workspacePath: workspace
    })
    if (args.includeSnapshot === true) {
      content = `${content}\n\n${await snapshotPage({
        signal,
        workspacePath: workspace,
        runDir: context.runDir,
        tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined
      })}`
    }
    throwIfAborted(signal)
    return toolOk('browser_select_option', selector, content)
  },
  browser_hover: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const selector = args.selector as string
    const content = await hoverSelector(selector, {
      signal,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      settleMs: typeof args.settleMs === 'number' ? args.settleMs : undefined,
      workspacePath: workspace,
      includeSnapshot: args.includeSnapshot === true,
      runDir: context.runDir
    })
    throwIfAborted(signal)
    return toolOk('browser_hover', selector, content)
  },
  browser_wait_for_text: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const text = args.text as string
    const content = await waitForText(text, {
      signal,
      regex: args.regex === true,
      timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      workspacePath: workspace
    })
    throwIfAborted(signal)
    return toolOk('browser_wait_for_text', text.slice(0, 80), content)
  },
  browser_handle_dialog: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const action = args.action
    if (action !== 'accept' && action !== 'dismiss') {
      return toolFail('browser_handle_dialog', 'dialog', 'action must be accept|dismiss')
    }
    const content = await handleDialog(action, {
      signal,
      promptText: typeof args.promptText === 'string' ? args.promptText : undefined,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      workspacePath: workspace
    })
    throwIfAborted(signal)
    return toolOk('browser_handle_dialog', action, content)
  },
  mcp_list_tools: (_workspace, args, signal, context) => {
    throwIfAborted(signal)
    const filter = optionalMcpServerId(args)?.toLowerCase() ?? ''
    const enabled = context.runEnabledMcpIds
    const stepCatalog = context.stepMcpToolNames
    const defs = listMcpToolDefinitions().filter((t) => {
      const parsed = parseMcpToolName(t.name)
      if (!parsed) return false
      if (filter && parsed.serverId.toLowerCase() !== filter) return false
      if (enabled && !enabled.has(parsed.serverId)) return false
      return true
    })
    if (defs.length === 0) {
      const statuses = getMcpServerStatus(resolveEffectiveMcpServers()).filter((s) => {
        if (!s.enabled) return false
        if (enabled && !enabled.has(s.id)) return false
        if (filter && s.id.toLowerCase() !== filter) return false
        return true
      })
      const down = statuses.filter((s) => !s.connected)
      if (down.length > 0) {
        const lines = down.map(
          (s) => `- ${s.id}${s.error ? `: ${s.error}` : ': not connected'}`
        )
        return toolFail(
          'mcp_list_tools',
          filter || 'mcp',
          [
            'Enabled MCP server(s) are configured but not connected:',
            ...lines,
            '',
            'Fix in Marketplace → Manage (ensure uv/uvx is on PATH), then Refresh MCP connections.'
          ].join('\n')
        )
      }
      const none = filter
        ? `No MCP tools matching serverId=${filter}`
        : 'No MCP tools connected.'
      return toolOk('mcp_list_tools', filter || 'none', none)
    }
    const lines = defs.map((t) => {
      const hint = getMcpReadOnlyHint(t.name)
      const hintNote =
        hint === true ? ' readOnlyHint=true' : hint === false ? ' readOnlyHint=false' : ''
      const omitted =
        stepCatalog && !stepCatalog.has(t.name) ? ' [omitted from this step catalog]' : ''
      const desc = (t.description || '').replace(/\s+/g, ' ').trim().slice(0, 160)
      return `- ${t.name}${hintNote}${omitted}${desc ? `: ${desc}` : ''}`
    })
    return toolOk('mcp_list_tools', `${defs.length} tools`, lines.join('\n'))
  },
  request_mcp_tools: (_workspace, args, signal, context) => {
    throwIfAborted(signal)
    const pinned = context.runPinnedMcpToolNames
    if (!pinned) {
      return toolFail(
        'request_mcp_tools',
        'pin',
        'request_mcp_tools requires an active agent run.'
      )
    }
    const serverId =
      (typeof args.serverId === 'string' && args.serverId.trim()) ||
      (typeof args.server_id === 'string' && args.server_id.trim()) ||
      ''
    const requested = Array.isArray(args.tools)
      ? args.tools.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      : []
    if (!serverId && requested.length === 0) {
      return toolFail(
        'request_mcp_tools',
        'pin',
        'Provide tools: string[] and/or serverId to pin MCP tools for the next step.'
      )
    }
    const enabled = context.runEnabledMcpIds
    const connected = listMcpToolDefinitions().filter((t) => {
      const parsed = parseMcpToolName(t.name)
      if (!parsed) return false
      if (enabled && !enabled.has(parsed.serverId)) return false
      return true
    })
    const byFull = new Map(connected.map((t) => [t.name, t]))
    const byBare = new Map<string, string[]>()
    for (const t of connected) {
      const parsed = parseMcpToolName(t.name)
      if (!parsed) continue
      const list = byBare.get(parsed.toolName) ?? []
      list.push(t.name)
      byBare.set(parsed.toolName, list)
    }

    const newlyPinned: string[] = []
    const unknown: string[] = []
    const already: string[] = []

    const notes: string[] = []
    if (serverId) {
      const fromServer = connected.filter((t) => {
        const parsed = parseMcpToolName(t.name)
        return parsed?.serverId.toLowerCase() === serverId.toLowerCase()
      })
      if (fromServer.length === 0) {
        notes.push(`No connected MCP tools for serverId=${serverId}.`)
      }
      for (const t of fromServer) {
        if (pinned.has(t.name)) already.push(t.name)
        else {
          pinned.add(t.name)
          newlyPinned.push(t.name)
        }
      }
    }

    const sticky = context.runStickyToolNames
    const newlyPinnedBuiltins: string[] = []

    for (const raw of requested) {
      const name = raw.trim()
      if (byFull.has(name)) {
        if (pinned.has(name)) already.push(name)
        else {
          pinned.add(name)
          newlyPinned.push(name)
        }
        continue
      }
      const bareMatches = byBare.get(name) ?? []
      if (bareMatches.length === 1) {
        const full = bareMatches[0]!
        if (pinned.has(full)) already.push(full)
        else {
          pinned.add(full)
          newlyPinned.push(full)
        }
        continue
      }
      if (bareMatches.length > 1) {
        unknown.push(`${name} (ambiguous: ${bareMatches.join(', ')})`)
        continue
      }
      const builtinName = optionalBuiltinCatalogName(name)
      if (builtinName) {
        if (!sticky) {
          unknown.push(`${builtinName} (no sticky catalog — requires an active run step)`)
          continue
        }
        if (sticky.has(builtinName)) already.push(builtinName)
        else {
          sticky.add(builtinName)
          newlyPinnedBuiltins.push(builtinName)
        }
        continue
      }
      unknown.push(name)
    }

    if (newlyPinned.length > 0) {
      const stamp = Math.max(context.currentStep ?? 1, 1)
      const lastUsed = context.mcpLastUsedByName
      if (lastUsed) {
        for (const name of newlyPinned) lastUsed.set(name, stamp)
      }
    }
    if (newlyPinned.length > 0 || newlyPinnedBuiltins.length > 0) {
      context.invalidateMcpToolCatalogCache?.()
    }

    const allNew = [...newlyPinned, ...newlyPinnedBuiltins]
    const lines = [
      allNew.length
        ? `Pinned for next step (${allNew.length}): ${allNew.join(', ')}`
        : 'No new tools pinned.',
      already.length ? `Already pinned: ${already.join(', ')}` : '',
      unknown.length ? `Unknown / unresolved: ${unknown.join(', ')}` : '',
      ...notes,
      'Connected MCP tools are already in the step catalog. Pins are optional bookkeeping; call release_mcp_tools when finished.'
    ].filter(Boolean)
    return toolOk(
      'request_mcp_tools',
      `${allNew.length} pinned`,
      lines.join('\n')
    )
  },
  release_mcp_tools: (_workspace, args, signal, context) => {
    throwIfAborted(signal)
    const pinned = context.runPinnedMcpToolNames
    if (!pinned) {
      return toolFail(
        'release_mcp_tools',
        'release',
        'release_mcp_tools requires an active agent run.'
      )
    }
    const serverId =
      (typeof args.serverId === 'string' && args.serverId.trim()) ||
      (typeof args.server_id === 'string' && args.server_id.trim()) ||
      ''
    const requested = Array.isArray(args.tools)
      ? args.tools.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      : []
    if (!serverId && requested.length === 0) {
      return toolFail(
        'release_mcp_tools',
        'release',
        'Provide tools: string[] and/or serverId to release pinned MCP tools.'
      )
    }

    const toRelease = new Set<string>()
    const unknown: string[] = []
    const notes: string[] = []

    if (serverId) {
      const needle = serverId.toLowerCase()
      let found = 0
      for (const name of pinned) {
        const parsed = parseMcpToolName(name)
        if (parsed?.serverId.toLowerCase() === needle) {
          toRelease.add(name)
          found++
        }
      }
      if (found === 0) {
        notes.push(`No pinned MCP tools for serverId=${serverId}.`)
      }
    }

    const sticky = context.runStickyToolNames
    const releasedBuiltins: string[] = []

    for (const raw of requested) {
      const name = raw.trim()
      if (pinned.has(name) || toRelease.has(name)) {
        toRelease.add(name)
        continue
      }
      const bareMatches = [...pinned].filter((full) => {
        const parsed = parseMcpToolName(full)
        return parsed?.toolName === name
      })
      if (bareMatches.length === 1) {
        toRelease.add(bareMatches[0]!)
        continue
      }
      if (bareMatches.length > 1) {
        unknown.push(`${name} (ambiguous: ${bareMatches.join(', ')})`)
        continue
      }
      const builtinName = optionalBuiltinCatalogName(name)
      if (builtinName) {
        if (sticky?.has(builtinName)) {
          sticky.delete(builtinName)
          releasedBuiltins.push(builtinName)
        } else {
          unknown.push(`${builtinName} (not in sticky catalog)`)
        }
        continue
      }
      unknown.push(name)
    }

    const released: string[] = []
    for (const name of toRelease) {
      if (!pinned.has(name)) continue
      pinned.delete(name)
      context.mcpLastUsedByName?.delete(name)
      released.push(name)
    }

    const allReleased = [...released, ...releasedBuiltins]
    if (allReleased.length > 0) context.invalidateMcpToolCatalogCache?.()

    const lines = [
      allReleased.length
        ? `Released (${allReleased.length}): ${allReleased.join(', ')}`
        : 'No pinned tools released.',
      unknown.length ? `Unknown / unresolved: ${unknown.join(', ')}` : '',
      ...notes,
      'Pins are optional bookkeeping. Re-pin with request_mcp_tools if needed.'
    ].filter(Boolean)
    return toolOk(
      'release_mcp_tools',
      `${allReleased.length} released`,
      lines.join('\n')
    )
  },
  mcp_list_resources: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const serverId = optionalMcpServerId(args)
    if (serverId) {
      const gate = mcpServerGate('mcp_list_resources', serverId, serverId, context, workspace)
      if (!gate.ok) return gate.result
    }
    const entries = await listMcpResources(
      serverId,
      context.runEnabledMcpIds,
      signal,
      workspace
    )
    if (entries.length === 0) {
      const none = serverId
        ? `No MCP resources for server ${serverId}`
        : 'No MCP resources connected.'
      return toolOk('mcp_list_resources', serverId || 'none', none)
    }
    return toolOk(
      'mcp_list_resources',
      `${entries.length} resources`,
      formatMcpResourceLines(entries)
    )
  },
  mcp_read_resource: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const serverId = typeof args.serverId === 'string' ? args.serverId.trim() : ''
    const uri = typeof args.uri === 'string' ? args.uri.trim() : ''
    if (!serverId) return toolFail('mcp_read_resource', uri || 'resource', 'serverId is required')
    if (!uri) return toolFail('mcp_read_resource', serverId, 'uri is required')
    const gate = mcpServerGate('mcp_read_resource', serverId, uri, context, workspace)
    if (!gate.ok) return gate.result
    const result = await readMcpResource(
      serverId,
      uri,
      signal,
      context.runEnabledMcpIds,
      workspace
    )
    if (!result.ok) return toolFail('mcp_read_resource', uri, result.error)
    return toolOk('mcp_read_resource', uri, result.content)
  },
  mcp_list_prompts: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const serverId = optionalMcpServerId(args)
    if (serverId) {
      const gate = mcpServerGate('mcp_list_prompts', serverId, serverId, context, workspace)
      if (!gate.ok) return gate.result
    }
    const entries = await listMcpPrompts(
      serverId,
      context.runEnabledMcpIds,
      signal,
      workspace
    )
    if (entries.length === 0) {
      const none = serverId
        ? `No MCP prompts for server ${serverId}`
        : 'No MCP prompts connected.'
      return toolOk('mcp_list_prompts', serverId || 'none', none)
    }
    return toolOk('mcp_list_prompts', `${entries.length} prompts`, formatMcpPromptLines(entries))
  },
  mcp_get_prompt: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const serverId = typeof args.serverId === 'string' ? args.serverId.trim() : ''
    const name = typeof args.name === 'string' ? args.name.trim() : ''
    if (!serverId) return toolFail('mcp_get_prompt', name || 'prompt', 'serverId is required')
    if (!name) return toolFail('mcp_get_prompt', serverId, 'name is required')
    const gate = mcpServerGate('mcp_get_prompt', serverId, name, context, workspace)
    if (!gate.ok) return gate.result
    const promptArgs =
      args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
        ? Object.fromEntries(
            Object.entries(args.arguments).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string'
            )
          )
        : undefined
    const result = await getMcpPrompt(
      serverId,
      name,
      promptArgs,
      signal,
      context.runEnabledMcpIds,
      workspace
    )
    if (!result.ok) return toolFail('mcp_get_prompt', name, result.error)
    return toolOk('mcp_get_prompt', name, result.content)
  },
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
        : `Mode switched from ${previous} to ${mode}. Tool availability updated for subsequent steps.`
    return toolOk('switch_mode', mode, content)
  },
  terminal: async (workspace, args, signal, context) => {
    const command = typeof args.command === 'string' ? args.command : ''
    // Command present: ignore session_id (including invented UUIDs) and run the command.
    const sessionId =
      command.trim()
        ? ''
        : typeof args.session_id === 'string' && args.session_id.trim()
          ? args.session_id.trim()
          : ''
    const shell = context.terminalShell ?? getSettings().terminalShell ?? 'auto'
    const pattern = typeof args.pattern === 'string' ? args.pattern : undefined
    const onOutput = context.onTerminalOutput
    const workingDirectory =
      typeof args.working_directory === 'string' && args.working_directory.trim()
        ? args.working_directory.trim()
        : ''
    const cwd = workingDirectory
      ? resolveInsideWorkspace(workspace, workingDirectory)
      : workspace

    const requested = typeof args.timeoutMs === 'number' ? args.timeoutMs : TERMINAL_DEFAULT_TIMEOUT_MS
    const timeoutMs = Math.max(1, requested)

    // Prefer the session path whenever we have run ownership: wait expiry keeps
    // the process alive and returns session_id (poll) instead of killing it.
    // Legacy kill-on-timeout toolTerminal is only for callers without a run.
    const runId = context.runId
    const invokeId = context.invokeId
    const canUseSession = Boolean(runId && invokeId != null)
    const useSessionApi =
      Boolean(sessionId) || typeof args.block_until_ms === 'number' || (canUseSession && Boolean(command.trim()))

    if (useSessionApi) {
      if (!runId || invokeId == null) {
        return toolFail('terminal', 'session', 'Background terminal requires run ownership')
      }
      const blockUntilMs = sessionId
        ? resolveSessionPollBlockUntilMs(args)
        : resolveNewCommandBlockUntilMs(args)
      // A foreground new command (no explicit ceiling / no background request)
      // should wait for completion and be hard-killed at the ceiling if it
      // never finishes, rather than silently left running. Explicit windows or
      // polls keep the soft-timeout (leave-running, pollable session) behavior.
      const defaultWait = args.timeoutMs == null && args.block_until_ms == null
      const watchCtx: CheckpointWatchContext = {
        runDir: context.runDir,
        skipWriteCheckpoint: context.skipWriteCheckpoint
      }
      const content = sessionId
        ? await pollTerminalSession({
            runId,
            invokeId,
            sessionId,
            blockUntilMs,
            pattern,
            signal,
            runSignal: context.runSignal,
            onOutput
          })
        : await withBackgroundTerminalCheckpointWatch(
            workspace,
            command,
            watchCtx,
            (registerExitFinalize) =>
              startBackgroundTerminal({
                runId,
                invokeId,
                workspaceRoot: workspace,
                cwd,
                command,
                signal,
                shell,
                pattern,
                blockUntilMs,
                killOnTimeout: defaultWait,
                onOutput,
                onStillRunning: registerExitFinalize
              })
          )
      // New background command may mutate the tree; pure session polls do not.
      if (!sessionId) {
        invalidateAfterWorkspaceMutation(workspace)
      }
      const summary = terminalResultSummary(command, sessionId, content)
      const ok = terminalResultOk(command || 'session', content)
      if (ok) return toolOk('terminal', summary, content)
      return toolFail('terminal', summary, content)
    }

    const watchCtx: CheckpointWatchContext = {
      runDir: context.runDir,
      skipWriteCheckpoint: context.skipWriteCheckpoint
    }
    const content = await withTerminalCheckpointWatch(workspace, command, watchCtx, () =>
      toolTerminal(workspace, command, signal, {
        timeoutMs,
        shell,
        cwd,
        onOutput
      })
    )
    invalidateAfterWorkspaceMutation(workspace)
    const summary = command.slice(0, 80)
    const ok = terminalResultOk(command, content)
    if (ok) return toolOk('terminal', summary, content)
    return toolFail('terminal', summary, content)
  },
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
  memory_write: async (workspace, args, signal) => {
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
  git_status: async (workspace, _args, signal) => {
    throwIfAborted(signal)
    const content = await toolGitStatusAsync(workspace)
    throwIfAborted(signal)
    return toolOk('git_status', 'git status', content)
  },
  git_diff: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const path = typeof args.path === 'string' ? args.path : undefined
    const staged = args.staged === true
    const result = await toolGitDiffAsync(workspace, { path, staged })
    throwIfAborted(signal)
    const summary = path ? `git diff ${path}` : staged ? 'git diff --staged' : 'git diff'
    // Match git_status: non-repo is informative ok content, not a hard tool failure.
    if (!result.ok && result.content === 'Not a git repository') {
      return toolOk('git_diff', summary, result.content)
    }
    if (!result.ok) return toolFail('git_diff', summary, result.content)
    return toolOk('git_diff', summary, result.content)
  },
  git_commit: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const message = readTrimmed(args, 'message')
    if (!message) return toolFail('git_commit', 'git commit', 'Commit message is required')
    const push = args.push === true
    const extraPaths = Array.isArray(args.paths)
      ? args.paths.filter((p): p is string => typeof p === 'string')
      : []
    try {
      // Scope staging to files this run actually changed (plus any paths the
      // model names explicitly) so unrelated user edits are not swept into
      // the commit. Refuse an empty scope — never fall back to staging all.
      const touched = new Set<string>([...(context.mutationPaths ?? []), ...extraPaths])
      if (touched.size === 0) {
        return toolFail(
          'git_commit',
          'git commit',
          'No run-touched files to commit. Pass paths: [...] for explicit paths, or edit/delete files in this run first.'
        )
      }
      const summary = push ? 'git commit + push' : 'git commit'
      const lines: string[] = []
      const outcome = await commitPaths(workspace, message, push, [...touched])
      const committed = outcome.committed
      const pushed = outcome.pushed
      lines.push(
        outcome.detail,
        `committed: ${outcome.committed}`,
        `pushed: ${outcome.pushed}`,
        `message: ${message}`
      )
      if (outcome.skipped.length > 0) {
        const shown = outcome.skipped.slice(0, 20)
        const more = outcome.skipped.length - shown.length
        lines.push(
          `left uncommitted (${outcome.skipped.length} unrelated dirty path${outcome.skipped.length === 1 ? '' : 's'}): ${shown.join(', ')}${more > 0 ? `, +${more} more` : ''}`,
          'To include any of these, call git_commit again with paths: [...].'
        )
      }
      if (committed) invalidateAfterWorkspaceMutation(workspace)
      return toolOk('git_commit', summary, lines.join('\n'))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return toolFail('git_commit', 'git commit', msg)
    }
  },
  git_apply: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const result = await toolApplyPatchAsync(workspace, args, signal)
    throwIfAborted(signal)
    if (!result.ok) return toolFail('git_apply', result.summary, result.content)
    invalidateAfterWorkspaceMutation(workspace)
    return toolOk('git_apply', result.summary, result.content)
  },
  github_pr_create: async (workspace, args, signal) => {
    throwIfAborted(signal)
    try {
      const result = await prCreate(workspace, { draft: args.draft !== false })
      throwIfAborted(signal)
      return toolOk(
        'github_pr_create',
        result.url,
        [result.detail, result.url].filter(Boolean).join('\n')
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return toolFail('github_pr_create', 'gh pr create', msg)
    }
  },
  github_pr_review: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const event = args.event as 'approve' | 'request-changes' | 'comment'
    try {
      const result = await reviewPullRequest(
        workspace,
        event,
        typeof args.body === 'string' ? args.body : undefined,
        typeof args.number === 'number' ? args.number : undefined
      )
      throwIfAborted(signal)
      return toolOk('github_pr_review', event, result.detail)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return toolFail('github_pr_review', 'gh pr review', msg)
    }
  },
  github_issue: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const action = args.action as 'list' | 'create'
    try {
      if (action === 'list') {
        const result = await listGithubIssues(workspace)
        throwIfAborted(signal)
        const lines = result.issues.map(
          (issue) => `#${issue.number} ${issue.state} ${issue.title} ${issue.url}`
        )
        return toolOk(
          'github_issue',
          'list',
          lines.length > 0 ? lines.join('\n') : 'No open issues.'
        )
      }
      const title = typeof args.title === 'string' ? args.title.trim() : ''
      if (!title) return toolFail('github_issue', 'create', 'title is required when action is create')
      const result = await createGithubIssue(
        workspace,
        title,
        typeof args.body === 'string' ? args.body : undefined
      )
      throwIfAborted(signal)
      return toolOk('github_issue', result.url, `${result.detail}\n${result.url}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return toolFail('github_issue', `gh issue ${action}`, msg)
    }
  },
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
  spawn_agent_instance: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    if (!context.runId) {
      return toolFail('spawn_agent_instance', 'spawn', 'spawn_agent_instance requires an active run')
    }
    const goal = readString(args, 'goal')
    if (!goal) return toolFail('spawn_agent_instance', 'spawn', 'goal is required')
    const outcome = readString(args, 'outcome')
    if (!outcome) return toolFail('spawn_agent_instance', 'spawn', 'outcome is required')
    const doneWhen = readString(args, 'done_when')
    if (!doneWhen) return toolFail('spawn_agent_instance', 'spawn', 'done_when is required')
    const subTasks = Array.isArray(args.sub_tasks)
      ? args.sub_tasks.filter((t): t is string => typeof t === 'string')
      : []
    if (subTasks.length === 0) {
      return toolFail(
        'spawn_agent_instance',
        'spawn',
        'sub_tasks must be a non-empty array of strings'
      )
    }
    const result = await spawnAgentInstance({
      parentRunId: context.runId,
      workspacePath: workspace,
      goal,
      outcome,
      subTasks,
      doneWhen,
      pathScope: Array.isArray(args.path_scope)
        ? args.path_scope.filter((p): p is string => typeof p === 'string')
        : undefined,
      emitParentEvent: context.emitAgentEvent
    })
    if (!result.ok) return toolFail('spawn_agent_instance', 'spawn', result.error)
    const branchLine = result.worktreeBranch
      ? `\nworktree_branch: ${result.worktreeBranch}\nWhen done, merge one branch at a time with merge_agent_instance (parent must be clean).`
      : ''
    return toolOk(
      'spawn_agent_instance',
      result.label,
      `${result.label}\nrun_id: ${result.runId}${branchLine}`
    )
  },
  await_agent_instance: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    if (!context.runId) {
      return toolFail('await_agent_instance', 'await', 'await_agent_instance requires an active run')
    }
    const childRunId = readString(args, 'run_id')
    if (!childRunId) return toolFail('await_agent_instance', 'await', 'run_id is required')
    const childDir = resolveRunDir(workspace, childRunId)
    const childStatus = loadStatus(childDir)
    if (!childStatus?.inlineInstance || childStatus.parentRunId !== context.runId) {
      return toolFail(
        'await_agent_instance',
        formatAgentInstanceLabel(childRunId),
        'run_id is not an inline instance spawned by this parent run'
      )
    }
    const timeoutMs =
      typeof args.timeout_ms === 'number' && Number.isFinite(args.timeout_ms)
        ? Math.max(1_000, Math.floor(args.timeout_ms))
        : AWAIT_AGENT_INSTANCE_MAX_MS
    try {
      const terminal = await waitForChildTerminal(childRunId, workspace, timeoutMs, signal)
      const label = formatAgentInstanceLabel(childRunId)
      const branch = loadStatus(childDir)?.worktreeBranch
      const branchLine = branch ? `\nworktree_branch: ${branch}` : ''
      return toolOk(
        'await_agent_instance',
        label,
        `${label}\nphase: ${terminal.phase}${branchLine}\n\n${terminal.summary}`
      )
    } catch (err) {
      throwIfAborted(signal)
      const msg = err instanceof Error ? err.message : String(err)
      return toolFail('await_agent_instance', formatAgentInstanceLabel(childRunId), msg)
    }
  },
  pull_agent_instance: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    if (!context.runId) {
      return toolFail('pull_agent_instance', 'pull', 'pull_agent_instance requires an active run')
    }
    const childRunId = readString(args, 'run_id')
    if (!childRunId) return toolFail('pull_agent_instance', 'pull', 'run_id is required')
    const childDir = resolveRunDir(workspace, childRunId)
    const childStatus = loadStatus(childDir)
    if (!childStatus?.inlineInstance || childStatus.parentRunId !== context.runId) {
      return toolFail(
        'pull_agent_instance',
        formatAgentInstanceLabel(childRunId),
        'run_id is not an inline instance spawned by this parent run'
      )
    }
    const viewRaw = readString(args, 'view')
    const view: PullAgentInstanceView =
      viewRaw === 'outline' || viewRaw === 'tail' ? viewRaw : 'summary'
    const content = await pullChildRun(workspace, childRunId, view)
    return toolOk('pull_agent_instance', formatAgentInstanceLabel(childRunId), content)
  },
  merge_agent_instance: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    if (!context.runId) {
      return toolFail('merge_agent_instance', 'merge', 'merge_agent_instance requires an active run')
    }
    const childRunId = readString(args, 'run_id')
    if (!childRunId) return toolFail('merge_agent_instance', 'merge', 'run_id is required')
    const result = await mergeAgentInstanceBranch(workspace, context.runId, childRunId)
    if (!result.ok) {
      return toolFail('merge_agent_instance', formatAgentInstanceLabel(childRunId), result.error)
    }
    invalidateAfterWorkspaceMutation(workspace)
    return toolOk('merge_agent_instance', formatAgentInstanceLabel(childRunId), result.detail)
  },
  cancel_agent_instance: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    if (!context.runId) {
      return toolFail('cancel_agent_instance', 'cancel', 'cancel_agent_instance requires an active run')
    }
    const childRunId = readString(args, 'run_id')
    if (!childRunId) return toolFail('cancel_agent_instance', 'cancel', 'run_id is required')
    const result = cancelChildInstance(workspace, context.runId, childRunId)
    const label = formatAgentInstanceLabel(childRunId)
    if (!result.ok) return toolFail('cancel_agent_instance', label, result.error)
    if (result.phase === 'already-terminal') {
      const status = loadStatus(resolveRunDir(workspace, childRunId))?.status ?? 'unknown'
      return toolOk('cancel_agent_instance', label, `${label}\nphase: already-terminal (${status})`)
    }
    return toolOk(
      'cancel_agent_instance',
      label,
      `${label}\nphase: cancelling\n\nInstance cancelled. Its partial output is available via pull_agent_instance.`
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
    if (mcpResult.ok && context.mutationPaths) {
      applyMcpFilesystemMutations(context.mutationPaths, mcp.serverId, mcp.toolName, parsed)
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
