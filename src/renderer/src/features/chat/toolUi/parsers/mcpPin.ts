import type { UiToolRow } from '@shared/transcript'
import { parseArgsRecord } from '@shared/toolSummary'

export type McpPinSectionKind = 'pinned' | 'already' | 'released' | 'unknown'

export type McpPinSection = {
  kind: McpPinSectionKind
  label: string
  names: string[]
}

export type McpPinParsed = {
  filter: string
  sections: McpPinSection[]
  pinnedCount: number | null
  releasedCount: number | null
  noneMessage: string
  note: string
  message: string
}

const SECTION_LABELS: Record<McpPinSectionKind, string> = {
  pinned: 'Pinned for next step',
  already: 'Already pinned',
  released: 'Released',
  unknown: 'Unknown / unresolved'
}

/** Split handler-joined tool names; ambiguous entries keep their `(a, b)` suffix intact. */
function splitToolNames(text: string): string[] {
  const names: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(') depth += 1
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (ch === ',' && depth === 0) {
      names.push(text.slice(start, i).trim())
      start = i + 1
    }
  }
  names.push(text.slice(start).trim())
  return names.filter((name) => name.length > 0)
}

/** Mirror of the request/release branch in normalizeToolTarget (serverId, else tools list). */
function pinFilter(args: Record<string, unknown> | null): string {
  if (!args) return ''
  const serverId =
    typeof args.serverId === 'string' && args.serverId.trim()
      ? args.serverId.trim()
      : typeof args.server_id === 'string' && args.server_id.trim()
        ? args.server_id.trim()
        : ''
  if (serverId) return serverId
  const tools = args.tools
  if (Array.isArray(tools)) {
    const names = tools.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    if (names.length === 1) return names[0]!.trim()
    if (names.length > 1) return `${names[0]!.trim()} +${names.length - 1}`
  }
  return ''
}

/** Parse request_mcp_tools / release_mcp_tools status output. */
export function parseMcpPinData(tool: UiToolRow): McpPinParsed {
  const content = (tool.content ?? '').trim()
  const parsed: McpPinParsed = {
    filter: pinFilter(parseArgsRecord(tool.argsPreview)),
    sections: [],
    pinnedCount: null,
    releasedCount: null,
    noneMessage: '',
    note: '',
    message: ''
  }
  if (!content) return parsed

  const pushSection = (kind: McpPinSectionKind, text: string): void => {
    const names = splitToolNames(text)
    const existing = parsed.sections.find((section) => section.kind === kind)
    if (existing) existing.names.push(...names)
    else parsed.sections.push({ kind, label: SECTION_LABELS[kind], names })
  }

  let matched = false
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    let m: RegExpExecArray | null
    if ((m = /^Pinned for next step \((\d+)\):\s*(.+)$/.exec(line))) {
      parsed.pinnedCount = Number(m[1])
      pushSection('pinned', m[2]!)
      matched = true
    } else if ((m = /^Already pinned:\s*(.+)$/.exec(line))) {
      pushSection('already', m[1]!)
      matched = true
    } else if ((m = /^Released \((\d+)\):\s*(.+)$/.exec(line))) {
      parsed.releasedCount = Number(m[1])
      pushSection('released', m[2]!)
      matched = true
    } else if ((m = /^Unknown \/ unresolved:\s*(.+)$/.exec(line))) {
      pushSection('unknown', m[1]!)
      matched = true
    } else if (/^No new tools pinned\.?$/.test(line) || /^No pinned tools released\.?$/.test(line)) {
      parsed.noneMessage = line
      matched = true
    } else if (
      /^(Definitions are append-admitted|Schemas drop from the sticky catalog|Connected MCP tools are already in the step catalog|Pins are optional bookkeeping|No connected MCP tools for serverId=|No pinned MCP tools for serverId=)/.test(
        line
      )
    ) {
      parsed.note = parsed.note ? `${parsed.note} ${line}` : line
      matched = true
    }
    // Unrecognized lines are dropped when structured rows exist; raw fallback below otherwise.
  }

  if (!matched) parsed.message = content
  return parsed
}
