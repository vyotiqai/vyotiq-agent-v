import {
  formatAgentInstanceShortId,
  parseAgentInstanceRunIdFromArgs
} from './agentInstance'
import {
  extractPathFromTerminalCommand,
  formatListDirPathLabel,
  formatPathLabel,
  sanitizeCommandForDisplay,
  sanitizeDisplayPath
} from './displayPath'
import { parseJsonish } from './jsonish'

export const MCP_TOOL_PREFIX = 'mcp__'

/** True while the provider has not yet sent a real tool name (OpenAI nameless deltas). */
export function isUnresolvedToolName(name: string | undefined | null): boolean {
  return !name || name === 'tool'
}

/**
 * Per-call create vs modify from tool result text (edit).
 * Null when the result does not describe a file write.
 */
export function inferFileWriteAction(
  name: string,
  content?: string | null
): 'created' | 'modified' | null {
  if (name !== 'edit') return null
  const text = (content ?? '').trim()
  if (!text) return null
  if (name === 'edit') {
    if (/^Created\b/i.test(text)) return 'created'
    if (/^Wrote\b/i.test(text) || /^Applied diff\b/i.test(text)) return 'modified'
    return null
  }
  return null
}

export const TOOL_LABELS: Record<string, { running: string; done: string }> = {
  read: { running: 'Reading', done: 'Read' },
  edit: { running: 'Editing', done: 'Edited' },
  search: { running: 'Searching', done: 'Searched' },
  glob: { running: 'Globbing', done: 'Globbed' },
  grep: { running: 'Grepping', done: 'Grepped' },
  codebase_search: { running: 'Semantic search', done: 'Codebase search' },
  list_dir: { running: 'Listing', done: 'Listed' },
  str_replace: { running: 'Editing', done: 'Edited' },
  delete: { running: 'Deleting', done: 'Deleted' },
  todo_write: { running: 'Updating tasks', done: 'Updated tasks' },
  create_goal: { running: 'Setting goal', done: 'Set goal' },
  update_goal: { running: 'Updating goal', done: 'Updated goal' },
  create_plan: { running: 'Writing plan', done: 'Wrote plan' },
  web_fetch: { running: 'Fetching', done: 'Fetched' },
  web_search: { running: 'Searching web', done: 'Web search' },
  browser_navigate: { running: 'Browsing', done: 'Browsed' },
  // Navigate + snapshot in agent browser (not a SERP hit list).
  browser_search: { running: 'Searching', done: 'Searched' },
  browser_snapshot: { running: 'Snapshotting', done: 'Snapshot' },
  browser_click: { running: 'Clicking', done: 'Clicked' },
  browser_type: { running: 'Typing', done: 'Typed' },
  browser_scroll: { running: 'Scrolling', done: 'Scrolled' },
  browser_fill: { running: 'Filling', done: 'Filled' },
  browser_tabs: { running: 'Tabs', done: 'Tabs' },
  browser_back: { running: 'Going back', done: 'Back' },
  browser_forward: { running: 'Going forward', done: 'Forward' },
  browser_wait_for_selector: { running: 'Waiting', done: 'Waited' },
  browser_wait_for_url: { running: 'Waiting URL', done: 'URL ready' },
  browser_wait_for_text: { running: 'Waiting text', done: 'Text found' },
  browser_hover: { running: 'Hovering', done: 'Hovered' },
  browser_handle_dialog: { running: 'Handling dialog', done: 'Dialog handled' },
  browser_press_key: { running: 'Pressing', done: 'Pressed' },
  browser_select_option: { running: 'Selecting', done: 'Selected' },
  mcp_list_tools: { running: 'Listing MCP', done: 'MCP tools' },
  request_mcp_tools: { running: 'Pinning MCP', done: 'Pinned MCP' },
  release_mcp_tools: { running: 'Releasing MCP', done: 'Released MCP' },
  mcp_list_resources: { running: 'Listing MCP resources', done: 'MCP resources' },
  mcp_read_resource: { running: 'Reading MCP resource', done: 'MCP resource' },
  mcp_list_prompts: { running: 'Listing MCP prompts', done: 'MCP prompts' },
  mcp_get_prompt: { running: 'Fetching MCP prompt', done: 'MCP prompt' },
  terminal: { running: 'Running', done: 'Ran' },
  memory_list: { running: 'Listing memory', done: 'Listed memory' },
  memory_read: { running: 'Reading memory', done: 'Read memory' },
  memory_write: { running: 'Writing memory', done: 'Wrote memory' },
  Skill: { running: 'Loading skill', done: 'Loaded skill' },
  git_status: { running: 'Checking git', done: 'Git status' },
  git_diff: { running: 'Diffing', done: 'Git diff' },
  git_commit: { running: 'Committing', done: 'Git commit' },
  git_apply: { running: 'Applying patch', done: 'Applied patch' },
  github_pr_create: { running: 'Creating PR', done: 'Created PR' },
  github_pr_review: { running: 'Reviewing PR', done: 'Reviewed PR' },
  github_issue: { running: 'GitHub issue', done: 'GitHub issue' },
  diagnostics: { running: 'Checking', done: 'Diagnostics' },
  run_tests: { running: 'Testing', done: 'Tests' },
  edit_notebook: { running: 'Editing notebook', done: 'Edited notebook' },
  lsp: { running: 'Language server', done: 'Language server' },
  spawn_agent_instance: { running: 'Spawning instance', done: 'Spawned instance' },
  await_agent_instance: { running: 'Awaiting instance', done: 'Instance finished' },
  pull_agent_instance: { running: 'Pulling instance', done: 'Pulled instance' },
  merge_agent_instance: { running: 'Merging instance', done: 'Merged instance' },
  cancel_agent_instance: { running: 'Cancelling instance', done: 'Cancelled instance' },
  ask_question: { running: 'Asking', done: 'Asked' },
  switch_mode: { running: 'Switching mode', done: 'Switched mode' }
}

