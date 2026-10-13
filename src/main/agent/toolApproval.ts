import { randomUUID } from 'crypto'
import { homedir } from 'os'
import path from 'path'
import type {
  PermissionRule,
  TerminalShell,
  ToolApprovalDecision,
  ToolApprovalGrant,
  ToolApprovalMode,
  ToolApprovalRequest,
  ToolApprovalResponse
} from '../../shared/ipc'
import { isAbortError } from '../../shared/errors'
import { logger } from '../../shared/logger'
import { summarizeToolArgs } from '../../shared/toolSummary'
import { scrubString } from '../../shared/utils/scrub'
import {
  commandAllowKey,
  commandAllowPrefix,
  commandAllowProgram,
  commandFromAllowKey,
  commandMatchesAllow,
  terminalCommandOf
} from '../../shared/utils/commandAllow'
import { isMcpServerToolName } from '../../shared/mcpApps'
import { BUILTIN_TOOL_NAMES, canonicalizeAgentToolName } from './schemas/tools'
import { isApprovalExemptTool } from './tools/classify'
import { agentBuiltToolAllowKey } from './agentTools/loader'
import { resolveAgentToolsDir } from './agentTools/paths'
import { ASK_SAFE_BUILTIN } from './tools/modePolicy'
import { registerRunCancelHooks, streamSignalFor } from './runRegistry'
import { dismissLifecycleNotification } from '../notifications/bus'
import { notifyBadgeChange } from '../app/badges'
import { needsYouDedupeKey } from '../../shared/ipc'
import { TOOL_APPROVAL_TIMEOUT_MS } from '../../shared/agentTimeouts'
import { isCheckCommand } from './feedback/checkCommands'
import { buildApprovalChangePreview } from './approvalChangePreview'
import { dangerousCommand, type CommandContext, type DangerousCommand } from './tools/dangerousCommand'
import { resolveTerminalShell } from './tools/terminal'
import type { ActiveSkillAllows, PermissionPolicy, PermissionVerdict } from './permissions'
import type { SkillToolGrant } from './skills/allowedTools'

/** Browse/fetch egress — gated, but not workspace-mutating: the agent's
 * browser (`browser_*`) and the `web_fetch` / `web_search` tools.
 */
function isNetworkBrowseTool(name: string): boolean {
  return (name.startsWith('browser_') || name.startsWith('web_')) && ASK_SAFE_BUILTIN.has(name)
}

export type ApprovalSender = (request: ToolApprovalRequest) => void

/** Default wait for user approval before auto-denying (15 minutes). */
export { TOOL_APPROVAL_TIMEOUT_MS } from '../../shared/agentTimeouts'

/** One sender per run: approval prompts belong to the window that started it. */
const senders = new Map<string, ApprovalSender>()
const pending = new Map<
  string,
  {
    resolve: (decision: ToolApprovalDecision) => void
    /** Clears timeout/abort listeners then rejects — used by cancelPendingApprovals. */
    cancel: (err: Error) => void
    runId: string
    invokeId?: number
    /** When the request started waiting — the navigator's "waiting 3m". */
    requestedAt: string
    request: ToolApprovalRequest
  }
>()

function abortApprovalError(): Error {
  const err = new Error('Aborted')
  err.name = 'AbortError'
  return err
}

/**
 * Register (or replace) the window that receives approval prompts for a run.
 * Re-pushes any still-pending approvals so a remounted renderer can show cards.
 */
export function registerApprovalSender(runId: string, sender: ApprovalSender): () => void {
  senders.set(runId, sender)
  for (const entry of pending.values()) {
    if (entry.runId === runId) sender(entry.request)
  }
  return () => {
    if (senders.get(runId) === sender) senders.delete(runId)
  }
}

/** Pending approval payloads still waiting on the user for this run. */
export function listPendingToolApprovals(runId: string): ToolApprovalRequest[] {
  const out: ToolApprovalRequest[] = []
  for (const entry of pending.values()) {
    if (entry.runId === runId) out.push(entry.request)
  }
  return out
}

/** When this run's longest-waiting approval started waiting, or undefined when none is. */
export function oldestPendingToolApprovalAt(runId: string): string | undefined {
  let oldest: string | undefined
  for (const entry of pending.values()) {
    if (entry.runId !== runId) continue
    if (oldest === undefined || entry.requestedAt < oldest) oldest = entry.requestedAt
  }
  return oldest
}

/**
 * Listeners for approvals being asked and settled (voice mode reads them out
 * and takes a spoken yes/no; docs/voice-mode.md §7.5). Read-only: a watcher
 * answers through `resolveToolApproval` like the card does.
 */
