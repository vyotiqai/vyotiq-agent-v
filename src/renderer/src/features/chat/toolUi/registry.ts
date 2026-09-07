import type { ComponentType } from 'react'
import type { UiToolRow } from '@shared/transcript'
import { isUnresolvedToolName, summarizeToolArgs, TOOL_LABELS } from '@shared/toolSummary'
import { formatPathLabel } from '@shared/utils/displayPath'
import { isTerminalSessionInProgress } from '@shared/utils/terminalFormat'
import { basename } from '@shared/utils/path'
import {
  BrowserActionBody,
  BrowserSnapshotBody,
  BrowserTabsBody
} from './bodies/BrowserBody'
import { DeleteBody } from './bodies/DeleteBody'
import { DiagnosticsBody } from './bodies/DiagnosticsBody'
import { EditBody } from './bodies/EditBody'
import { GitCommitBody, GitDiffBody, GitStatusBody } from './bodies/GitBody'
import { GlobBody } from './bodies/GlobBody'
import { GrepBody } from './bodies/GrepBody'
import { ListDirBody } from './bodies/ListDirBody'
import { FallbackBody, McpBody } from './bodies/McpBody'
import { McpIntrospectBody } from './bodies/McpIntrospectBody'
import { McpPinBody } from './bodies/McpPinBody'
import { MemoryListBody, MemoryReadBody, MemoryWriteBody } from './bodies/MemoryBodies'
import { ReadBody } from './bodies/ReadBody'
import { SearchBody } from './bodies/SearchBody'
import { CodebaseSearchBody } from './bodies/CodebaseSearchBody'
import { SkillBody } from './bodies/SkillBody'
import { StatusMessageBody } from './bodies/StatusMessageBody'
import { TerminalBody } from './bodies/TerminalBody'
import { TodoBody } from './bodies/TodoBody'
import { SpawnAgentInstanceBody, AwaitAgentInstanceBody } from './bodies/AgentInstanceBody'
import { WebFetchBody } from './bodies/WebFetchBody'
import { WebSearchBody } from './bodies/WebSearchBody'
import { isInterruptedToolContent, isMcpTool, toolIconName, toolLabel } from './meta'
import {
  parseBrowserActionData,
  parseBrowserSnapshotData,
  parseBrowserTabsData
} from './parsers/browser'
import { parseDeleteData } from './parsers/delete'
import { parseDiagnosticsData } from './parsers/diagnostics'
import { parseDiffPreview, parseEditCardData } from './parsers/edit'
import { parseGitCommitData, parseGitDiffData, parseGitStatusData } from './parsers/git'
import { parseMcpIntrospectData } from './parsers/mcpIntrospect'
import { parseMcpPinData } from './parsers/mcpPin'
import { parseReadData } from './parsers/read'
import { parseStatusMessageData } from './parsers/status'
import { parseTodoData } from './parsers/todo'
import { formatTerminalHeaderTarget, parseTerminalCardData } from './parsers/terminal'
import type { ToolBodyProps, ToolHeaderMeta } from './types'

type ToolBodyCtx = {
  toolProgress?: ToolBodyProps['toolProgress']
}

/** Result-only tools must not expose an empty output panel from args alone. */
const RESULT_ONLY_TOOLS = new Set([
  'search',
  'glob',
  'grep',
  'codebase_search',
  'list_dir',
  'web_fetch',
  'web_search',
  'git_status',
  'git_diff',
  'memory_list',
  'Skill',
  'diagnostics',
  'mcp_list_tools',
  'mcp_list_resources',
  'mcp_read_resource',
  'mcp_list_prompts',
  'mcp_get_prompt',
  'request_mcp_tools',
  'release_mcp_tools'
])

export type ToolRegistryEntry = {
  Body: ComponentType<ToolBodyProps>
  hasBody: (tool: UiToolRow, ctx?: ToolBodyCtx) => boolean
  headerMeta?: (tool: UiToolRow, ctx?: ToolBodyCtx) => ToolHeaderMeta
  /** Status-line only — never expand, including while running. */
  headerOnly?: boolean
}

