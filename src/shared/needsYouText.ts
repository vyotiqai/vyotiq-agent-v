import type { AgentQuestionRequest, ToolApprovalRequest } from './ipc'
import { TOOL_LABELS, isUnresolvedToolName, parseArgsRecord, parseMcpToolDisplay } from './utils/toolSummary'
import { humanizeSnakeCase, mcpDoneLabel } from './utils/mcpToolMeta'

const FILE_TOOLS = new Set(['edit', 'str_replace', 'delete', 'edit_notebook', 'memory_write'])

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** A tool's finished-row verb ("Fetched"), the one the task's record shows for it. */
function toolDoneLabel(name: string): string {
  // A malformed wire payload can pack the whole invocation into the name field.
  const cut = name.search(/[<(]/)
  const bare = cut > 0 ? name.slice(0, cut).trim() : name
  if (isUnresolvedToolName(name)) return 'Tool'
  const mcp = parseMcpToolDisplay(bare)
  if (mcp) return mcpDoneLabel(mcp.toolName)
  return TOOL_LABELS[bare]?.done ?? humanizeSnakeCase(bare)
}

/**
 * "Wants to run pnpm vitest run …" — what the approval would let the agent do,
 * with its target, in the words the task's own approval card uses. Home's
 * Needs you rows and the notification that asks for you both say it this way.
 */
export function approvalAsk(
  request: Pick<ToolApprovalRequest, 'name' | 'summary' | 'argsPreview'>,
  serverNames?: ReadonlyMap<string, string>
): string {
  const { name } = request
  const args = parseArgsRecord(request.argsPreview)
  const summary = oneLine(request.summary)
  if (name === 'terminal') {
    const command = typeof args?.command === 'string' && args.command.trim() ? oneLine(args.command) : summary
    return command ? `Wants to run ${command}` : 'Wants to run a command'
  }
  if (FILE_TOOLS.has(name)) {
    const verb = name === 'delete' ? 'delete' : 'change'
    const path = typeof args?.path === 'string' && args.path ? args.path : summary
    return path ? `Wants to ${verb} ${path}` : `Wants to ${verb} a file`
  }
  if (name.startsWith('browser_')) return summary ? `Wants to use the browser · ${summary}` : 'Wants to use the browser'
  const mcp = parseMcpToolDisplay(name)
  if (mcp) return `Wants to use ${serverNames?.get(mcp.serverId) ?? mcp.serverId} · ${mcp.toolName}`
  const label = toolDoneLabel(name).toLowerCase()
  return summary ? `Wants to use ${label} · ${summary}` : `Wants to use ${label}`
}

/** The question the agent asked, or how many it asked at once. */
export function questionAsk(request: Pick<AgentQuestionRequest, 'title' | 'questions'>): string {
  const count = request.questions.length
  if (count > 1) return request.title ? `Asks ${count} questions · ${oneLine(request.title)}` : `Asks ${count} questions`
  const prompt = request.questions[0]?.prompt
  return prompt ? `Asks: ${oneLine(prompt)}` : 'Has a question for you'
}