export type ToolApprovalWatcher = {
  asked: (request: ToolApprovalRequest) => void
  settled: (requestId: string, runId: string) => void
}
const approvalWatchers = new Set<ToolApprovalWatcher>()

export function watchToolApprovals(watcher: ToolApprovalWatcher): () => void {
  approvalWatchers.add(watcher)
  return () => approvalWatchers.delete(watcher)
}

function tellWatchers(fn: (w: ToolApprovalWatcher) => void): void {
  for (const w of [...approvalWatchers]) {
    try {
      fn(w)
    } catch {
      /* a watcher's failure is its own */
    }
  }
}

/** Total approvals waiting across all runs — drives the taskbar badge. */
export function countPendingToolApprovals(): number {
  return pending.size
}

/** Returns false when the request is unknown or runId does not match. */
export function resolveToolApproval(response: ToolApprovalResponse): boolean {
  const entry = pending.get(response.requestId)
  if (!entry) return false
  if (entry.runId !== response.runId) return false
  // A note rides only on Deny, an edit only on Allow once of a command the
  // card let you edit (not one the guard stopped).
  const note = response.decision === 'deny' ? response.note : undefined
  const editedCommand =
    response.decision === 'once' && entry.request.name === 'terminal' && !entry.request.danger
      ? response.editedCommand
      : undefined
  // The folder is the one main named in the request, never one the response brings.
  const allowFolder =
    response.decision === 'always' && response.allowFolder && !entry.request.danger
      ? entry.request.alwaysAllowFolder
      : undefined
  // Likewise the program is the one main offered, never one the response names.
  const allowProgram =
    response.decision === 'always' && response.allowProgram && !entry.request.danger
      ? entry.request.alwaysAllowProgram
      : undefined
  if (note || editedCommand || allowFolder || allowProgram) {
    responseExtras.set(response.requestId, {
      ...(note ? { note } : {}),
      ...(editedCommand ? { editedCommand } : {}),
      ...(allowFolder ? { allowFolder } : {}),
      ...(allowProgram ? { allowProgram } : {})
    })
  }
  entry.resolve(response.decision)
  dismissLifecycleNotification(needsYouDedupeKey(response.runId))
  return true
}

/**
 * Cancelling a run must not leave its approval prompts waiting forever.
 * When `invokeId` is set, only that turn's prompts are cleared — so a prior
 * turn's IPC `finally` cannot auto-abort the active follow-up turn.
 */
export function cancelPendingApprovals(runId: string, invokeId?: number): void {
  for (const [requestId, entry] of pending) {
    if (entry.runId !== runId) continue
    if (invokeId !== undefined && entry.invokeId !== invokeId) continue
    entry.cancel(abortApprovalError())
  }
  dismissLifecycleNotification(needsYouDedupeKey(runId))
}

/**
 * Allowlist key for an agent-built tool, or undefined for everything else.
 *
 * Builtins and MCP names short-circuit without touching disk, so the scan only
 * runs for a name nothing else claims — which is exactly the agent-built case.
 */
async function agentBuiltAllowKeyFor(name: string): Promise<string | undefined> {
  if (BUILTIN_NAME_SET.has(name) || isMcpServerToolName(name)) return undefined
  try {
    return (await agentBuiltToolAllowKey(await resolveAgentToolsDir(), name)) ?? undefined
  } catch {
    // A tool we cannot identify is not one we can grant a standing allow to;
    // falling through leaves it gated under its bare name.
    return undefined
  }
}