function editHasBody(tool: UiToolRow): boolean {
  // Chrome-only empty args (DeepSeek name-then-dump) must not mount an empty
  // peek. Open when a real line exists, or when a finished receipt has text.
  if (parseDiffPreview(tool, { maxLines: 1 }).length > 0) return true
  if ((tool.content ?? '').trim()) return true
  return false
}

function terminalHasBody(tool: UiToolRow): boolean {
  const data = parseTerminalCardData(tool)
  // Command alone is enough — show `$ …` in the fixed viewport before streams arrive.
  return Boolean(data.command || data.output || data.stderr || data.cwd || data.shell)
}

function todoHasBody(tool: UiToolRow): boolean {
  return parseTodoData(tool).items.length > 0
}

function gitStatusHasBody(tool: UiToolRow): boolean {
  const data = parseGitStatusData(tool)
  return Boolean(data.message || data.branch || data.files.length > 0 || tool.content)
}

function gitDiffHasBody(tool: UiToolRow): boolean {
  return resultHasBody(tool)
}

function gitCommitHasBody(tool: UiToolRow): boolean {
  const data = parseGitCommitData(tool)
  return Boolean(data.message || data.hash || data.detail || data.summary || tool.content)
}

function deleteHasBody(tool: UiToolRow): boolean {
  const data = parseDeleteData(tool)
  // The compact row already communicates the normal success receipt. Keep an
  // expand affordance only when the body contains additional information.
  const defaultMessage = `Deleted ${data.path}`
  return data.recursive || data.message !== defaultMessage
}

function contentHasBody(tool: UiToolRow): boolean {
  return Boolean((tool.content ?? '').trim())
}

function resultHasBody(tool: UiToolRow): boolean {
  return Boolean((tool.content ?? '').trim() || tool.contentTruncated)
}

function defaultHasBody(tool: UiToolRow): boolean {
  return Boolean(tool.content || tool.argsPreview)
}

function browserSnapshotHasBody(tool: UiToolRow): boolean {
  const data = parseBrowserSnapshotData(tool)
  return Boolean(data.url || data.refs.length > 0 || data.body || data.message || tool.content)
}

function browserTabsHasBody(tool: UiToolRow): boolean {
  const data = parseBrowserTabsData(tool)
  return Boolean(data.tabs.length > 0 || data.message || tool.content)
}

function browserActionHasBody(tool: UiToolRow): boolean {
  const data = parseBrowserActionData(tool)
  return Boolean(data.message || (tool.status === 'running' && data.target) || tool.contentTruncated)
}

function diagnosticsHasBody(tool: UiToolRow): boolean {
  return resultHasBody(tool)
}

function mcpIntrospectHasBody(tool: UiToolRow): boolean {
  const data = parseMcpIntrospectData(tool)
  if (
    data.tools.length > 0 ||
    data.entries.length > 0 ||
    data.blocks.length > 0 ||
    Boolean(data.text)
  ) {
    return true
  }
  // Empty catalog notices belong in the header, not a second collapsed paragraph.
  if (data.message && /^No MCP /i.test(data.message)) return false
  return resultHasBody(tool)
}

function statusMessageHasBody(tool: UiToolRow): boolean {
  const data = parseStatusMessageData(tool)
  return Boolean(data.message || data.answers.length > 0)
}

function mcpPinHasBody(tool: UiToolRow): boolean {
  return resultHasBody(tool)
}

const browserActionEntry: ToolRegistryEntry = {
  Body: BrowserActionBody,
  hasBody: browserActionHasBody,
  headerMeta: (tool) => {
    const data = parseBrowserActionData(tool)
    return {
      verb: toolLabel(tool.name, tool.status),
      target: data.target || tool.summary,
      icon: 'globe'
    }
  }
}

