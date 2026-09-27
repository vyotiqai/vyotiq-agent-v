/** Tool-call argument parsing shared by execution and approval. Leaf module — no tools barrel. */
import { parseJsonish } from '../../../shared/utils/jsonish'
import { wireToolCallArguments } from '../toolArgWire'
import { readPathArg, readString, readTrimmed } from './argAccess'

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

/**
 * The argument object a tool call executes with: wire salvage, then the alias
 * normalization. Approval must gate this same view — gating the raw JSON let
 * `{cmd, session_id}` pass as a session poll and an unclosed `lsp` rename pass
 * as diagnostics, while execution ran a command and a rename.
 */
export function parseToolCallArgs(
  name: string,
  argsJson: string | undefined
): Record<string, unknown> {
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
