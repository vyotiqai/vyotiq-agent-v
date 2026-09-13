import { readPathArg } from './argAccess'
import { lspActionFromArgs } from './lsp'

/** Workspace-local reads safe to run concurrently (no file mutation). */
const PARALLEL_SAFE_BUILTIN = new Set([
  'read',
  'search',
  'glob',
  'grep',
  'codebase_search',
  'list_dir',
  'memory_list',
  'memory_read',
  'Skill',
  'git_status',
  'git_diff',
  'mcp_list_tools',
  'pull_agent_instance',
  'lsp'
])

/** Single-file writes that may overlap when normalized paths are disjoint. */
const PARALLEL_MUTATION_BUILTIN = new Set([
  'edit',
  'str_replace',
  'edit_notebook',
  'memory_write'
])

/**
 * Tools that skip approval in `mutating` mode.
 * Same as parallel-safe except MCP catalog/meta builtins (`mcp_list_tools`, resources/prompts, pin tools).
 * Browser tools (including `browser_search`) are serial (shared BrowserWindow) and always gated.
 * Interactive gates (`ask_question`, `switch_mode`) have their own flow.
 */
const APPROVAL_EXEMPT_BUILTIN = new Set(
  [...PARALLEL_SAFE_BUILTIN].filter((name) => name !== 'mcp_list_tools')
)

/**
 * Serial tools — not parallel-safe, but not tool-approval gated.
 * Interactive gates have their own flow.
 */
const SERIAL_APPROVAL_EXEMPT_BUILTIN = new Set([
  'ask_question',
  'switch_mode',
  'todo_write',
  'create_plan',
  'create_goal',
  'update_goal',
  'await_agent_instance',
  'spawn_agent_instance',
  'cancel_agent_instance'
])

/** Agent-mode-only builtins (inline instance delegation). */
export const AGENT_ONLY_BUILTIN = new Set([
  'spawn_agent_instance',
  'await_agent_instance',
  'pull_agent_instance',
  'merge_agent_instance',
  'cancel_agent_instance'
])

/** Root-chat-only builtins omitted from inline instance catalogs. */
export const INLINE_OMIT_BUILTIN = new Set([
  ...AGENT_ONLY_BUILTIN,
  'create_goal',
  'update_goal'
])

export const MAX_PARALLEL_READ_TOOLS = 8
export const MAX_PARALLEL_MUTATION_TOOLS = 4

/** Consecutive same-class groups in one step. Do not reorder mixed spawn/await. */
export type StepToolBatchClass = 'read' | 'mutation' | 'spawn' | 'await' | 'serial'

/**
 * Built-in tools safe to run in parallel (no workspace mutation).
 * MCP tools are never parallel-safe here — `readOnlyHint` is untrusted for
 * both parallelism and approval exemption. `mcp_list_tools` is the one catalog
 * builtin allowed to batch with reads.
 */
export function isParallelSafeTool(name: string): boolean {
  return PARALLEL_SAFE_BUILTIN.has(name)
}

/** `edit` / `str_replace` / `edit_notebook` / `memory_write`. `delete` stays serial. */
export function isParallelMutationTool(name: string): boolean {
  return PARALLEL_MUTATION_BUILTIN.has(name)
}

export function isParallelSpawnTool(name: string): boolean {
  return name === 'spawn_agent_instance'
}

export function isParallelAwaitTool(name: string): boolean {
  return name === 'await_agent_instance'
}

export function stepToolBatchClass(
  name: string,
  args?: Record<string, unknown>
): StepToolBatchClass {
  if (name === 'lsp') return lspActionFromArgs(args) === 'rename' ? 'serial' : 'read'
  if (isParallelSafeTool(name)) return 'read'
  if (isParallelMutationTool(name)) return 'mutation'
  if (isParallelSpawnTool(name)) return 'spawn'
  if (isParallelAwaitTool(name)) return 'await'
  return 'serial'
}

/**
 * Normalized relative path used to keep same-file mutations serial.
 * Notebooks use `target_notebook`; others use `path` / `file` / `filepath` / `filename`.
 * Missing/empty path → undefined (caller must run that call as a singleton).
 */
export function parallelMutationPathKey(
  args: Record<string, unknown>,
  name?: string
): string | undefined {
  const raw =
    name === 'edit_notebook' && typeof args.target_notebook === 'string'
      ? args.target_notebook
      : readPathArg(args)
  if (!raw) return undefined
  const normalized = raw.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '').trim()
  if (!normalized || normalized === '.') return undefined
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function parallelLimitForBatchClass(cls: StepToolBatchClass): number {
  switch (cls) {
    case 'read':
      return MAX_PARALLEL_READ_TOOLS
    case 'mutation':
      return MAX_PARALLEL_MUTATION_TOOLS
    case 'spawn':
    case 'await':
      return Number.POSITIVE_INFINITY
    case 'serial':
      return 1
    default: {
      const exhaustive: never = cls
      return exhaustive
    }
  }
}

export function isParallelBatchClass(cls: StepToolBatchClass): boolean {
  switch (cls) {
    case 'read':
    case 'mutation':
    case 'spawn':
    case 'await':
      return true
    case 'serial':
      return false
    default: {
      const exhaustive: never = cls
      return exhaustive
    }
  }
}

/**
 * Tools that do not require approval when mode is `mutating`.
 * `browser_*` tools are serial-only and always gated (shared window + egress).
 * MCP builtins and MCP server tools always require approval in `mutating`/`all`.
 */
export function isApprovalExemptTool(name: string, args?: Record<string, unknown>): boolean {
  if (name === 'lsp') return lspActionFromArgs(args) !== 'rename'
  return APPROVAL_EXEMPT_BUILTIN.has(name) || SERIAL_APPROVAL_EXEMPT_BUILTIN.has(name)
}