const mcpIntrospectEntry: ToolRegistryEntry = {
  Body: McpIntrospectBody,
  hasBody: mcpIntrospectHasBody,
  headerMeta: (tool) => {
    const data = parseMcpIntrospectData(tool)
    const emptyCatalog = Boolean(data.message && /^No MCP /i.test(data.message))
    const toolCount =
      data.kind === 'tools' && data.tools.length > 0
        ? `${data.tools.length} ${data.tools.length === 1 ? 'tool' : 'tools'}`
        : ''
    return {
      verb: toolLabel(tool.name, tool.status),
      target: data.filter || toolCount || (emptyCatalog ? 'none' : '') || tool.summary,
      icon: 'plug'
    }
  }
}

const mcpPinEntry: ToolRegistryEntry = {
  Body: McpPinBody,
  hasBody: mcpPinHasBody,
  headerMeta: (tool) => {
    const data = parseMcpPinData(tool)
    return {
      verb: toolLabel(tool.name, tool.status),
      target: data.filter || tool.summary,
      icon: 'plug'
    }
  }
}

const BUILTIN_REGISTRY: Record<string, ToolRegistryEntry> = {
  read: {
    Body: ReadBody,
    hasBody: resultHasBody,
    headerMeta: (tool) => {
      const data = parseReadData(tool)
      const name = basename(data.path) || data.path
      const target = data.lineRange ? `${name} ${data.lineRange}` : name
      return {
        verb: toolLabel(tool.name, tool.status),
        target,
        filePath: data.path
      }
    }
  },
  edit: {
    Body: EditBody,
    hasBody: editHasBody,
    headerMeta: (tool) => {
      const edit = parseEditCardData(tool)
      return {
        verb: toolLabel(tool.name, tool.status, tool.content),
        target: basename(edit.path) || edit.path,
        added: edit.added,
        removed: edit.removed,
        ...(edit.iconPath
          ? { filePath: edit.iconPath }
          : { icon: toolIconName(tool.name) })
      }
    }
  },
  str_replace: {
    Body: EditBody,
    hasBody: editHasBody,
    headerMeta: (tool) => {
      const edit = parseEditCardData(tool)
      return {
        verb: toolLabel(tool.name, tool.status, tool.content),
        target: basename(edit.path) || edit.path,
        added: edit.added,
        removed: edit.removed,
        ...(edit.iconPath
          ? { filePath: edit.iconPath }
          : { icon: toolIconName(tool.name) })
      }
    }
  },
  search: {
    Body: SearchBody,
    hasBody: resultHasBody,
    headerMeta: (tool) => ({
      verb: toolLabel(tool.name, tool.status),
      target: tool.summary,
      icon: 'fileSearch'
    })
  },
  glob: {
    Body: GlobBody,
    hasBody: resultHasBody,
    headerMeta: (tool) => ({
      verb: toolLabel(tool.name, tool.status),
      target: tool.summary,
      icon: 'folderSearch'
    })
  },
  grep: {
    Body: GrepBody,
    hasBody: resultHasBody,
    headerMeta: (tool) => ({
      verb: toolLabel(tool.name, tool.status),
      target: tool.summary,
      icon: 'scanSearch'
    })
  },
  codebase_search: {
    Body: CodebaseSearchBody,
    hasBody: resultHasBody,
    headerMeta: (tool) => ({
      verb: toolLabel(tool.name, tool.status),
      target: tool.summary,
      icon: 'scanSearch'
    })
  },
  list_dir: {
    Body: ListDirBody,
    hasBody: resultHasBody,
    headerMeta: (tool) => ({
      verb: toolLabel(tool.name, tool.status),
      target: tool.summary,
      icon: 'folderOpen'
    })
  },
  delete: {
    Body: DeleteBody,
    hasBody: deleteHasBody,
    headerMeta: (tool) => {
      const data = parseDeleteData(tool)
      return {
        verb: toolLabel(tool.name, tool.status),
        target: basename(data.path),
        ...(data.path ? { filePath: data.path } : { icon: 'trash' })
      }
    }
  },
  todo_write: {
    Body: TodoBody,
    hasBody: todoHasBody,
    headerMeta: (tool) => {
      const data = parseTodoData(tool)
      // On failure the summary is the args label ("2 tasks"); the actionable
      // text is the validation error in content. Surface its first line.
      const target =
        tool.status !== 'fail'
          ? data.total > 0
            ? `${data.done}/${data.total} complete`
            : tool.summary
          : (tool.content?.split('\n', 1)[0]?.trim() || tool.summary)
      return {
        verb: toolLabel(tool.name, tool.status),
        target,
        icon: 'listTodo'
      }
    }
  },
  create_goal: {
    Body: StatusMessageBody,
    hasBody: () => false,
    headerOnly: true,
    headerMeta: (tool) => ({
      verb: toolLabel(tool.name, tool.status),
      target: tool.summary,
      icon: 'flag'
    })
  },
  update_goal: {
    Body: StatusMessageBody,
    hasBody: () => false,
    headerOnly: true,
    headerMeta: (tool) => ({
      verb: toolLabel(tool.name, tool.status),
      target: tool.summary,
      icon: 'flag'
    })
  },
  web_fetch: {
    Body: WebFetchBody,
    hasBody: resultHasBody,
    headerMeta: (tool) => ({
      verb: toolLabel(tool.name, tool.status),
      target: tool.summary,
      icon: 'globe'
    })
  },
  web_search: {
    Body: WebSearchBody,
    hasBody: resultHasBody,
    headerMeta: (tool) => ({
      verb: toolLabel(tool.name, tool.status),
      target: tool.summary,
      icon: 'globe'
    })
  },
  git_status: {
    Body: GitStatusBody,
    hasBody: gitStatusHasBody,
    headerMeta: (tool) => {
      const data = parseGitStatusData(tool)
      return {
        verb: toolLabel(tool.name, tool.status),
        target: data.branch || tool.summary,
        icon: 'branch'
      }
    }
  },
  git_diff: {
    Body: GitDiffBody,
    hasBody: gitDiffHasBody,
    headerMeta: (tool) => {
      const data = parseGitDiffData(tool)
      return {
        verb: toolLabel(tool.name, tool.status),
        target: data.path ? basename(data.path) || data.path : tool.summary,
        added: data.added,
        removed: data.removed,
        ...(data.path ? { filePath: data.path } : { icon: 'branch' })
      }
    }
  },
  git_commit: {
    Body: GitCommitBody,
    hasBody: gitCommitHasBody,
    headerMeta: (tool) => {
      const data = parseGitCommitData(tool)
      return {
        verb: toolLabel(tool.name, tool.status),
        target: data.message || data.hash || tool.summary,
        icon: 'branch'
      }
    }
  },
  terminal: {
    Body: TerminalBody,
    hasBody: terminalHasBody,
    headerMeta: (tool) => {
      const data = parseTerminalCardData(tool)
      return {
        verb: toolLabel(tool.name, tool.status),
        target: formatTerminalHeaderTarget(data, tool.summary),
        icon: 'terminal',
        // Live background-session frames carry the placeholder `exit_code: -1`
        // (same rule as the main-process terminalResultOk): not a failure.
        exitCode: isTerminalSessionInProgress(data.sessionStatus) ? null : data.exitCode
      }
    }
  },
  memory_list: {
    Body: MemoryListBody,
    hasBody: resultHasBody,
    headerMeta: (tool) => ({
      verb: toolLabel(tool.name, tool.status),
      target: tool.summary,
      icon: 'memory'
    })
  },
  memory_read: {
    Body: MemoryReadBody,
    hasBody: resultHasBody,
    headerMeta: (tool) => ({
      verb: toolLabel(tool.name, tool.status),
      target: tool.summary,
      icon: 'memory'
    })
  },
  memory_write: {
    Body: MemoryWriteBody,
    hasBody: defaultHasBody,
    headerMeta: (tool) => ({
      verb: toolLabel(tool.name, tool.status),
      target: tool.summary,
      icon: 'memory'
    })
  },
  browser_navigate: browserActionEntry,
  browser_search: {
    Body: BrowserSnapshotBody,
    hasBody: browserSnapshotHasBody,
    headerMeta: (tool) => {
      const data = parseBrowserSnapshotData(tool)
      const action = parseBrowserActionData(tool)
      return {
        verb: toolLabel(tool.name, tool.status),
        target: action.target || data.title || data.url || tool.summary,
        icon: 'globe'
      }
    }
  },
  browser_click: browserActionEntry,
  browser_type: browserActionEntry,
  browser_scroll: browserActionEntry,
  browser_fill: browserActionEntry,
  browser_back: browserActionEntry,
  browser_forward: browserActionEntry,
  browser_wait_for_selector: browserActionEntry,
  browser_wait_for_url: browserActionEntry,
  browser_wait_for_text: browserActionEntry,
  browser_hover: browserActionEntry,
  browser_handle_dialog: browserActionEntry,
  browser_press_key: browserActionEntry,
  browser_select_option: browserActionEntry,
  browser_snapshot: {
    Body: BrowserSnapshotBody,
    hasBody: browserSnapshotHasBody,
    headerMeta: (tool) => {
      const data = parseBrowserSnapshotData(tool)
      return {
        verb: toolLabel(tool.name, tool.status),
        target: data.title || data.url || tool.summary,
        icon: 'globe'
      }
    }
  },
  browser_tabs: {
    Body: BrowserTabsBody,
    hasBody: browserTabsHasBody,
    headerMeta: (tool) => {
      const data = parseBrowserTabsData(tool)
      return {
        verb: toolLabel(tool.name, tool.status),
        target: data.action || tool.summary,
        icon: 'globe'
      }
    }
  },
  diagnostics: {
    Body: DiagnosticsBody,
    hasBody: diagnosticsHasBody,
    headerMeta: (tool) => {
      const data = parseDiagnosticsData(tool)
      return {
        verb: toolLabel(tool.name, tool.status),
        target: data.kind || tool.summary,
        icon: 'scanSearch'
      }
    }
  },
  spawn_agent_instance: {
    Body: SpawnAgentInstanceBody,
    hasBody: (tool) => tool.status === 'running' || Boolean(tool.content?.trim()),
    headerMeta: (tool) => ({
      verb: toolLabel(tool.name, tool.status),
      target: tool.summary,
      icon: 'bot'
    })
  },
  await_agent_instance: {
    Body: AwaitAgentInstanceBody,
    hasBody: (tool) => tool.status === 'running' || Boolean(tool.content?.trim()),
    headerMeta: (tool) => ({
      verb: toolLabel(tool.name, tool.status),
      target: tool.summary,
      icon: 'cpu'
    })
  },
  pull_agent_instance: {
    Body: AwaitAgentInstanceBody,
    hasBody: (tool) => Boolean(tool.content?.trim()),
    headerMeta: (tool) => ({
      verb: toolLabel(tool.name, tool.status),
      target: tool.summary,
      icon: 'cpu'
    })
  },
  merge_agent_instance: {
    Body: AwaitAgentInstanceBody,
    hasBody: (tool) => Boolean(tool.content?.trim()),
    headerMeta: (tool) => ({
      verb: toolLabel(tool.name, tool.status),
      target: tool.summary,
      icon: 'branch'
    })
  },
  cancel_agent_instance: {
    Body: AwaitAgentInstanceBody,
    hasBody: (tool) => Boolean(tool.content?.trim()),
    headerMeta: (tool) => ({
      verb: toolLabel(tool.name, tool.status),
      target: tool.summary,
      icon: 'close'
    })
  },
  Skill: {
    Body: SkillBody,
    hasBody: contentHasBody,
    headerMeta: (tool) => ({
      verb: toolLabel(tool.name, tool.status),
      target: tool.summary,
      icon: 'sparkles'
    })
  },
  request_mcp_tools: mcpPinEntry,
  release_mcp_tools: mcpPinEntry,
  mcp_list_tools: mcpIntrospectEntry,
  mcp_list_resources: mcpIntrospectEntry,
  mcp_read_resource: mcpIntrospectEntry,
  mcp_list_prompts: mcpIntrospectEntry,
  mcp_get_prompt: mcpIntrospectEntry,
  ask_question: {
    Body: StatusMessageBody,
    hasBody: statusMessageHasBody,
    headerMeta: (tool) => ({
      verb: toolLabel(tool.name, tool.status, tool.content),
      // Never use status chip ("Question" / "Failed") as the header target.
      target: tool.summary || summarizeToolArgs(tool.name, tool.argsPreview),
      icon: 'sparkles'
    })
  },
  switch_mode: {
    Body: StatusMessageBody,
    hasBody: statusMessageHasBody,
    headerMeta: (tool) => {
      const data = parseStatusMessageData(tool)
      return {
        verb: toolLabel(tool.name, tool.status),
        target: tool.summary || data.chip,
        icon: 'bot'
      }
    }
  },
  create_plan: {
    Body: StatusMessageBody,
    hasBody: statusMessageHasBody,
    headerMeta: (tool) => ({
      verb: toolLabel(tool.name, tool.status),
      target: tool.summary,
      icon: 'listTodo'
    })
  },
  git_apply: {
    Body: StatusMessageBody,
    hasBody: contentHasBody,
    headerMeta: (tool) => ({
      verb: toolLabel(tool.name, tool.status),
      target: tool.summary,
      icon: 'branch'
    })
  },
  run_tests: {
    Body: DiagnosticsBody,
    hasBody: diagnosticsHasBody,
    headerMeta: (tool) => ({
      verb: toolLabel(tool.name, tool.status),
      target: tool.summary,
      icon: 'scanSearch'
    })
  },
  github_pr_create: {
    Body: StatusMessageBody,
    hasBody: contentHasBody,
    headerMeta: (tool) => ({
      verb: toolLabel(tool.name, tool.status),
      target: tool.summary,
      icon: 'branch'
    })
  },
  github_pr_review: {
    Body: StatusMessageBody,
    hasBody: contentHasBody,
    headerMeta: (tool) => ({
      verb: toolLabel(tool.name, tool.status),
      target: tool.summary,
      icon: 'branch'
    })
  },
  github_issue: {
    Body: StatusMessageBody,
    hasBody: contentHasBody,
    headerMeta: (tool) => ({
      verb: toolLabel(tool.name, tool.status),
      target: tool.summary,
      icon: 'branch'
    })
  },
  edit_notebook: {
    Body: StatusMessageBody,
    hasBody: contentHasBody,
    headerMeta: (tool) => ({
      verb: toolLabel(tool.name, tool.status, tool.content),
      target: tool.summary,
      icon: 'file'
    })
  },
  lsp: {
    Body: DiagnosticsBody,
    hasBody: diagnosticsHasBody,
    headerMeta: (tool) => ({
      verb: toolLabel(tool.name, tool.status),
      target: tool.summary,
      icon: 'scanSearch'
    })
  }
}

