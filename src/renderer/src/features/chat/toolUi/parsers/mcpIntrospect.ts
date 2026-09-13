import type { UiToolRow } from '@shared/transcript'
import { parseArgsRecord } from '@shared/toolSummary'

export type McpListToolRow = {
  name: string
  readOnly: boolean | null
  omitted: boolean
  description: string
}

export type McpListEntryRow = {
  serverId: string
  label: string
  meta: string
}

export type McpPromptBlock = {
  role: string
  text: string
}

export type McpIntrospectParsed = {
  kind: 'tools' | 'resources' | 'prompts' | 'resource' | 'prompt' | 'message'
  filter: string
  tools: McpListToolRow[]
  entries: McpListEntryRow[]
  blocks: McpPromptBlock[]
  text: string
  message: string
}

function parseListToolLine(line: string): McpListToolRow | null {
  const m = line
    .trim()
    .match(
      /^-\s+(\S+)((?:\s+readOnlyHint=(?:true|false))?)((?:\s+\[omitted from this step catalog\])?)(?::\s*(.*))?$/
    )
  if (!m) return null
  const hint = m[2]?.trim()
  let readOnly: boolean | null = null
  if (hint === 'readOnlyHint=true') readOnly = true
  else if (hint === 'readOnlyHint=false') readOnly = false
  return {
    name: m[1]!,
    readOnly,
    omitted: Boolean(m[3]?.trim()),
    description: (m[4] ?? '').trim()
  }
}

/** Newline rows, or a single collapsed line of `- mcp__…` bullets. */
function listToolCandidateLines(content: string): string[] {
  const trimmed = content.trim()
  if (!trimmed) return []
  if (/\r?\n/.test(trimmed)) return trimmed.split(/\r?\n/)
  if (trimmed.includes(' - mcp__')) return trimmed.split(/(?= - mcp__)/)
  return [trimmed]
}

function parseBracketEntry(line: string): McpListEntryRow | null {
  const m = line.match(/^-\s+\[([^\]]+)\]\s+(.+)$/)
  if (!m) return null
  const rest = m[2]!
  const colon = rest.indexOf(': ')
  if (colon >= 0) {
    return {
      serverId: m[1]!,
      label: rest.slice(0, colon).trim(),
      meta: rest.slice(colon + 2).trim()
    }
  }
  return { serverId: m[1]!, label: rest.trim(), meta: '' }
}

function parsePromptBlocks(content: string): { description: string; blocks: McpPromptBlock[] } {
  const parts = content.split(/\n\n+/)
  const blocks: McpPromptBlock[] = []
  let description = ''
  for (const part of parts) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const roleMatch = /^(user|assistant|system):\s*([\s\S]*)$/i.exec(trimmed)
    if (roleMatch) {
      blocks.push({ role: roleMatch[1]!.toLowerCase(), text: roleMatch[2]!.trim() })
      continue
    }
    if (blocks.length === 0 && !description) {
      description = trimmed
      continue
    }
    blocks.push({ role: '', text: trimmed })
  }
  return { description, blocks }
}

/** Parse built-in mcp_list_* / mcp_read_resource / mcp_get_prompt tool content. */
export function parseMcpIntrospectData(tool: UiToolRow): McpIntrospectParsed {
  const args = parseArgsRecord(tool.argsPreview)
  const filter =
    typeof args?.serverId === 'string'
      ? args.serverId
      : typeof args?.server_id === 'string'
        ? args.server_id
        : typeof args?.uri === 'string'
          ? args.uri
          : typeof args?.name === 'string'
            ? args.name
            : ''
  const content = (tool.content ?? '').trim()
  const empty = {
    kind: 'message' as const,
    filter,
    tools: [] as McpListToolRow[],
    entries: [] as McpListEntryRow[],
    blocks: [] as McpPromptBlock[],
    text: '',
    message: content
  }

  if (!content) return empty

  switch (tool.name) {
    case 'mcp_list_tools': {
      if (/^No MCP tools/i.test(content)) return { ...empty, message: content }
      const tools = listToolCandidateLines(content)
        .map((line) => parseListToolLine(line.trim()))
        .filter((row): row is McpListToolRow => row !== null)
      return {
        kind: 'tools',
        filter,
        tools,
        entries: [],
        blocks: [],
        text: '',
        message: tools.length === 0 ? content : ''
      }
    }
    case 'mcp_list_resources':
    case 'mcp_list_prompts': {
      if (/^No MCP (resources|prompts)/i.test(content)) return { ...empty, message: content }
      const entries = content
        .split(/\r?\n/)
        .map((line) => parseBracketEntry(line.trim()))
        .filter((row): row is McpListEntryRow => row !== null)
      return {
        kind: tool.name === 'mcp_list_resources' ? 'resources' : 'prompts',
        filter,
        tools: [],
        entries,
        blocks: [],
        text: '',
        message: entries.length === 0 ? content : ''
      }
    }
    case 'mcp_read_resource': {
      return {
        kind: 'resource',
        filter,
        tools: [],
        entries: [],
        blocks: [],
        text: content,
        message: ''
      }
    }
    case 'mcp_get_prompt': {
      const { description, blocks } = parsePromptBlocks(content)
      return {
        kind: 'prompt',
        filter,
        tools: [],
        entries: [],
        blocks,
        text: description,
        message: blocks.length === 0 && !description ? content : ''
      }
    }
    default:
      return empty
  }
}