function parseArgs(argsJson: string | undefined): Record<string, unknown> | undefined {
  if (!argsJson) return undefined
  try {
    const parsed: unknown = JSON.parse(argsJson)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

export function isToolGated(
  name: string,
  mode: ToolApprovalMode,
  sessionAllowlist: ReadonlySet<string>,
  workspaceAllowlist: readonly string[],
  argsJson?: string,
  opts?: { mcpProtection?: boolean; agentBuiltAllowKey?: string }
): boolean {
  const canonical = canonicalizeAgentToolName(name)
  // The question form is itself the user gate — even "Ask for every tool" must
  // not put an approval card ("Wants to use asked") in front of it.
  if (canonical === 'ask_question') return false
  // An agent-built tool is allowlisted under `<name>@<contentHash>`, never its
  // bare name — the file behind the name can be rewritten by a later
  // build_tool call, and a standing allow must not follow it.
  const allowKey = opts?.agentBuiltAllowKey
  const allowNames = allowKey ? [allowKey] : [canonical, name]
  if (allowNames.some((entry) => sessionAllowlist.has(entry))) return false
  if (allowNames.some((entry) => workspaceAllowlist.includes(entry))) return false
  let args: Record<string, unknown> | undefined
  if (argsJson) {
    try {
      const parsed: unknown = JSON.parse(argsJson)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>
      }
    } catch {
      args = undefined
    }
  }
  if (canonical === 'terminal') {
    const command = terminalCommandOf(args)
    // Polling a session reads the output of a command already let through; it
    // starts nothing, and neither does stopping it. Input is new instructions
    // to that process (a shell reading stdin runs them), so it asks like a command.
    if (
      !command &&
      typeof args?.session_id === 'string' &&
      args.session_id.trim() &&
      !(typeof args.input === 'string' && args.input.length > 0)
    ) {
      return false
    }
    // "Always allow" for the terminal is per command: `terminal:pnpm vitest` lets
    // `pnpm vitest …` through, never a chained or redirected command.
    if (command) {
      for (const entry of [...sessionAllowlist, ...workspaceAllowlist]) {
        const prefix = commandFromAllowKey(entry)
        if (prefix && commandMatchesAllow(command, prefix)) return false
      }
    }
  }
  const mcpProtection = opts?.mcpProtection !== false
  if (mode === 'off') {
    // "Approvals off" is a judgement about the tools that shipped with the app.
    // An agent-built module is arbitrary Node this run wrote minutes ago, so it
    // stays gated here for the same reason an MCP server tool does.
    return Boolean(allowKey) || (mcpProtection && isMcpServerToolName(canonical))
  }
  if (mode === 'all') return true
  return !isApprovalExemptTool(canonical, args)
}

/** High-risk tools that stay gated in autonomous mode unless workspace-allowlisted. */
const BUILTIN_NAME_SET: ReadonlySet<string> = new Set<string>(BUILTIN_TOOL_NAMES)

export function isAutonomousHighRiskTool(name: string, argsJson?: string): boolean {
  const canonical = canonicalizeAgentToolName(name)
  if (canonical === 'lsp') {
    let action: unknown
    if (argsJson) {
      try {
        const parsed: unknown = JSON.parse(argsJson)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          action = (parsed as Record<string, unknown>).action
        }
      } catch {
        action = undefined
      }
    }
    return action === 'rename'
  }
  if (canonical === 'github_issue') {
    // Listing and reading change nothing; creating posts on GitHub under the account.
    let action: unknown
    if (argsJson) {
      try {
        const parsed: unknown = JSON.parse(argsJson)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          action = (parsed as Record<string, unknown>).action
        }
      } catch {
        action = undefined
      }
    }
    return action !== 'list' && action !== 'view'
  }
  if (canonical === 'run_tests') {
    // run_tests runs any sandboxed binary it is handed — `python -c …`, a
    // fetch script — while `terminal` stays gated here. Autonomy answers for
    // the project's own test runs only; anything else is asked like terminal.
    let args: Record<string, unknown> = {}
    if (argsJson) {
      try {
        const parsed: unknown = JSON.parse(argsJson)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>
        }
      } catch {
        args = {}
      }
    }
    const command = typeof args.command === 'string' ? args.command.trim() : ''
    const script = typeof args.script === 'string' ? args.script.trim() : ''
    if (command) return !isCheckCommand(command)
    if (script) return !isCheckCommand(`npm run ${script}`)
    return false
  }
  return (
    canonical === 'delete' ||
    canonical === 'move' ||
    canonical === 'terminal' ||
    canonical === 'edit' ||
    canonical === 'str_replace' ||
    canonical === 'edit_notebook' ||
    canonical === 'git_commit' ||
    // `git_apply` writes arbitrary files into the working tree, so leaving it
    // out made autonomy's promise false: an autonomous run refused `edit` and
    // `str_replace` at the prompt, then rewrote the same files through a patch
    // with no prompt at all.
    canonical === 'git_apply' ||
    canonical === 'github_pr_create' ||
    canonical === 'github_pr_review' ||
    canonical === 'github_issue' ||
    canonical === 'merge_agent_instance' ||
    // Writing a module that later runs as arbitrary Node in a utility process
    // is at least as consequential as an edit, and the approval card is the
    // only place anyone reads the code before it exists.
    canonical === 'build_tool' ||
    // It can see every other app on the user's screen, so autonomy never
    // answers for them.
    canonical === 'screen_snip' ||
    canonical.startsWith('mcp__') ||
    !(BUILTIN_TOOL_NAMES as readonly string[]).includes(canonical)
  )
}

/** Where a run's shell commands start and how its shell reads them — what the command guard needs. */
export type CommandGuard = Pick<CommandContext, 'workspaceRoot' | 'homeDir' | 'platform' | 'syntax'>

/**
 * The guard for a run in `workspace`: PowerShell and cmd read backslashes as
 * path separators, sh and bash (Git Bash on Windows too) as escapes.
 */
