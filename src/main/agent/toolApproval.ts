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
import { ASK_SAFE_BUILTIN } from './tools/modePolicy'
import { streamSignalFor } from './runRegistry'
import { dismissLifecycleNotification } from '../notifications/bus'
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

export function isToolGated(
  name: string,
  mode: ToolApprovalMode,
  sessionAllowlist: ReadonlySet<string>,
  workspaceAllowlist: readonly string[],
  argsJson?: string,
  opts?: { mcpProtection?: boolean }
): boolean {
  const canonical = canonicalizeAgentToolName(name)
  if (sessionAllowlist.has(canonical) || sessionAllowlist.has(name)) return false
  if (workspaceAllowlist.includes(canonical) || workspaceAllowlist.includes(name)) return false
  const mcpProtection = opts?.mcpProtection !== false
  if (mode === 'off') return mcpProtection && isMcpServerToolName(canonical)
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
    canonical === 'github_pr_create' ||
    canonical === 'github_pr_review' ||
    canonical === 'github_issue' ||
    canonical === 'merge_agent_instance' ||
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
        'Tool approval required but no app window is listening. Reopen Vyotiq and retry, or turn off tool approval in Settings → Tools.'
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
      clearWaiters()
      resolve(decision)
    }
    const cancel = (err: Error): void => {
      if (settled || !pending.has(request.requestId)) return
      settled = true
      pending.delete(request.requestId)
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
      request
    })
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
      if (
        !isToolGated(name, options.mode, sessionAllowlist, workspaceAllowlist, call.arguments, {
          mcpProtection: options.mcpProtection
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
        summary: summarizeToolArgs(name, call.arguments),
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
          sessionAllowlist.add(name)
          return { allowed: true }
        case 'always':
          workspaceAllowlist.push(name)
          options.persistAlways?.(name)
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