const MCP_ENTRY: ToolRegistryEntry = {
  Body: McpBody,
  hasBody: contentHasBody,
  headerMeta: (tool) => ({
    verb: toolLabel(tool.name, tool.status),
    target: tool.summary,
    icon: 'plug'
  })
}

const FALLBACK_ENTRY: ToolRegistryEntry = {
  Body: FallbackBody,
  hasBody: contentHasBody,
  headerMeta: (tool) => {
    const unknown = /^Unknown tool[:\s"]/i.test((tool.content ?? '').trim())
    return {
      verb: toolLabel(tool.name, tool.status, tool.content),
      // Fail unknown tools: do not show args.path (e.g. "placeholder") as target.
      target: unknown ? '' : tool.summary || summarizeToolArgs(tool.name, tool.argsPreview),
      icon: toolIconName(tool.name)
    }
  }
}

export function getToolEntry(name: string): ToolRegistryEntry {
  if (isMcpTool(name)) return MCP_ENTRY
  // Own-property only: a tool named "constructor" would otherwise resolve to an
  // inherited Object member and then be dereferenced as a registry entry.
  if (!Object.prototype.hasOwnProperty.call(BUILTIN_REGISTRY, name)) return FALLBACK_ENTRY
  return BUILTIN_REGISTRY[name] ?? FALLBACK_ENTRY
}

/** Names with a dedicated UI registry entry (includes replay-only legacy tools). */
export function registeredBuiltinToolUiNames(): string[] {
  return Object.keys(BUILTIN_REGISTRY)
}

export function getToolBody(name: string): ComponentType<ToolBodyProps> {
  return getToolEntry(name).Body
}

export function toolHasBody(tool: UiToolRow, ctx?: ToolBodyCtx): boolean {
  // Nameless streaming deltas must not expand FallbackBody with raw args JSON.
  if (isUnresolvedToolName(tool.name)) return false
  const entry = getToolEntry(tool.name)
  if (entry.headerOnly) return false
  if (tool.status === 'running') {
    // Prefer per-tool body logic when ctx carries progress state; fall
    // back to args/summary/content for generic running tools.
    if (entry.hasBody(tool, ctx)) return true
    if (RESULT_ONLY_TOOLS.has(tool.name)) return false
    // DeleteBody's default receipt is derived from the path, so the generic
    // running fallback would show a misleading "Deleted …" before completion.
    if (tool.name === 'delete') return false
    // Read bodies cannot render args alone; avoid an expandable blank row until
    // the first content delta arrives. The completed/partial body paths above
    // still expose previews as soon as content is available.
    if (tool.name === 'read' || tool.name === 'memory_read') return false
    // Edit peek is DiffPreview. Raw args JSON (`{`, `"path"`) is not a body.
    if (tool.name === 'edit' || tool.name === 'str_replace') {
      return false
    }
    return Boolean(tool.argsPreview?.trim() || tool.summary?.trim() || tool.content?.trim())
  }
  return entry.hasBody(tool, ctx)
}

/** Drop targets that repeat the verb ("Going back back", "Editing edited"). */
function scrubRedundantTarget(name: string, verb: string, target: string | undefined): string {
  const t = target?.trim() ?? ''
  if (!t) return ''
  const tl = t.toLowerCase()
  const vl = verb.trim().toLowerCase()
  if (vl === tl || vl.endsWith(` ${tl}`)) return ''
  const labels = Object.prototype.hasOwnProperty.call(TOOL_LABELS, name)
    ? TOOL_LABELS[name]
    : undefined
  if (labels) {
    const running = labels.running.toLowerCase()
    const done = labels.done.toLowerCase()
    if (running === tl || done === tl) return ''
    if (running.endsWith(` ${tl}`) || done.endsWith(` ${tl}`)) return ''
  }
  return t
}

export function getToolHeaderMeta(tool: UiToolRow, ctx?: ToolBodyCtx): ToolHeaderMeta {
  if (isUnresolvedToolName(tool.name)) {
    return {
      verb: toolLabel(tool.name, tool.status, tool.content),
      target: '',
      icon: toolIconName(tool.name)
    }
  }
  const entry = getToolEntry(tool.name)
  const meta = entry.headerMeta
    ? entry.headerMeta(tool, ctx)
    : {
        verb: toolLabel(tool.name, tool.status, tool.content),
        target: tool.summary || summarizeToolArgs(tool.name, tool.argsPreview),
        icon: toolIconName(tool.name)
      }
  // Registry headerMeta often keys only on status; align interrupted verbs.
  const verb =
    isInterruptedToolContent(tool.content) && tool.status !== 'running'
      ? toolLabel(tool.name, 'running')
      : meta.verb
  return {
    ...meta,
    verb,
    target: scrubRedundantTarget(tool.name, verb, meta.target)
  }
}