export function commandGuardFor(workspace: string, shell: TerminalShell | undefined): CommandGuard {
  const resolved = resolveTerminalShell(shell ?? 'auto')
  return {
    workspaceRoot: workspace,
    homeDir: homedir(),
    platform: process.platform,
    syntax: resolved === 'powershell' || resolved === 'cmd' ? 'windows' : 'posix'
  }
}

/**
 * The shell command a call runs and why it needs the user's OK whatever the
 * approval settings say, or null. `terminal` runs in its working_directory
 * (always inside the workspace); `run_tests` runs an explicit command from
 * the workspace root.
 */
export function guardedCommand(
  name: string,
  argsJson: string | undefined,
  guard: CommandGuard
): DangerousCommand | null {
  if (name !== 'terminal' && name !== 'run_tests') return null
  const args = parseArgs(argsJson)
  const command = typeof args?.command === 'string' ? args.command : ''
  if (!command.trim()) return null
  const lib = guard.platform === 'win32' ? path.win32 : path.posix
  const workingDirectory =
    name === 'terminal' && typeof args?.working_directory === 'string' ? args.working_directory.trim() : ''
  const cwd = workingDirectory ? lib.resolve(guard.workspaceRoot, workingDirectory) : guard.workspaceRoot
  return dangerousCommand(command, { ...guard, cwd })
}

/**
 * `grant` says who let a gated call through — the user on the card, or a
 * standing allow — and is saved on the call's result for the record. A call
 * the gate never held (exempt, approvals off, autonomy) has none.
 */
export type AuthorizeResult =
  | {
      allowed: true
      grant?: ToolApprovalGrant
      /** The call's arguments as the person edited them; it runs with these. */
      arguments?: string
      /** What the person changed, said to the agent with the result. */
      editNote?: string
    }
  | { allowed: false; reason: string }

/** A deny's note, an edited command and a chosen folder, by request id, until the gate reads them. */
const responseExtras = new Map<
  string,
  { note?: string; editedCommand?: string; allowFolder?: string; allowProgram?: string }
>()

/** The tools "Always allow edits under a folder" covers: the two that change a file in place. */
const FOLDER_ALLOW_TOOLS = ['edit', 'str_replace'] as const

/** A path the call names, workspace-relative with forward slashes; null when it is outside or absent. */
function workspaceRelPath(argsJson: string, workspaceRoot: string | undefined): string | null {
  const raw = parseArgs(argsJson)?.path
  if (typeof raw !== 'string' || !raw.trim()) return null
  let rel = raw.trim()
  if (path.isAbsolute(rel)) {
    if (!workspaceRoot) return null
    rel = path.relative(workspaceRoot, rel)
  }
  rel = rel.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!rel || rel.startsWith('../') || rel === '..' || path.isAbsolute(rel)) return null
  return rel
}

/** The top folder an edit sits in (`src` for `src/lib/a.ts`), or null for a file at the root. */
export function editAllowFolder(toolName: string, argsJson: string, workspaceRoot: string | undefined): string | null {
  if (!(FOLDER_ALLOW_TOOLS as readonly string[]).includes(toolName)) return null
  const rel = workspaceRelPath(argsJson, workspaceRoot)
  const slash = rel?.indexOf('/') ?? -1
  if (!rel || slash <= 0) return null
  const folder = rel.slice(0, slash)
  return folder === '.' || folder === '..' || folder.startsWith('.git') ? null : folder
}

/** The permission rules that stand for "always allow edits under `folder`". */
export function folderAllowRules(folder: string): PermissionRule[] {
  return FOLDER_ALLOW_TOOLS.map((tool) => ({ effect: 'allow' as const, tool, path: `${folder}/**` }))
}

/**
 * How long a card waits before the call is denied (Settings › Agent):
 * minutes, 0 for never. Set by the app; tests and headless keep the default.
 */
let approvalTimeoutMinutes: () => number = () => TOOL_APPROVAL_TIMEOUT_MS / 60_000

export function setApprovalTimeoutSource(source: () => number): void {
  approvalTimeoutMinutes = source
}

/** The wait in ms, or null for none. */
export function approvalTimeoutMs(): number | null {
  let minutes: number
  try {
    minutes = approvalTimeoutMinutes()
  } catch {
    minutes = TOOL_APPROVAL_TIMEOUT_MS / 60_000
  }
  if (!Number.isFinite(minutes) || minutes < 0) return TOOL_APPROVAL_TIMEOUT_MS
  return minutes === 0 ? null : Math.round(minutes * 60_000)
}

/** "pnpm test" with JSON quotes and backslashes as a model would read them. */
function quoteForAgent(text: string): string {
  return JSON.stringify(text.length > 2000 ? `${text.slice(0, 1999)}…` : text)
}

