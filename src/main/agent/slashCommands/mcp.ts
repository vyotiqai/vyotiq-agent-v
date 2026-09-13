import type {
  MarketplaceOverrides,
  SlashCommandDescriptor,
  SlashCommandResolveResult
} from '../../../shared/ipc'
import {
  formatMcpToolInvocation,
  humanizeSlashToken,
  normalizeTrigger
} from '../../../shared/slashCommands'
import {
  getMcpServerStatus,
  listMcpToolDefinitions,
  parseMcpToolName
} from '../mcp'
import { resolveEffectiveMcpServers } from '../../marketplace/resolve'
import { hasMcpAuthToken, hasMcpOAuthState } from '../../settings/secrets'
import { mcpAuthAllowedForWorkspace } from '../../../shared/mcpApps'

function sanitizeTriggerPart(raw: string): string {
  return normalizeTrigger(raw.replace(/__/g, '-'))
}

/** List connected MCP tools as slash commands. */
export function listMcpCommands(
  marketplaceOverrides?: MarketplaceOverrides | null,
  workspacePath?: string | null
): SlashCommandDescriptor[] {
  const servers = resolveEffectiveMcpServers(marketplaceOverrides)
  const statusById = new Map(getMcpServerStatus(servers, workspacePath).map((s) => [s.id, s]))
  const tools = listMcpToolDefinitions()
  const out: SlashCommandDescriptor[] = []
  const seenTriggers = new Set<string>()

  for (const tool of tools) {
    const parsed = parseMcpToolName(tool.name)
    if (!parsed) continue
    const status = statusById.get(parsed.serverId)
    const server = servers.find((s) => s.id === parsed.serverId)
    if (!server?.enabled) continue
    if (!mcpAuthAllowedForWorkspace(server, workspacePath)) continue

    let availability: SlashCommandDescriptor['availability'] = 'ready'
    if (!status?.connected) {
      const isRemote = (server.transport ?? 'stdio') !== 'stdio'
      // Usable auth only (access token) — a mid-OAuth PKCE blob must stay needs_auth.
      const hasAuth = hasMcpAuthToken(parsed.serverId) || hasMcpOAuthState(parsed.serverId)
      availability = isRemote && !hasAuth ? 'needs_auth' : 'disconnected'
    }

    const trigger = sanitizeTriggerPart(`${parsed.serverId}-${parsed.toolName}`)
    if (!trigger || seenTriggers.has(trigger)) continue
    seenTriggers.add(trigger)

    const errHint = status?.error?.trim()
    const baseDesc = tool.description || `MCP tool ${parsed.toolName}`
    out.push({
      id: `mcp:${tool.name}`,
      trigger,
      // Server name belongs in a section header — keep the row label clean.
      label: humanizeSlashToken(parsed.toolName),
      description:
        availability !== 'ready' && errHint
          ? `${baseDesc} — ${errHint}`
          : baseDesc,
      kind: 'mcp',
      group: 'MCP',
      availability,
      mcpServerId: parsed.serverId,
      mcpToolName: parsed.toolName
    })
  }

  // Also surface enabled-but-disconnected servers with no tools listed yet
  for (const server of servers) {
    if (!server.enabled) continue
    if (!mcpAuthAllowedForWorkspace(server, workspacePath)) continue
    const status = statusById.get(server.id)
    if (status?.connected && status.toolCount > 0) continue
    // Skip if we already have tools for this server
    if (out.some((c) => c.mcpServerId === server.id)) continue
    const isRemote = (server.transport ?? 'stdio') !== 'stdio'
    const hasAuth = hasMcpAuthToken(server.id) || hasMcpOAuthState(server.id)
    const availability: SlashCommandDescriptor['availability'] =
      isRemote && !hasAuth ? 'needs_auth' : 'disconnected'
    const trigger = sanitizeTriggerPart(server.id)
    if (!trigger || seenTriggers.has(trigger)) continue
    seenTriggers.add(trigger)
    const errHint = status?.error?.trim()
    out.push({
      id: `mcp-server:${server.id}`,
      trigger,
      label: server.name || server.id,
      description: errHint
        ? `MCP server — ${errHint}`
        : 'MCP server — connect in Marketplace to use tools',
      kind: 'mcp',
      group: 'MCP',
      availability,
      mcpServerId: server.id
    })
  }

  return out.sort((a, b) => {
    const sa = a.mcpServerId ?? ''
    const sb = b.mcpServerId ?? ''
    if (sa !== sb) return sa.localeCompare(sb)
    return a.trigger.localeCompare(b.trigger)
  })
}

export function resolveMcpCommand(
  id: string,
  trailingText: string,
  marketplaceOverrides?: MarketplaceOverrides | null,
  workspacePath?: string | null
): SlashCommandResolveResult | null {
  if (id.startsWith('mcp-server:')) {
    const serverId = id.slice('mcp-server:'.length)
    return {
      action: 'client',
      clientAction: 'open_marketplace',
      mcpServerId: serverId
    }
  }
  if (!id.startsWith('mcp:')) return null
  const fullName = id.slice('mcp:'.length)
  const parsed = parseMcpToolName(fullName)
  if (!parsed) return null

  const servers = resolveEffectiveMcpServers(marketplaceOverrides)
  const server = servers.find((s) => s.id === parsed.serverId)
  if (!server?.enabled || !mcpAuthAllowedForWorkspace(server, workspacePath)) {
    return {
      action: 'client',
      clientAction: 'open_marketplace',
      mcpServerId: parsed.serverId
    }
  }

  const tools = listMcpToolDefinitions()
  const tool = tools.find((t) => t.name === fullName)
  const status = getMcpServerStatus(servers, workspacePath).find((s) => s.id === parsed.serverId)
  if (!status?.connected || !tool) {
    return {
      action: 'client',
      clientAction: 'open_marketplace',
      mcpServerId: parsed.serverId
    }
  }

  return {
    action: 'send',
    message: formatMcpToolInvocation(
      parsed.serverId,
      parsed.toolName,
      tool.description ?? '',
      trailingText
    )
  }
}
