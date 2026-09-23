import { randomUUID } from 'crypto'
import type {
  ToolApprovalDecision,
  ToolApprovalMode,
  ToolApprovalRequest,
  ToolApprovalResponse
} from '../../shared/ipc'
import { isAbortError } from '../../shared/errors'
import { logger } from '../../shared/logger'
import { summarizeToolArgs } from '../../shared/toolSummary'
import { scrubString } from '../../shared/utils/scrub'
import { isMcpServerToolName } from '../../shared/mcpApps'
import { BUILTIN_TOOL_NAMES, canonicalizeAgentToolName } from './schemas/tools'
import { isApprovalExemptTool } from './tools/classify'
import { agentBuiltToolAllowKey } from './agentTools/loader'
import { resolveAgentToolsDir } from './agentTools/paths'
import { ASK_SAFE_BUILTIN } from './tools/modePolicy'
import { streamSignalFor } from './runRegistry'
import { dismissLifecycleNotification } from '../notifications/bus'
import { notifyBadgeChange } from '../app/badges'
import { needsYouDedupeKey } from '../../shared/ipc'

/** Browse/fetch egress — gated, but not workspace-mutating.
 * Legacy `web_fetch` / `web_search` kept for transcript approval replay only
 * (removed from TOOL_REGISTRY); live network browse is `browser_*`.
 */
function isNetworkBrowseTool(name: string): boolean {
  return name.startsWith('browser_') && ASK_SAFE_BUILTIN.has(name)
}

export type ApprovalSender = (request: ToolApprovalRequest) => void

/** Default wait for user approval before auto-denying (15 minutes). */
export const TOOL_APPROVAL_TIMEOUT_MS = 900_000

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

/** Total approvals waiting across all runs — drives the taskbar badge. */
export function countPendingToolApprovals(): number {
  return pending.size
}

/** Returns false when the request is unknown or runId does not match. */
export function resolveToolApproval(response: ToolApprovalResponse): boolean {
  const entry = pending.get(response.requestId)
  if (!entry) return false
  if (entry.runId !== response.runId) return false
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

export function isToolGated(
  name: string,
  mode: ToolApprovalMode,
  sessionAllowlist: ReadonlySet<string>,
  workspaceAllowlist: readonly string[],
  argsJson?: string,
  opts?: { mcpProtection?: boolean; agentBuiltAllowKey?: string }
): boolean {
  const canonical = canonicalizeAgentToolName(name)
  // An agent-built tool is allowlisted under `<name>@<contentHash>`, never its
  // bare name — the file behind the name can be rewritten by a later
  // build_tool call, and a standing allow must not follow it.
  const allowKey = opts?.agentBuiltAllowKey
  const allowNames = allowKey ? [allowKey] : [canonical, name]
  if (allowNames.some((entry) => sessionAllowlist.has(entry))) return false
  if (allowNames.some((entry) => workspaceAllowlist.includes(entry))) return false
  const mcpProtection = opts?.mcpProtection !== false
  if (mode === 'off') {
    // "Approvals off" is a judgement about the tools that shipped with the app.
    // An agent-built module is arbitrary Node this run wrote minutes ago, so it
    // stays gated here for the same reason an MCP server tool does.
    return Boolean(allowKey) || (mcpProtection && isMcpServerToolName(canonical))
  }
  if (mode === 'all') return true
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
  return (
    canonical === 'delete' ||
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
    canonical.startsWith('mcp__') ||
    !(BUILTIN_TOOL_NAMES as readonly string[]).includes(canonical)
  )
}

export type AuthorizeResult = { allowed: true } | { allowed: false; reason: string }

/** Internal ask result: IPC decisions plus timeout auto-deny. */
type AskDecision = ToolApprovalDecision | 'timeout'

export type ToolApprovalGate = {
  authorize(call: {
    id: string
    name: string
    arguments: string
  }): Promise<AuthorizeResult>
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
  /** Overridable so tests can drive the decision without an Electron window. */
  ask?: (request: ToolApprovalRequest) => Promise<AskDecision>
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
        'Tool approval required but no app window is listening. Reopen Vyotiq and retry, or turn off tool approval in Settings → Agent.'
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
      resolve(decision)
    }
    const cancel = (err: Error): void => {
      if (settled || !pending.has(request.requestId)) return
      settled = true
      pending.delete(request.requestId)
      notifyBadgeChange()
      clearWaiters()
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
    timeoutId = setTimeout(() => {
      if (!pending.has(request.requestId)) return
      settle('timeout')
    }, TOOL_APPROVAL_TIMEOUT_MS)
    sender(request)
  })
}

/**
 * Gate for one run.
 *
 * "Allow for session" lives on this object and dies with the run; "Always allow"
 * is handed to `persistAlways` so it survives into the next one.
 */
export function createApprovalGate(options: ApprovalGateOptions): ToolApprovalGate {
  const sessionAllowlist = new Set<string>()
  const workspaceAllowlist = [...options.workspaceAllowlist]
  const ask =
    options.ask ??
    ((request) =>
      askThroughRenderer(
        request,
        streamSignalFor(options.runId, options.signal),
        options.invokeId
      ))

  return {
    async authorize(call): Promise<AuthorizeResult> {
      const name = canonicalizeAgentToolName(call.name)
      const agentBuiltAllowKey = await agentBuiltAllowKeyFor(name)
      if (
        !isToolGated(name, options.mode, sessionAllowlist, workspaceAllowlist, call.arguments, {
          mcpProtection: options.mcpProtection,
          agentBuiltAllowKey
        })
      ) {
        return { allowed: true }
      }

      if (
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

      const request: ToolApprovalRequest = {
        requestId: randomUUID(),
        runId: options.runId,
        toolCallId: call.id,
        name,
        summary: agentBuiltAllowKey
          ? `${name} — a tool this run wrote`
          : summarizeToolArgs(name, call.arguments),
        argsPreview: scrubString(call.arguments.slice(0, 4000)),
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
        const message =
          err instanceof Error
            ? err.message
            : 'Tool approval failed because no app window is listening.'
        return { __denyReason: message } as const
      })
      if (typeof decision === 'object' && decision && '__denyReason' in decision) {
        return { allowed: false, reason: decision.__denyReason }
      }
      logger.info('Tool approval decision', {
        scope: 'agent',
        correlationId: options.runId,
        tool: name,
        decision
      })

      switch (decision) {
        case 'timeout':
          return {
            allowed: false,
            reason: `Tool approval for ${name} timed out and was auto-denied. Do not retry it; ask what to do instead or continue without it.`
          }
        case 'deny':
          return {
            allowed: false,
            reason: `The user denied permission to run ${name}. Do not retry it; ask what to do instead or continue without it.`
          }
        case 'session':
          sessionAllowlist.add(agentBuiltAllowKey ?? name)
          return { allowed: true }
        case 'always':
          // The key, not the name: rewriting the module withdraws the allow.
          workspaceAllowlist.push(agentBuiltAllowKey ?? name)
          options.persistAlways?.(agentBuiltAllowKey ?? name)
          return { allowed: true }
        case 'once':
          return { allowed: true }
        default: {
          const _exhaustive: never = decision
          return _exhaustive
        }
      }
    }
  }
}

/** Test helper — wipe senders and pending prompts between cases. */
export function resetToolApprovalForTests(): void {
  senders.clear()
  pending.clear()
}