/** A remembered allow, bounded: a terminal prefix can be a long command. */
function grantAllow(key: string): string {
  return key.length > 200 ? `${key.slice(0, 199)}…` : key
}

const NO_ALLOWS: ReadonlySet<string> = new Set()

/**
 * The standing allow that let an ungated call through, or undefined when the
 * call would not have been held anyway. Pure — the same checks, minus lists.
 */
function ruleGrantFor(
  name: string,
  mode: ToolApprovalMode,
  taskAllowlist: ReadonlySet<string>,
  argsJson: string,
  opts: { mcpProtection?: boolean; agentBuiltAllowKey?: string }
): ToolApprovalGrant | undefined {
  if (!isToolGated(name, mode, NO_ALLOWS, [], argsJson, opts)) return undefined
  const byTask = !isToolGated(name, mode, taskAllowlist, [], argsJson, opts)
  return { by: 'rule', scope: byTask ? 'task' : 'workspace' }
}

/** Internal ask result: IPC decisions plus timeout auto-deny. */
type AskDecision = ToolApprovalDecision | 'timeout'

export type ToolApprovalGate = {
  authorize(call: {
    id: string
    name: string
    arguments: string
  }): Promise<AuthorizeResult>
  /**
   * True when grep/search must leave this workspace-relative file out of what
   * they return — a permission rule denies it or asks before it is read.
   */
  hidesFromSearch?(toolName: string, relPath: string): boolean
  /**
   * A skill loaded (the Skill tool) or was invoked (`/name`): its
   * `allowed-tools` pre-approve calls for the rest of this gate's invoke,
   * when the skill is one the user put there (skills/allowedTools.ts).
   */
  activateSkill?(skillName: string): void
}

export type ApprovalGateOptions = {
  runId: string
  /** ChatStart invoke that owns this gate; scopes cancelPendingApprovals. */
  invokeId?: number
  mode: ToolApprovalMode
  /**
   * When true (default), MCP server tools (`mcp__*`) stay gated even if `mode` is off.
   * Built-in MCP meta tools follow `mode` only.
   */
  mcpProtection?: boolean
  workspaceAllowlist: readonly string[]
  signal: AbortSignal
  /** When true, auto-approve gated tools except high-risk (delete, terminal, edits). */
  autonomousMode?: boolean
  /** Persists an "always allow" choice; omitted in tests and headless runs. */
  persistAlways?: (toolName: string) => void
  /** Persists "Always allow edits under a folder" as allow rules; omitted in tests and headless runs. */
  persistRules?: (rules: PermissionRule[]) => void
  /**
   * The task's standing "Allow for this task" grants, read back from its run
   * directory: one gate is built per run, and the grant covers follow-ups too.
   */
  taskAllowlist?: readonly string[]
  /** Persists an "Allow for this task" choice next to the task; omitted in tests. */
  persistTask?: (toolName: string) => void
  /** Overridable so tests can drive the decision without an Electron window. */
  ask?: (request: ToolApprovalRequest) => Promise<AskDecision>
  /**
   * Shell commands that can destroy work beyond a rewind (see
   * tools/dangerousCommand.ts) ask whatever `mode`, the allowlists or
   * autonomy say. Omitted only where no shell command can run.
   */
  commandGuard?: CommandGuard
  /**
   * Permission rules (permissions.ts), checked before everything else here:
   * a deny refuses the call, an ask puts the card in front of it whatever the
   * mode, allowlists or autonomy say, and an allow lets a gated call through
   * the way a standing allow does — never past the command guard.
   */
  permissions?: PermissionPolicy
  /**
   * What a skill's `allowed-tools` grant, by skill name — the Skill tool's own
   * resolution. Without it (or without `permissions`) no skill pre-approves.
   */
  skillGrants?: (skillName: string) => SkillToolGrant | null
}

