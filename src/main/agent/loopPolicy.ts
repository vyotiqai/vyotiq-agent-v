import type { ChatMessage } from '../../shared/ipc'
import { codebaseSearchHitPathsFromResult } from './codeindex/query'
import { readPathArg } from './tools/argAccess'
import { searchHitPathsFromResult } from './tools/search'
import { loopHintForRetainedDecisions } from './context/retainedDecisions'

/**
 * After this many not-in-catalog failures for the *same* MCP tool name in a run,
 * harden the error so the model stops wasting full steps retrying.
 */
export const MCP_NOT_IN_CATALOG_FAIL_FAST_THRESHOLD = 2

const WRITE_TOOLS = new Set(['edit', 'str_replace', 'edit_notebook'])
const FILE_MUTATION_TOOLS = new Set([...WRITE_TOOLS, 'delete'])

const MCP_NOT_IN_CATALOG_MARKER = "is not in this step's tool catalog"

/** True when a tool result describes an MCP not-in-catalog rejection. */
export function isMcpNotInCatalogError(content: string): boolean {
  return content.includes(MCP_NOT_IN_CATALOG_MARKER)
}

/**
 * Increment the run-scoped not-in-catalog counter for `toolName`.
 * Returns the new count.
 */
export function recordMcpNotInCatalogFailure(
  counts: Map<string, number>,
  toolName: string
): number {
  const next = (counts.get(toolName) ?? 0) + 1
  counts.set(toolName, next)
  return next
}

/** First rejection: steer toward pin-once-then-wait. */
export function mcpNotInCatalogErrorMessage(
  toolName: string,
  opts?: { alreadyPinned?: boolean }
): string {
  const pinNote = opts?.alreadyPinned
    ? `It is already pinned — wait for the next model step so the sticky catalog can admit it.`
    : `Use mcp_list_tools then request_mcp_tools to pin it once, then wait for the next model step (do not keep calling it this step).`
  return [
    `MCP tool "${toolName}" ${MCP_NOT_IN_CATALOG_MARKER} (excluded by mode or catalog policy).`,
    pinNote
  ].join(' ')
}

/** Repeated rejection for the same tool — fail-fast to cut wasted steps. */
export function mcpNotInCatalogFailFastMessage(toolName: string, failureCount: number): string {
  return [
    `FAIL-FAST: MCP tool "${toolName}" was rejected as not-in-catalog ${failureCount} times this run.`,
    'Stop calling it. Pin once with request_mcp_tools if needed and wait for the next step, or use a built-in/alternate approach.',
    'Further retries while it remains omitted will not succeed and waste context tokens.'
  ].join(' ')
}

/** Loop hint when one or more MCP tools hit the not-in-catalog fail-fast threshold. */
export function loopHintForMcpNotInCatalogFailFast(
  toolNames: readonly string[]
): string | undefined {
  if (toolNames.length === 0) return undefined
  const preview = toolNames.slice(0, 6).join(', ')
  const more = toolNames.length > 6 ? ` (+${toolNames.length - 6} more)` : ''
  return [
    `Repeated not-in-catalog MCP calls for: ${preview}${more}.`,
    'Do not retry those tools. Pin with request_mcp_tools once if needed, then wait for the next step so pins append into the sticky catalog.'
  ].join(' ')
}

export function combineLoopHints(...hints: Array<string | undefined>): string | undefined {
  const parts = hints.map((h) => h?.trim()).filter((h): h is string => Boolean(h))
  return parts.length ? parts.join('\n\n') : undefined
}

/** When auto-compaction cannot fold yet (too little history / nothing foldable). */
export function loopHintForCompactionFailure(): string {
  return [
    'Automatic history compaction had nothing foldable yet (history too short or already recent).',
    'Move durable facts into memory with memory_write.'
  ].join(' ')
}

/** When the summarizer output failed extractive verification and was discarded. */
export function loopHintForCompactionVerifyFailed(): string {
  return [
    'Automatic history compaction produced a summary that failed verification and was not applied.',
    'Move durable facts into memory with memory_write.'
  ].join(' ')
}

export function loopHintAfterCompaction(
  decisions?: readonly string[]
): string | undefined {
  return loopHintForRetainedDecisions(decisions)
}

/** Model loop hint when context remains far above the soft compaction trigger. */
export function runNoticeForContextAboveSoftTrigger(): string {
  return 'Context is still large after compaction. Continue; auto-compact will fold again at the next threshold. Move durable facts into memory with memory_write.'
}

export function normalizeWorkspaceRelPath(path: string): string {
  return path.trim().replace(/\\/g, '/')
}

function parseToolArgs(argumentsJson: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(argumentsJson)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // ignore malformed args
  }
  return {}
}

export function editPathsFromToolCall(
  name: string,
  args: Record<string, unknown>
): string[] {
  if (name === 'edit' || name === 'str_replace' || name === 'edit_notebook') {
    const raw =
      name === 'edit_notebook' && typeof args.target_notebook === 'string'
        ? args.target_notebook
        : readPathArg(args)
    const path = raw ? normalizeWorkspaceRelPath(raw) : ''
    return path ? [path] : []
  }
  return []
}