export function parseMcpToolDisplay(
  name: string
): { serverId: string; toolName: string } | null {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return null
  const rest = name.slice(MCP_TOOL_PREFIX.length)
  const sep = rest.indexOf('__')
  if (sep <= 0) return null
  return { serverId: rest.slice(0, sep), toolName: rest.slice(sep + 2) }
}

function truncate(text: string, max = 120): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max - 1)}…`
}

export function parseArgsRecord(args: string | undefined): Record<string, unknown> | null {
  if (!args?.trim()) return null
  try {
    const parsed = JSON.parse(args) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function firstStringArg(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

function formatPathTarget(path: string): string {
  return truncate(formatPathLabel(sanitizeDisplayPath(path)))
}

export function normalizeToolTarget(name: string, args: Record<string, unknown> | null): string {
  if (!args) return ''
  if (name === 'read' || name === 'edit' || name === 'str_replace' || name === 'delete' || name === 'lsp') {
    const path = args.path ?? args.file
    if (typeof path === 'string') return formatPathTarget(path)
  }
  if (name === 'edit_notebook') {
    const path = args.target_notebook ?? args.path
    if (typeof path === 'string') return formatPathTarget(path)
  }
  if (name === 'list_dir') {
    const path = args.path
    const raw = typeof path === 'string' && path.trim() ? path : '.'
    return truncate(formatListDirPathLabel(raw))
  }
  if (name === 'search' || name === 'glob' || name === 'grep' || name === 'codebase_search') {
    const query = args.query ?? args.pattern
    if (typeof query === 'string') return truncate(query)
  }
  if (name === 'todo_write') {
    const todos = args.todos
    if (Array.isArray(todos)) {
      const n = todos.length
      return n === 1 ? '1 task' : `${n} tasks`
    }
  }
  if (name === 'create_goal') {
    const objective = args.objective
    if (typeof objective === 'string' && objective.trim()) return truncate(objective.trim())
  }
  if (name === 'update_goal') {
    const status = args.status
    if (typeof status === 'string' && status.trim()) return truncate(status.trim())
  }
  if (name === 'create_plan') {
    const title = args.title
    if (typeof title === 'string' && title.trim()) return truncate(title.trim())
  }
  if (name === 'web_fetch' || name === 'browser_navigate') {
    const url = args.url
    if (typeof url === 'string') return truncate(url)
  }
  if (name === 'web_search' || name === 'browser_search') {
    const query = args.query
    if (typeof query === 'string') return truncate(query)
  }
  if (
    name === 'browser_click' ||
    name === 'browser_type' ||
    name === 'browser_fill' ||
    name === 'browser_scroll' ||
    name === 'browser_wait_for_selector' ||
    name === 'browser_select_option' ||
    name === 'browser_hover'
  ) {
    const selector = args.selector
    if (typeof selector === 'string' && selector.trim()) return truncate(selector)
    if (name === 'browser_type') {
      const text = args.text
      if (typeof text === 'string') return truncate(text)
    }
    if (name === 'browser_fill') {
      const value = args.value
      if (typeof value === 'string') return truncate(value)
    }
    if (name === 'browser_scroll') {
      const dx = typeof args.deltaX === 'number' ? args.deltaX : 0
      const dy = typeof args.deltaY === 'number' ? args.deltaY : 0
      if (dx !== 0 || dy !== 0) return `Δ(${dx},${dy})`
    }
  }
  if (name === 'browser_snapshot') {
    return 'page'
  }
  if (name === 'browser_tabs' || name === 'browser_handle_dialog') {
    const action = args.action
    if (typeof action === 'string') return action
  }
  if (name === 'browser_wait_for_url') {
    const match = args.match
    if (typeof match === 'string') return truncate(match)
  }
  if (name === 'browser_wait_for_text') {
    const text = args.text
    if (typeof text === 'string') return truncate(text)
  }
  if (name === 'browser_press_key') {
    const key = args.key
    if (typeof key === 'string') return key
  }
  if (name === 'mcp_list_tools') {
    const serverId =
      typeof args.serverId === 'string' && args.serverId.trim()
        ? args.serverId
        : typeof args.server_id === 'string' && args.server_id.trim()
          ? args.server_id
          : null
    if (serverId) return truncate(serverId)
    return 'mcp'
  }
  if (name === 'request_mcp_tools' || name === 'release_mcp_tools') {
    const serverId =
      typeof args.serverId === 'string' && args.serverId.trim()
        ? args.serverId
        : typeof args.server_id === 'string' && args.server_id.trim()
          ? args.server_id
          : null
    if (serverId) return truncate(serverId)
    const tools = args.tools
    if (Array.isArray(tools) && tools.length > 0) {
      const first = tools.find((t): t is string => typeof t === 'string' && t.trim().length > 0)
      if (first) {
        return tools.length === 1 ? truncate(first) : truncate(`${first} +${tools.length - 1}`)
      }
    }
    return 'mcp'
  }
  if (name === 'mcp_list_resources' || name === 'mcp_list_prompts') {
    const serverId = args.serverId
    if (typeof serverId === 'string' && serverId.trim()) return truncate(serverId)
    return 'mcp'
  }
  if (name === 'mcp_read_resource') {
    const uri = args.uri
    if (typeof uri === 'string' && uri.trim()) return truncate(uri)
  }
  if (name === 'mcp_get_prompt') {
    const promptName = args.name
    if (typeof promptName === 'string' && promptName.trim()) return truncate(promptName)
  }
  if (name === 'ask_question') {
    const title = args.title
    if (typeof title === 'string' && title.trim()) return truncate(title)
    let questions = args.questions
    // Mirror validate coerce: stringified / unclosed questions[] via parseJsonish.
    if (typeof questions === 'string') {
      const parsed = parseJsonish(questions)
      if (Array.isArray(parsed)) questions = parsed
      else if (parsed !== null && typeof parsed === 'object') questions = [parsed]
    }
    if (Array.isArray(questions) && questions.length > 0) {
      if (questions.length === 1) {
        const item = questions[0] as { prompt?: unknown; question?: unknown } | undefined
        const prompt =
          typeof item?.prompt === 'string' && item.prompt.trim()
            ? item.prompt
            : typeof item?.question === 'string' && item.question.trim()
              ? item.question
              : ''
        if (prompt) return truncate(prompt)
      }
      return `${questions.length} questions`
    }
    const question = args.question
    if (typeof question === 'string' && question.trim()) return truncate(question)
    const prompt = args.prompt
    if (typeof prompt === 'string' && prompt.trim()) return truncate(prompt)
  }
  if (name === 'switch_mode') {
    const mode = args.mode
    if (typeof mode === 'string') return mode
  }
  if (name === 'terminal') {
    const command = args.command ?? args.cmd
    if (typeof command === 'string') {
      const path = extractPathFromTerminalCommand(command)
      if (path) return formatPathTarget(path)
      return truncate(sanitizeCommandForDisplay(command))
    }
  }
  if (name === 'memory_read' || name === 'memory_write' || name === 'memory_list') {
    const path = args.path ?? args.note
    if (typeof path === 'string') return truncate(path)
  }
  if (name === 'Skill') {
    const skillName = typeof args.name === 'string' ? args.name.trim() : ''
    const path = typeof args.path === 'string' ? args.path.trim() : ''
    if (skillName && path) return truncate(`${skillName}:${path}`)
    if (skillName) return truncate(skillName)
  }
  if (name === 'spawn_agent_instance') {
    const pathScope = args.path_scope ?? args.pathScope
    if (Array.isArray(pathScope)) {
      const paths = pathScope.filter(
        (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0
      )
      if (paths.length > 0) {
        return truncate(paths.map((entry) => formatPathLabel(entry)).join(', '))
      }
    }
    const goal = args.goal
    if (typeof goal === 'string' && goal.trim()) return truncate(goal.trim())
  }
  if (name === 'await_agent_instance' || name === 'pull_agent_instance' || name === 'merge_agent_instance') {
    const runId =
      (typeof args.run_id === 'string' && args.run_id.trim()) ||
      (typeof args.runId === 'string' && args.runId.trim()) ||
      ''
    if (runId) return formatAgentInstanceShortId(runId)
  }

  const mcp = parseMcpToolDisplay(name)
  if (mcp) {
    const pathLike = firstStringArg(args, [
      'path',
      'file_path',
      'filePath',
      'filepath',
      'directory',
      'dir',
      'root',
      'uri',
      'url',
      'target'
    ])
    if (pathLike) return formatPathTarget(pathLike)
    const query = firstStringArg(args, ['query', 'pattern', 'search', 'glob'])
    if (query) return truncate(query)
    const command = firstStringArg(args, ['command', 'cmd'])
    if (command) return truncate(sanitizeCommandForDisplay(command))
  }

  const path = args.path ?? args.directory ?? args.root ?? args.workspace
  if (typeof path === 'string' && path.trim()) return formatPathTarget(path)
  const query = args.query
  if (typeof query === 'string') return truncate(query)
  return ''
}

export function summarizeToolArgsFromRecord(
  name: string,
  args: Record<string, unknown>
): string {
  const target = normalizeToolTarget(name, args)
  if (target) return target
  // No inventing past-tense done verbs as targets (avoids "Editing edited").
  return ''
}

export function summarizeToolArgs(name: string, args: string | undefined): string {
  // Placeholder names must not invent a "Tool" subtitle from streaming JSON args —
  // that produces "Running Tool Tool" and expands a raw args dump in the timeline.
  if (isUnresolvedToolName(name)) return ''
  if (name === 'await_agent_instance' || name === 'pull_agent_instance' || name === 'merge_agent_instance') {
    const runId = parseAgentInstanceRunIdFromArgs(args)
    if (runId) return formatAgentInstanceShortId(runId)
  }
  const parsed = parseArgsRecord(args)
  if (parsed) {
    const fromRecord = summarizeToolArgsFromRecord(name, parsed)
    if (fromRecord) return fromRecord
  }
  // Models sometimes emit a bare todos array; match toolArgWire wrap for streaming headers.
  if (name === 'todo_write' && args?.trim().startsWith('[')) {
    try {
      const arr = JSON.parse(args) as unknown
      if (Array.isArray(arr)) {
        const n = arr.length
        return n === 1 ? '1 task' : `${n} tasks`
      }
    } catch {
      // Incomplete JSON while streaming — wait for a real target.
    }
  }
  if (name === 'ask_question' && args?.trim().startsWith('[')) {
    try {
      const arr = JSON.parse(args) as unknown
      if (Array.isArray(arr) && arr.length > 0) {
        if (arr.length === 1) {
          const item = arr[0] as { prompt?: unknown; question?: unknown } | undefined
          const prompt =
            typeof item?.prompt === 'string' && item.prompt.trim()
              ? item.prompt
              : typeof item?.question === 'string' && item.question.trim()
                ? item.question
                : ''
          if (prompt) return truncate(prompt)
        }
        return `${arr.length} questions`
      }
    } catch {
      // Incomplete JSON while streaming — wait for a real target.
    }
  }
  if (args?.trim()) {
    const trimmed = args.trim()
    // Incomplete / unparseable JSON — wait for a real target, never done-verb fallback.
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return ''
    return truncate(trimmed.replace(/\s+/g, ' '))
  }
  return ''
}

export function mcpToolSummary(toolName: string, args: Record<string, unknown>): string {
  const target = normalizeToolTarget(`mcp__x__${toolName}`, args)
  if (target) return target
  return ''
}