function askThroughRenderer(
  request: ToolApprovalRequest,
  signal: AbortSignal,
  invokeId?: number
): Promise<AskDecision> {
  const sender = senders.get(request.runId)
  if (!sender) {
    logger.warn('Tool approval required but no window is listening', {
      scope: 'agent',
      code: 'TOOL_APPROVAL',
      correlationId: request.runId,
      tool: request.name
    })
    return Promise.reject(
      new Error(
        'Tool approval required but no app window is listening. Reopen Agent V and retry, or turn off tool approval in Settings → Agent.'
      )
    )
  }

  return new Promise<AskDecision>((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const clearWaiters = (): void => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId)
        timeoutId = undefined
      }
      signal.removeEventListener('abort', onAbort)
    }
    const settle = (decision: AskDecision): void => {
      if (settled || !pending.has(request.requestId)) return
      settled = true
      pending.delete(request.requestId)
      notifyBadgeChange()
      clearWaiters()
      tellWatchers((w) => w.settled(request.requestId, request.runId))
      resolve(decision)
    }
    const cancel = (err: Error): void => {
      if (settled || !pending.has(request.requestId)) return
      settled = true
      pending.delete(request.requestId)
      notifyBadgeChange()
      clearWaiters()
      tellWatchers((w) => w.settled(request.requestId, request.runId))
      reject(err)
    }
    function onAbort(): void {
      cancel(abortApprovalError())
    }
    if (signal.aborted) {
      reject(abortApprovalError())
      return
    }
    pending.set(request.requestId, {
      resolve: (decision) => settle(decision),
      cancel,
      runId: request.runId,
      invokeId,
      requestedAt: new Date().toISOString(),
      request
    })
    notifyBadgeChange()
    signal.addEventListener('abort', onAbort, { once: true })
    // No timer when the setting says to wait for an answer.
    if (request.timeoutMs != null && request.timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        if (!pending.has(request.requestId)) return
        settle('timeout')
      }, request.timeoutMs)
    }
    sender(request)
    tellWatchers((w) => w.asked(request))
  })
}

/**
 * Gate for one run.
 *
 * "Allow for this task" (the wire value is still `session`) starts from the
 * task's saved grants and is handed to `persistTask`, so the task's next run
 * builds its gate with it; "Always allow" goes to `persistAlways` and covers
 * every task in the workspace.
 */
