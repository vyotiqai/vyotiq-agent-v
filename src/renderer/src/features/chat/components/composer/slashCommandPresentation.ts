import type { SlashCommandDescriptor } from '@shared/ipc'
import { humanizeSlashToken } from '@shared/slashCommands'

/** Canonical group order for the slash menu (display list + headers). */
export const SLASH_GROUP_ORDER = ['App', 'Commands', 'Skills', 'Rules', 'MCP'] as const

/** Human-readable category titles — keep data `group` ids stable. */
const GROUP_DISPLAY: Record<string, string> = {
  App: 'Built-in',
  Commands: 'Workspace',
  Skills: 'Skills',
  Rules: 'Rules',
  MCP: 'MCP'
}

/** Hide row secondary when the typed trigger is long (MCP server-tool keys). */
const SECONDARY_TRIGGER_MAX = 28

export function slashGroupDisplayName(group: string): string {
  return GROUP_DISPLAY[group] ?? group
}

/**
 * Primary = what to read; secondary = how to type it.
 * Always prefer a human label when the catalog has one so `/create-rule`
 * and `Create rule` do not look like different kinds of row.
 * Omits long MCP triggers from the secondary line (still in `title`).
 */
export function slashCommandRowCopy(cmd: SlashCommandDescriptor): {
  primary: string
  secondary: string | null
  title: string
} {
  const trigger = `/${cmd.trigger}`
  const label = cmd.label.trim()
  if (!label) {
    return { primary: trigger, secondary: null, title: trigger }
  }
  const showSecondary = trigger.length <= SECONDARY_TRIGGER_MAX
  return {
    primary: label,
    secondary: showSecondary ? trigger : null,
    title: `${label} · ${trigger}`
  }
}

const COMPOSER_MODE_TRIGGERS = new Set(['ask', 'agent'])

/** Toolbar Mode picker owns mode switching. Keep `/ask` and `/agent` typable. */
export function isComposerModeSlashCommand(cmd: SlashCommandDescriptor): boolean {
  return cmd.kind === 'builtin' && COMPOSER_MODE_TRIGGERS.has(cmd.trigger)
}

/** First sentence / clause, capped for the menu footer. */
export function truncateSlashDescription(raw: string, maxLen = 140): string {
  const flat = raw.replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  const sentence = flat.match(/^(.+?[.!?])(?:\s|$)/)
  const base = sentence?.[1] ?? flat
  if (base.length <= maxLen) return base
  return `${base.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`
}

export function mcpServerDisplayName(cmd: SlashCommandDescriptor): string | null {
  if (cmd.kind !== 'mcp' || !cmd.mcpServerId) return null
  return humanizeSlashToken(cmd.mcpServerId)
}

/** Ready commands first; preserves relative order within each band (fuzzy rank). */
export function partitionSlashGroupByAvailability(
  items: SlashCommandDescriptor[]
): SlashCommandDescriptor[] {
  const ready: SlashCommandDescriptor[] = []
  const rest: SlashCommandDescriptor[] = []
  for (const item of items) {
    if (item.availability === 'ready') ready.push(item)
    else rest.push(item)
  }
  return ready.length === 0 || rest.length === 0 ? items : [...ready, ...rest]
}

/** Keep MCP tools clustered by server after fuzzy filter / availability partition. */
export function clusterMcpByServer(
  items: SlashCommandDescriptor[]
): SlashCommandDescriptor[] {
  if (items.length === 0 || items[0]?.group !== 'MCP') return items
  const byServer = new Map<string, SlashCommandDescriptor[]>()
  const order: string[] = []
  for (const item of items) {
    const key = item.mcpServerId ?? item.id
    const list = byServer.get(key)
    if (list) list.push(item)
    else {
      byServer.set(key, [item])
      order.push(key)
    }
  }
  return order.flatMap((key) => byServer.get(key) ?? [])
}

export type SlashMenuBlock = {
  serverLabel: string | null
  items: SlashCommandDescriptor[]
  startIndex: number
}

export type SlashMenuSection = {
  group: string
  startIndex: number
  blocks: SlashMenuBlock[]
}

/** Split a flat display list into category sections and MCP server blocks. */
export function buildSlashMenuSections(
  commands: SlashCommandDescriptor[]
): SlashMenuSection[] {
  const sections: SlashMenuSection[] = []
  let i = 0
  while (i < commands.length) {
    const group = commands[i]!.group
    const startIndex = i
    const groupItems: SlashCommandDescriptor[] = []
    while (i < commands.length && commands[i]!.group === group) {
      groupItems.push(commands[i]!)
      i += 1
    }

    const blocks: SlashMenuBlock[] = []
    if (group === 'MCP') {
      let j = 0
      while (j < groupItems.length) {
        const serverId = groupItems[j]!.mcpServerId ?? groupItems[j]!.id
        const serverLabel = mcpServerDisplayName(groupItems[j]!) ?? humanizeSlashToken(serverId)
        const blockItems: SlashCommandDescriptor[] = []
        const blockStart = startIndex + j
        while (
          j < groupItems.length &&
          (groupItems[j]!.mcpServerId ?? groupItems[j]!.id) === serverId
        ) {
          blockItems.push(groupItems[j]!)
          j += 1
        }
        blocks.push({ serverLabel, items: blockItems, startIndex: blockStart })
      }
    } else {
      blocks.push({ serverLabel: null, items: groupItems, startIndex })
    }

    sections.push({ group, startIndex, blocks })
  }
  return sections
}
