import type { SlashCommandDescriptor, SlashMcpServer } from '@shared/ipc'
import { humanizeSlashToken } from '@shared/slashCommands'
import type { IconName } from '@renderer/lib/icons'

/** Canonical group order for the slash menu (display list + labels). */
export const SLASH_GROUP_ORDER = ['Skills', 'App', 'Commands', 'Rules', 'MCP'] as const

/** Labels by data `group` id — the ids stay stable. MCP tools are labelled by server instead. */
const GROUP_DISPLAY: Record<string, string> = {
  Skills: 'Skills',
  App: 'Commands',
  Commands: 'Workspace commands',
  Rules: 'Rules',
  MCP: 'MCP'
}

export function slashGroupDisplayName(group: string): string {
  return GROUP_DISPLAY[group] ?? group
}

/**
 * How a row names its command: a command as it is typed (`/goal`), a skill or
 * rule by its name, an MCP tool by the tool's own name.
 */
export function slashRowLabel(cmd: SlashCommandDescriptor): string {
  switch (cmd.kind) {
    case 'builtin':
    case 'workspace':
      return `/${cmd.trigger}`
    case 'skill':
    case 'rule':
      return cmd.trigger
    case 'mcp':
      return cmd.mcpToolName ?? cmd.label
    default: {
      const _exhaustive: never = cmd.kind
      return _exhaustive
    }
  }
}

/** The option's accessible name: what it is, then how to type it. */
export function slashOptionName(cmd: SlashCommandDescriptor): string {
  const trigger = `/${cmd.trigger}`
  const label = cmd.label.trim()
  return label ? `${label} · ${trigger}` : trigger
}

const BUILTIN_ICON: Record<string, IconName> = {
  goal: 'target',
  loop: 'repeat',
  compact: 'stack',
  clear: 'plus',
  marketplace: 'extensions',
  settings: 'gear',
  'create-rule': 'rules',
  'create-skill': 'skill',
  help: 'question',
  undo: 'undo',
  ask: 'chat',
  plan: 'plan',
  agent: 'robot',
  'harness-review': 'checklist',
  'harness-apply': 'check'
}

/** The glyph in a row's icon slot. An MCP row shows its package's mark over this when it has one. */
export function slashRowIcon(cmd: SlashCommandDescriptor): IconName {
  switch (cmd.kind) {
    case 'builtin':
      return BUILTIN_ICON[cmd.trigger] ?? 'command'
    case 'workspace':
      return 'command'
    case 'skill':
      return 'skill'
    case 'rule':
      return 'rules'
    case 'mcp':
      return 'mcp'
    default: {
      const _exhaustive: never = cmd.kind
      return _exhaustive
    }
  }
}

/** The name of the server an MCP command belongs to: as main names it, else its id made readable. */
export function slashMcpServerName(
  serverId: string,
  servers: ReadonlyMap<string, SlashMcpServer>
): string {
  return servers.get(serverId)?.name ?? humanizeSlashToken(serverId)
}

/** The first sentence of a description, for the muted text beside a row's label. */
function firstSentence(raw: string): string {
  const flat = raw.replace(/\s+/g, ' ').trim()
  return (flat.match(/^(.+?)[.!?](?:\s|$)/)?.[1] ?? flat).trim()
}

/**
 * The muted text beside a row's label. An MCP tool names its server; a server
 * with no tools listed yet is the row itself.
 */
export function slashRowDetail(
  cmd: SlashCommandDescriptor,
  servers: ReadonlyMap<string, SlashMcpServer>
): string {
  if (cmd.kind === 'mcp') {
    if (!cmd.mcpToolName || !cmd.mcpServerId) return 'MCP server'
    return `${slashMcpServerName(cmd.mcpServerId, servers)} MCP`
  }
  return firstSentence(cmd.description)
}

/**
 * What accepting the row does, for the footer. Accepting always inserts a
 * chip; the command itself resolves when the instruction is sent — except
 * rows that are not usable yet, which install, enable or open Extensions.
 */
export function slashAcceptHint(cmd: SlashCommandDescriptor): string {
  switch (cmd.availability) {
    case 'not_installed':
      if (cmd.packageId) return 'Tab to install'
      break
    case 'disabled':
      if (cmd.packageId) return 'Tab to enable'
      break
    case 'needs_auth':
    case 'disconnected':
      return 'Tab to open it in Extensions'
    case 'ready':
      break
    default: {
      const _exhaustive: never = cmd.availability
      return _exhaustive
    }
  }
  if (cmd.kind === 'builtin') return 'Tab to insert · runs when you send'
  if (cmd.kind === 'rule') return 'Tab to insert · opens the rule when you send'
  return 'Tab to insert · runs with this instruction'
}

/** A description for the footer: whole, flattened, ending on a stop, capped at a word. */
export function slashFooterDescription(raw: string, maxLen = 180): string {
  const flat = raw.replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  if (flat.length > maxLen) {
    const cut = flat.slice(0, maxLen - 1)
    const atWord = cut.slice(0, Math.max(cut.lastIndexOf(' '), maxLen / 2)).trimEnd()
    return `${atWord.replace(/[,;:—-]+$/, '')}…`
  }
  return /[\p{L}\p{N})]$/u.test(flat) ? `${flat}.` : flat
}

/** About two lines of footer at the menu's width, its label and accept hint included. */
const SLASH_FOOTER_CHARS = 128

/** The footer's description of a row, cut so it and the accept hint fit on two lines. */
export function slashFooterText(cmd: SlashCommandDescriptor): string {
  const room = SLASH_FOOTER_CHARS - slashRowLabel(cmd).length - slashAcceptHint(cmd).length - 4
  return slashFooterDescription(cmd.description, Math.max(40, room))
}

const COMPOSER_MODE_TRIGGERS = new Set(['ask', 'plan', 'agent'])

/** Toolbar Mode picker owns mode switching. Keep `/ask` `/plan` `/agent` typable. */
export function isComposerModeSlashCommand(cmd: SlashCommandDescriptor): boolean {
  return cmd.kind === 'builtin' && COMPOSER_MODE_TRIGGERS.has(cmd.trigger)
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
  key: string
  /** The group's label, or for MCP tools their server's name. */
  label: string
  items: SlashCommandDescriptor[]
  startIndex: number
}

/**
 * Split the flat display list into labelled runs: one per group, and one per
 * server for MCP tools — there is no MCP heading above the servers.
 */
export function buildSlashMenuBlocks(
  commands: SlashCommandDescriptor[],
  servers: ReadonlyMap<string, SlashMcpServer> = new Map()
): SlashMenuBlock[] {
  const blocks: SlashMenuBlock[] = []
  commands.forEach((cmd, index) => {
    const serverId = cmd.group === 'MCP' ? (cmd.mcpServerId ?? cmd.id) : null
    const key = serverId ? `MCP:${serverId}` : cmd.group
    const last = blocks[blocks.length - 1]
    if (last?.key === key) {
      last.items.push(cmd)
      return
    }
    blocks.push({
      key,
      label: serverId ? slashMcpServerName(serverId, servers) : slashGroupDisplayName(cmd.group),
      items: [cmd],
      startIndex: index
    })
  })
  return blocks
}