export function createApprovalGate(options: ApprovalGateOptions): ToolApprovalGate {
  const sessionAllowlist = new Set<string>(options.taskAllowlist ?? [])
  const workspaceAllowlist = [...options.workspaceAllowlist]
  /** Folders chosen with "Always allow edits under" this run; saved rules cover later runs. */
  const allowedFolders: string[] = []
  const ask =
    options.ask ??
    ((request) =>
      askThroughRenderer(
        request,
        streamSignalFor(options.runId, options.signal),
        options.invokeId
      ))
  /** Skills active in this invoke whose allowed-tools are honoured, by lowercased name. */
  const activeSkills = new Map<string, ActiveSkillAllows>()

  return {
    activateSkill(skillName: string): void {
      if (!options.skillGrants || !options.permissions) return
      const key = skillName.trim().toLowerCase()
      if (!key || activeSkills.has(key)) return
      let grant: SkillToolGrant | null = null
      try {
        grant = options.skillGrants(skillName)
      } catch (err) {
        logger.warn('Skill allowed-tools could not be read', { scope: 'agent', correlationId: options.runId, tool: 'Skill', err })
        return
      }
      if (!grant || (grant.allows.length === 0 && grant.ignored.length === 0)) return
      if (!grant.trusted) {
        logger.info('Skill allowed-tools not honoured', {
          scope: 'agent',
          correlationId: options.runId,
          tool: 'Skill',
          reason: `skill ${grant.skill} (${grant.source}) is not one you installed; its allowed-tools still ask`
        })
        return
      }
      logger.info('Skill allowed-tools active', {
        scope: 'agent',
        correlationId: options.runId,
        tool: 'Skill',
        reason: `skill ${grant.skill}: ${grant.allows.map((a) => a.entry).join(', ') || 'none'}${
          grant.ignored.length ? `; ignored ${grant.ignored.join(', ')}` : ''
        }`
      })
      if (grant.allows.length > 0) activeSkills.set(key, { skill: grant.skill, allows: grant.allows })
    },
    async authorize(call): Promise<AuthorizeResult> {
      const name = canonicalizeAgentToolName(call.name)
      const agentBuiltAllowKey = await agentBuiltAllowKeyFor(name)
      // Permission rules come first: a deny refuses before anything can ask.
      let permission: PermissionVerdict | null = null
      if (options.permissions) {
        try {
          permission = options.permissions.evaluate(
            name,
            parseArgs(call.arguments),
            activeSkills.size > 0 ? { skills: [...activeSkills.values()] } : undefined
          )
        } catch (err) {
          // A rule that cannot be read must not wave the call through.
          logger.warn('Permission rules could not be checked', { scope: 'agent', correlationId: options.runId, tool: name, err })
          permission = { effect: 'ask', source: 'built-in', rule: 'unreadable rules', reason: 'The permission rules could not be checked for this call' }
        }
        // An agent-built tool's standing allow is pinned to its content hash;
        // a rule naming the tool must not follow a rewritten module.
        if (permission?.effect === 'allow' && agentBuiltAllowKey) permission = null
      }
      if (permission?.effect === 'deny') {
        logger.info('Tool call denied by permission rule', {
          scope: 'agent',
          correlationId: options.runId,
          tool: name,
          decision: 'deny',
          reason: `permission-rule:${permission.source}`
        })
        return { allowed: false, reason: permission.reason }
      }
      // Checked before every way past the card: the mode, the allowlists and
      // autonomy all answer for ordinary commands, never for these.
      const danger = options.commandGuard ? guardedCommand(name, call.arguments, options.commandGuard) : null
      // What holds the call at the card whatever else says — the command
      // guard, or an ask rule — and how the card and the model hear about it.
      const held: { reason: string; log: string; what: 'command' | 'call' } | null = danger
        ? { reason: danger.reason, log: `command-guard:${danger.kind}`, what: 'command' }
        : permission?.effect === 'ask'
          ? { reason: permission.reason, log: `permission-rule:${permission.source}`, what: 'call' }
          : null
      const gateOpts = { mcpProtection: options.mcpProtection, agentBuiltAllowKey }
      if (
        !held &&
        !isToolGated(name, options.mode, sessionAllowlist, workspaceAllowlist, call.arguments, gateOpts)
      ) {
        const grant = ruleGrantFor(name, options.mode, sessionAllowlist, call.arguments, gateOpts)
        return grant ? { allowed: true, grant } : { allowed: true }
      }
      const editFolder = held ? null : editAllowFolder(name, call.arguments, options.commandGuard?.workspaceRoot)
      if (editFolder && allowedFolders.includes(editFolder)) {
        return { allowed: true, grant: { by: 'you', scope: 'workspace', allow: grantAllow(`edits under ${editFolder}/`) } }
      }

      if (!held && permission?.effect === 'allow') {
        if (permission.source === 'skill') {
          logger.info('Tool call allowed by skill', {
            scope: 'agent',
            correlationId: options.runId,
            tool: name,
            decision: 'once',
            reason: `skill-allowed-tools:${permission.rule}`
          })
          return { allowed: true, grant: { by: 'skill', scope: 'once', allow: grantAllow(permission.skill ?? permission.rule) } }
        }
        return { allowed: true, grant: { by: 'rule', scope: 'workspace', allow: grantAllow(permission.rule) } }
      }

      if (
        !held &&
        options.autonomousMode &&
        !isAutonomousHighRiskTool(name, call.arguments) &&
        !workspaceAllowlist.includes(name)
      ) {
        logger.info('Tool approval auto-granted (autonomous mode)', {
          scope: 'agent',
          correlationId: options.runId,
          tool: name,
          decision: 'once'
        })
        return { allowed: true }
      }

      // The terminal's "Always allow" is scoped to the command, computed here —
      // from the full arguments, not the card's truncated preview.
      // A call the guard or an ask rule held is never remembered: no "Always allow".
      const terminalCommand = name === 'terminal' && !held ? terminalCommandOf(parseArgs(call.arguments)) : null
      const alwaysAllowCommand = terminalCommand ? commandAllowPrefix(terminalCommand) : null
      const alwaysAllowProgram = terminalCommand ? commandAllowProgram(terminalCommand) : null
      const changePreview = buildApprovalChangePreview(name, call.arguments, options.commandGuard?.workspaceRoot)
      const request: ToolApprovalRequest = {
        ...(changePreview ? { changePreview } : {}),
        ...(name === 'terminal' ? { alwaysAllowCommand } : {}),
        ...(alwaysAllowProgram ? { alwaysAllowProgram } : {}),
        ...(editFolder ? { alwaysAllowFolder: editFolder } : {}),
        ...(held ? { danger: held.reason } : {}),
        requestId: randomUUID(),
        runId: options.runId,
        toolCallId: call.id,
        name,
        summary: agentBuiltAllowKey
          ? `${name} — a tool this run wrote`
          : summarizeToolArgs(name, call.arguments),
        argsPreview: scrubString(call.arguments.slice(0, 4000)),
        timeoutMs: approvalTimeoutMs(),
        mutating: isNetworkBrowseTool(name)
          ? false
          : !isApprovalExemptTool(name, (() => {
              try {
                const parsed: unknown = JSON.parse(call.arguments || '{}')
                return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                  ? (parsed as Record<string, unknown>)
                  : undefined
              } catch {
                return undefined
              }
            })())
      }

      const decision = await ask(request).catch((err: unknown) => {
        if (isAbortError(err) || (err instanceof Error && err.name === 'AbortError')) {
          throw err
        }
        const message = held
          ? `This ${held.what} needs the user's OK whatever the approval settings say (${held.reason}), and no app window is listening to ask. It did not run. Do not retry it; find another way or ask the user.`
          : err instanceof Error
            ? err.message
            : 'Tool approval failed because no app window is listening.'
        return { __denyReason: message } as const
      })
      if (typeof decision === 'object' && decision && '__denyReason' in decision) {
        return { allowed: false, reason: decision.__denyReason }
      }
      const extras = responseExtras.get(request.requestId)
      responseExtras.delete(request.requestId)
      const said = extras?.note ? ` They said: ${quoteForAgent(extras.note)}. Do what they asked instead.` : ''
      logger.info('Tool approval decision', {
        scope: 'agent',
        correlationId: options.runId,
        tool: name,
        decision,
        // `reason` survives the log field allowlist; the guard's rule goes there.
        ...(held ? { reason: held.log } : {})
      })

      if (held) {
        // The card offers Allow once and Deny only; a standing grant from any
        // other path is still this one call, never remembered.
        if (decision === 'deny') {
          return {
            allowed: false,
            reason: said
              ? `The user denied this ${held.what} (${held.reason}).${said} Do not retry the denied call.`
              : `The user denied this ${held.what} (${held.reason}). Do not retry it; ask what to do instead or continue without it.`
          }
        }
        if (decision === 'timeout') {
          return {
            allowed: false,
            reason: `Approval for this ${held.what} (${held.reason}) timed out and it was not run. Do not retry it; ask what to do instead or continue without it.`
          }
        }
        return { allowed: true, grant: { by: 'you', scope: 'once' } }
      }

      switch (decision) {
        case 'timeout':
          return {
            allowed: false,
            reason: `Tool approval for ${name} timed out and was auto-denied. Do not retry it; ask what to do instead or continue without it.`
          }
        case 'deny':
          return {
            allowed: false,
            reason: said
              ? `The user denied permission to run ${name}.${said} Do not retry the denied call.`
              : `The user denied permission to run ${name}. Do not retry it; ask what to do instead or continue without it.`
          }
        case 'session':
          sessionAllowlist.add(agentBuiltAllowKey ?? name)
          options.persistTask?.(agentBuiltAllowKey ?? name)
          return { allowed: true, grant: { by: 'you', scope: 'task' } }
        case 'always': {
          if (name === 'terminal') {
            // Per command. One that cannot be scoped is let through this once
            // and remembered for nothing — the card never offers it Always.
            if (!alwaysAllowCommand) return { allowed: true, grant: { by: 'you', scope: 'once' } }
            const prefix =
              extras?.allowProgram && extras.allowProgram === alwaysAllowProgram ? alwaysAllowProgram : alwaysAllowCommand
            const key = commandAllowKey(prefix)
            workspaceAllowlist.push(key)
            options.persistAlways?.(key)
            return { allowed: true, grant: { by: 'you', scope: 'workspace', allow: grantAllow(prefix) } }
          }
          if (extras?.allowFolder && extras.allowFolder === editFolder) {
            // Edits under one folder, not the tool everywhere: rules, like a
            // permission rule written in Settings, so later runs honour it too.
            allowedFolders.push(extras.allowFolder)
            options.persistRules?.(folderAllowRules(extras.allowFolder))
            return { allowed: true, grant: { by: 'you', scope: 'workspace', allow: grantAllow(`edits under ${extras.allowFolder}/`) } }
          }
          // The key, not the name: rewriting the module withdraws the allow.
          workspaceAllowlist.push(agentBuiltAllowKey ?? name)
          options.persistAlways?.(agentBuiltAllowKey ?? name)
          return { allowed: true, grant: { by: 'you', scope: 'workspace', allow: grantAllow(name) } }
        }
        case 'once': {
          if (extras?.editedCommand && name === 'terminal' && extras.editedCommand !== terminalCommand) {
            const args = parseArgs(call.arguments) ?? {}
            return {
              allowed: true,
              grant: { by: 'you', scope: 'once' },
              arguments: JSON.stringify({ ...args, command: extras.editedCommand }),
              editNote: `[The user edited this command before allowing it. It ran as: ${quoteForAgent(extras.editedCommand)}]`
            }
          }
          return { allowed: true, grant: { by: 'you', scope: 'once' } }
        }
        default: {
          const _exhaustive: never = decision
          return _exhaustive
        }
      }
    },
    hidesFromSearch(toolName: string, relPath: string): boolean {
      return options.permissions?.hidesFromSearch(toolName, relPath) ?? false
    }
  }
}

/** Test helper — wipe senders and pending prompts between cases. */
export function resetToolApprovalForTests(): void {
  senders.clear()
  pending.clear()
  responseExtras.clear()
  approvalTimeoutMinutes = () => TOOL_APPROVAL_TIMEOUT_MS / 60_000
}

// A cancel releases this run's parked approvals (runRegistry calls it).
registerRunCancelHooks({ cancelApprovals: cancelPendingApprovals })
