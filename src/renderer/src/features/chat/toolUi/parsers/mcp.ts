import type { UiToolRow } from '@shared/transcript'
import { parseArgsRecord, parseMcpToolDisplay } from '@shared/toolSummary'
import { splitLines } from './common'

export type McpResultView =
  | { kind: 'paths'; paths: string[] }
  | { kind: 'code'; lines: string[] }
  | { kind: 'lines'; lines: string[] }
  | { kind: 'text'; text: string }

export type McpParsed = {
  serverId: string
  serverName: string
  toolName: string
  args: Record<string, unknown> | null
  result: string
  isError: boolean
  resultView: McpResultView
}

export function parseMcpResultView(toolName: string, content: string): McpResultView {
  const n = toolName.toLowerCase()
  const trimmed = content.trim()

  if (n.includes('allowed_director') || /^Allowed directories:/i.test(trimmed)) {
    const paths = trimmed
      .replace(/^Allowed directories:\s*/i, '')
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
    return { kind: 'paths', paths }
  }

  if (n.includes('read') && (n.includes('file') || n.includes('text'))) {
    const text = trimmed.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '')
    return { kind: 'code', lines: splitLines(text) }
  }

  if (n.includes('directory') || n.includes('tree') || n.startsWith('list_')) {
    const lines = splitLines(trimmed).filter(Boolean)
    if (lines.length > 0) return { kind: 'lines', lines }
  }

  return { kind: 'text', text: trimmed }
}

export function parseMcpData(
  tool: UiToolRow,
  mcpServerNames?: ReadonlyMap<string, string>
): McpParsed {
  const display = parseMcpToolDisplay(tool.name)
  const args = parseArgsRecord(tool.argsPreview)
  const content = tool.content ?? ''
  const isError =
    tool.status === 'fail' ||
    (content.startsWith('[MCP') && /error/i.test(content)) ||
    /MCP invoke failed/i.test(content)
  const serverId = display?.serverId ?? 'unknown'
  const serverName = mcpServerNames?.get(serverId) ?? serverId
  const toolName = display?.toolName ?? tool.name
  return {
    serverId,
    serverName,
    toolName,
    args,
    result: content,
    isError,
    resultView: parseMcpResultView(toolName, content)
  }
}