/** Concrete path targeted by a successful `delete` tool call. */
export function deletePathFromToolCall(
  name: string,
  args: Record<string, unknown>
): string | null {
  if (name !== 'delete') return null
  const raw = readPathArg(args)
  const path = raw ? normalizeWorkspaceRelPath(raw) : ''
  return path || null
}

/**
 * Drop a deleted path and any descendant paths from the inspect/edit set.
 * Always clears descendants: `toolDelete` removes directory trees on success
 * (empty dirs or `recursive=true`), so stale child inspects must not survive.
 */
export function invalidateKnownPathsAfterDelete(known: Set<string>, deletedPath: string): void {
  const path = normalizeWorkspaceRelPath(deletedPath)
  if (!path) return
  known.delete(path)
  const prefix = path.endsWith('/') ? path : `${path}/`
  for (const entry of [...known]) {
    if (entry.startsWith(prefix)) known.delete(entry)
  }
}

export function readPathFromToolCall(
  name: string,
  args: Record<string, unknown>
): string | null {
  if (name !== 'read') return null
  const raw = readPathArg(args)
  const path = raw ? normalizeWorkspaceRelPath(raw) : ''
  return path || null
}

/** True when a path/glob string names a single concrete file (no wildcards). */
export function isConcreteWorkspacePath(value: string): boolean {
  const path = normalizeWorkspaceRelPath(value)
  if (!path || path === '.' || path === '..') return false
  if (/[*?[{]/.test(path)) return false
  return true
}

/**
 * Receipt/checkpoint paths must look like real workspace files — not comma-glued
 * command args, bare punctuation, or assertion fragments from terminal output.
 */
export function isPlausibleWorkspaceFilePath(value: string): boolean {
  const path = normalizeWorkspaceRelPath(value)
  if (!isConcreteWorkspacePath(path)) return false
  if (path.includes(',')) return false
  if (/[;|&<>]/.test(path)) return false
  // PowerShell env paths (`$env:TEMP/…`) are not workspace files.
  if (path.startsWith('$')) return false
  if (/^[=+-]+$/.test(path)) return false
  if (path.includes(')') && !path.includes('(')) return false
  if (!path.includes('/') && !/\.[a-zA-Z0-9][\w.-]*$/.test(path)) return false
  return true
}

/**
 * Compiler output that opaque `dotnet`/`msbuild` watches used to record as
 * agent writes (receipt 92c049d6: 1541 bin/Debug files).
 */
export function isBuildOutputRelPath(value: string): boolean {
  const path = normalizeWorkspaceRelPath(value)
  return /(?:^|\/)(?:bin\/(?:Debug|Release)(?:\/|$)|obj\/)/i.test(path)
}

/** Run-cancel / steer stubs — not agent tool errors. */
export function isAbortStubToolResult(content: string): boolean {
  const text = content.trim()
  return text === 'Cancelled' || text === 'Interrupted'
}

/**
 * Approval / mode gate refusals — the tool never executed, so receipt usage
 * stats must not count them as failed executions (Home Activity tool rows,
 * session `N tools · M failed` chips, and `N!` streaks all read these).
 * Distinct from {@link isNonMutatingWriteFailure}, which is unread-edit policy.
 */
export function isGateRefusalToolResult(content: string): boolean {
  if (/^The user denied permission to run /i.test(content)) return true
  if (/timed out and was auto-denied\./i.test(content)) return true
  if (/Tool approval required but no app window is listening\./i.test(content)) return true
  if (/Tool approval failed because no app window is listening\./i.test(content)) return true
  if (/^(?:Ask|Plan) mode does not allow (?:tool|lsp|MCP)/i.test(content)) return true
  if (/^Plan mode may only edit plan\.md or contract\.md/i.test(content)) return true
  if (/^Automatic mode switching is off\./i.test(content)) return true
  if (/^Background terminal requires run ownership/i.test(content)) return true
  return false
}

/**
 * Failures that never mutated the file. Counting them as unread-before-edit
 * poisoned harness review (Plan-mode memory-path edits on run 75135925).
 */
export function isNonMutatingWriteFailure(content: string): boolean {
  if (isAbortStubToolResult(content)) return true
  if (/Plan mode may only edit plan\.md or contract\.md/i.test(content)) return true
  if (/Ask mode does not allow tool "/i.test(content)) return true
  if (/Path escapes workspace/i.test(content)) return true
  return false
}

/** Tools whose successful concrete paths count as inspect for path tracking. */
export function isInspectToolName(name: string): boolean {
  return (
    name === 'read' ||
    name === 'list_dir' ||
    name === 'grep' ||
    name === 'glob' ||
    name === 'search' ||
    name === 'codebase_search'
  )
}

/** Tools whose successful results can make earlier diagnostics stale. */
export function isFileMutationToolName(name: string): boolean {
  return FILE_MUTATION_TOOLS.has(name)
}

/**
 * Paths that count as “seen”: `read`, concrete `grep` include / `glob` pattern
 * (no wildcards), `search` hit paths, or `codebase_search` hit paths from tool result text.
 */
export function inspectPathsFromToolCall(
  name: string,
  args: Record<string, unknown>,
  resultContent?: string
): string[] {
  if (name === 'read') {
    const path = readPathFromToolCall(name, args)
    return path ? [path] : []
  }
  if (name === 'grep') {
    // Prefer `include`; fall back to hallucinated `path` for known-path tracking only.
    const raw = typeof args.include === 'string' ? args.include : args.path
    if (typeof raw === 'string' && isConcreteWorkspacePath(raw)) {
      return [normalizeWorkspaceRelPath(raw)]
    }
    return []
  }
  if (name === 'glob') {
    const pattern = typeof args.pattern === 'string' ? args.pattern : ''
    if (isConcreteWorkspacePath(pattern)) return [normalizeWorkspaceRelPath(pattern)]
    return []
  }
  if (name === 'list_dir') {
    const path = typeof args.path === 'string' ? normalizeWorkspaceRelPath(args.path) : ''
    if (path && isConcreteWorkspacePath(path)) return [path]
    return []
  }
  if (name === 'search' && typeof resultContent === 'string' && resultContent) {
    return searchHitPathsFromResult(resultContent)
      .map((p) => normalizeWorkspaceRelPath(p))
      .filter((p) => isConcreteWorkspacePath(p))
  }
  if (name === 'codebase_search' && typeof resultContent === 'string' && resultContent) {
    return codebaseSearchHitPathsFromResult(resultContent)
      .map((p) => normalizeWorkspaceRelPath(p))
      .filter((p) => isConcreteWorkspacePath(p))
  }
  return []
}

export function applyToolCallToKnownPaths(
  known: Set<string>,
  name: string,
  args: Record<string, unknown>,
  ok: boolean,
  resultContent?: string
): void {
  if (!ok) return
  const deleted = deletePathFromToolCall(name, args)
  if (deleted) {
    invalidateKnownPathsAfterDelete(known, deleted)
    return
  }
  for (const path of inspectPathsFromToolCall(name, args, resultContent)) {
    known.add(path)
  }
  for (const path of editPathsFromToolCall(name, args)) {
    known.add(path)
  }
}

export function unreadExistingEditPaths(
  known: ReadonlySet<string>,
  name: string,
  args: Record<string, unknown>,
  pathExists: (rel: string) => boolean
): string[] {
  if (!WRITE_TOOLS.has(name)) return []
  const unread: string[] = []
  for (const path of editPathsFromToolCall(name, args)) {
    if (known.has(path)) continue
    if (!pathExists(path)) continue
    unread.push(path)
  }
  return unread
}

/**
 * Track paths a successful tool call actually changed (edits + deletes, no reads).
 * Used to scope git_commit staging to files the agent touched this run.
 */
export function applyToolCallToMutationPaths(
  mutations: Set<string>,
  name: string,
  args: Record<string, unknown>,
  ok: boolean
): void {
  if (!ok) return
  const deleted = deletePathFromToolCall(name, args)
  if (deleted) {
    mutations.add(normalizeWorkspaceRelPath(deleted))
    return
  }
  for (const path of editPathsFromToolCall(name, args)) {
    mutations.add(path)
  }
}

/** Seed mutation paths from the transcript so scoped commits survive reloads. */
export function seedMutationPathsFromMessages(messages: readonly SeedMessage[]): Set<string> {
  const mutations = new Set<string>()
  const successfulCallIds = new Set<string>()
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.toolCallId && msg.ok !== false) {
      successfulCallIds.add(msg.toolCallId)
    }
  }
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const call of msg.toolCalls) {
        if (!successfulCallIds.has(call.id)) continue
        applyToolCallToMutationPaths(mutations, call.name, parseToolArgs(call.arguments), true)
      }
    }
  }
  return mutations
}

type SeedMessage = {
  role: string
  toolCalls?: Array<{ id: string; name: string; arguments: string }>
  toolCallId?: string
  toolName?: string
  ok?: boolean
  content?: unknown
}

/**
 * Seed known paths from transcript (used by receipts for unread-edit observation).
 * Only calls with a matching successful tool result count as seen.
 */
export function seedKnownPathsFromMessages(messages: readonly SeedMessage[]): Set<string> {
  const known = new Set<string>()
  const successfulCallIds = new Set<string>()
  const resultByCallId = new Map<string, string>()
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.toolCallId && msg.ok !== false) {
      successfulCallIds.add(msg.toolCallId)
      if (typeof msg.content === 'string') {
        resultByCallId.set(msg.toolCallId, msg.content)
      }
    }
  }
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const call of msg.toolCalls) {
        if (!successfulCallIds.has(call.id)) continue
        const args = parseToolArgs(call.arguments)
        applyToolCallToKnownPaths(known, call.name, args, true, resultByCallId.get(call.id))
      }
    }
  }
  return known
}

/** Parse tool-call argument JSON for loop wiring. */
export function toolArgsFromCall(argumentsJson: string): Record<string, unknown> {
  return parseToolArgs(argumentsJson)
}
