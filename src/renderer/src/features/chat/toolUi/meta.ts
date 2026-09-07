import type { UiToolRow } from '@shared/transcript'
import {
  MCP_TOOL_PREFIX,
  TOOL_LABELS,
  inferFileWriteAction,
  isUnresolvedToolName,
  parseArgsRecord,
  parseMcpToolDisplay
} from '@shared/toolSummary'
import { mcpDoneLabel, mcpRunningLabel, mcpToolKind, humanizeSnakeCase } from '@shared/utils/mcpToolMeta'
import { isReadOnlyTerminalCommand } from '@shared/utils/displayPath'
import type { IconName } from '@renderer/lib/icons'
import type { ToolCategory, ToolPresentation } from './types'

/** Terminal + edit/diff tools get bordered cards; everything else stays compact. */
const PROMINENT_TOOLS = new Set([
  'terminal',
  'edit',
  'str_replace'
])

const FILE_TOOLS = new Set(['read', 'memory_read'])
const EDIT_TOOLS = new Set([
  'edit',
  'str_replace',
  'memory_write',
  'delete',
  'edit_notebook'
])
const SEARCH_TOOLS = new Set([
  'search',
  'grep',
  'codebase_search',
  'glob',
  'web_fetch',
  'web_search',
  'mcp_list_tools',
  'mcp_list_resources',
  'mcp_read_resource',
  'mcp_list_prompts',
  'mcp_get_prompt',
  'request_mcp_tools',
  'release_mcp_tools',
  'ask_question',
  'switch_mode',
  'todo_write',
  'create_goal',
  'update_goal',
  'spawn_agent_instance',
  'await_agent_instance',
  'pull_agent_instance',
  'merge_agent_instance',
  'cancel_agent_instance',
  'git_status',
  'git_diff',
  'Skill',
  'lsp'
])
const BROWSER_TOOLS = new Set([
  'browser_navigate',
  'browser_search',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_scroll',
  'browser_fill',
  'browser_tabs',
  'browser_back',
  'browser_forward',
  'browser_wait_for_selector',
  'browser_wait_for_url',
  'browser_wait_for_text',
  'browser_hover',
  'browser_handle_dialog',
  'browser_press_key',
  'browser_select_option'
])
const BROWSE_TOOLS = new Set(['list_dir', 'memory_list'])
const COMMAND_TOOLS = new Set(['terminal', 'diagnostics', 'git_commit'])

const CATEGORY_LABELS: Record<ToolCategory, { running: string; done: string }> = {
  file: { running: 'Reading', done: 'Read' },
  edit: { running: 'Editing', done: 'Edited' },
  search: { running: 'Searching', done: 'Searched' },
  command: { running: 'Running', done: 'Ran' },
  browse: { running: 'Listing', done: 'Listed' },
  browser: { running: 'Browsing', done: 'Browsed' }
}

const MIXED_LABELS = { running: 'Exploring', done: 'Explored' }

export function isProminentTool(
  name: string,
  argsPreview?: string,
  summary?: string
): boolean {
  if (!PROMINENT_TOOLS.has(name)) return false
  if (name === 'terminal') {
    const args = argsPreview ? parseArgsRecord(argsPreview) : null
    const fromArgs = args?.command ?? args?.cmd
    const command =
      typeof fromArgs === 'string'
        ? fromArgs
        : typeof summary === 'string'
          ? summary
          : null
    if (command && isReadOnlyTerminalCommand(command)) return false
  }
  return true
}

/** Shared card vs compact decision — respects locked presentation when set. */
export function isProminentPresentation(tool: {
  name: string
  argsPreview?: string
  summary?: string
  presentation?: ToolPresentation
}): boolean {
  if (tool.presentation) return tool.presentation === 'prominent'
  return isProminentTool(tool.name, tool.argsPreview, tool.summary)
}

export function toolPresentation(
  name: string,
  argsPreview?: string,
  summary?: string
): ToolPresentation {
  return isProminentTool(name, argsPreview, summary) ? 'prominent' : 'compact'
}

export function mcpToolCategory(toolName: string): ToolCategory {
  const kind = mcpToolKind(toolName)
  switch (kind) {
    case 'file':
      return 'file'
    case 'browse':
      return 'browse'
    case 'command':
      return 'command'
    case 'search':
      return 'search'
    case 'other':
      return 'search'
    default: {
      const _exhaustive: never = kind
      return _exhaustive
    }
  }
}

export function toolCategory(name: string): ToolCategory {
  if (FILE_TOOLS.has(name)) return 'file'
  if (EDIT_TOOLS.has(name)) return 'edit'
  if (BROWSER_TOOLS.has(name)) return 'browser'
  if (SEARCH_TOOLS.has(name)) return 'search'
  if (BROWSE_TOOLS.has(name)) return 'browse'
  if (COMMAND_TOOLS.has(name)) return 'command'
  const mcp = parseMcpToolDisplay(name)
  if (mcp) return mcpToolCategory(mcp.toolName)
  return 'file'
}

/** Settled tool content written when a run is aborted before the tool finishes. */
const INTERRUPTED_TOOL_CONTENT = new Set([
  'Cancelled',
  'Interrupted',
  'Stopped',
  'Not completed',
  'Connection lost'
])

export function isInterruptedToolContent(content: string | undefined | null): boolean {
  return INTERRUPTED_TOOL_CONTENT.has(content ?? '')
}

/**
 * Human verb for a tool row. Interrupted tools never completed, so they use the
 * in-progress form (e.g. "Asking") rather than past tense ("Asked").
 */
export function toolLabel(
  name: string,
  status: UiToolRow['status'],
  content?: string | null
): string {
  const effectiveStatus =
    isInterruptedToolContent(content) && status !== 'running' ? 'running' : status
  if (isUnresolvedToolName(name)) {
    return effectiveStatus === 'running' ? 'Preparing…' : 'Tool'
  }
  const mcp = parseMcpToolDisplay(name)
  if (mcp) {
    return effectiveStatus === 'running'
      ? mcpRunningLabel(mcp.toolName)
      : mcpDoneLabel(mcp.toolName)
  }
  if (effectiveStatus === 'fail') {
    // Known builtins: Failed. Unknown names keep the humanized tool id so the row is identifiable.
    if (TOOL_LABELS[name]) return 'Failed'
    return humanizeSnakeCase(name)
  }
  const labels = TOOL_LABELS[name]
  if (!labels) {
    const human = humanizeSnakeCase(name)
    return effectiveStatus === 'running' ? `Running ${human}` : human
  }
  if (effectiveStatus !== 'running' && inferFileWriteAction(name, content) === 'created') {
    return 'Created'
  }
  return effectiveStatus === 'running' ? labels.running : labels.done
}

export function categoryLabels(category: ToolCategory): { running: string; done: string } {
  return CATEGORY_LABELS[category]
}

export function mixedGroupLabels(): { running: string; done: string } {
  return MIXED_LABELS
}

export function isMcpTool(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX)
}

const TOOL_ICON_BY_NAME: Record<string, IconName> = {
  read: 'file',
  edit: 'edit',
  str_replace: 'edit',
  search: 'fileSearch',
  grep: 'scanSearch',
  codebase_search: 'scanSearch',
  glob: 'folderSearch',
  list_dir: 'folderOpen',
  delete: 'trash',
  todo_write: 'listTodo',
  create_goal: 'flag',
  update_goal: 'flag',
  web_fetch: 'globe',
  web_search: 'globe',
  browser_navigate: 'globe',
  browser_search: 'globe',
  browser_snapshot: 'globe',
  browser_click: 'globe',
  browser_type: 'globe',
  browser_scroll: 'globe',
  browser_fill: 'globe',
  browser_tabs: 'globe',
  browser_back: 'globe',
  browser_forward: 'globe',
  browser_wait_for_selector: 'globe',
  browser_wait_for_url: 'globe',
  browser_wait_for_text: 'globe',
  browser_hover: 'globe',
  browser_handle_dialog: 'globe',
  browser_press_key: 'globe',
  browser_select_option: 'globe',
  mcp_list_tools: 'plug',
  mcp_list_resources: 'plug',
  mcp_read_resource: 'plug',
  mcp_list_prompts: 'plug',
  mcp_get_prompt: 'plug',
  request_mcp_tools: 'plug',
  release_mcp_tools: 'plug',
  ask_question: 'sparkles',
  switch_mode: 'bot',
  Skill: 'sparkles',
  terminal: 'terminal',
  memory_list: 'memory',
  memory_read: 'memory',
  memory_write: 'memory',
  git_status: 'branch',
  git_diff: 'branch',
  git_commit: 'branch',
  spawn_agent_instance: 'bot',
  await_agent_instance: 'cpu',
  pull_agent_instance: 'cpu',
  merge_agent_instance: 'branch',
  cancel_agent_instance: 'close',
  diagnostics: 'scanSearch',
  run_tests: 'scanSearch',
  git_apply: 'branch',
  github_pr_create: 'branch',
  github_pr_review: 'branch',
  github_issue: 'branch',
  edit_notebook: 'file',
  lsp: 'scanSearch',
  create_plan: 'listTodo'
}

export function toolIconName(name: string): IconName {
  if (isMcpTool(name)) return 'plug'
  return TOOL_ICON_BY_NAME[name] ?? 'file'
}
