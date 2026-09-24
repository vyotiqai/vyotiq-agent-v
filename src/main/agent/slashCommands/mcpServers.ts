import type { MarketplaceOverrides, SlashCommandDescriptor, SlashMcpServer } from '../../../shared/ipc'
import { catalogEntriesById } from '../../marketplace/catalog'
import { resolveEffectiveMcpServers } from '../../marketplace/resolve'

/**
 * The servers the listed MCP commands belong to, named the way Extensions
 * names them: a server that is its own catalog package by the package's name,
 * any other (inside a plugin, or added by hand) by its own. The mark is the
 * package's art — a plugin's for a server inside it; one added by hand has none.
 */
export function listSlashMcpServers(
  commands: readonly SlashCommandDescriptor[],
  marketplaceOverrides?: MarketplaceOverrides | null
): SlashMcpServer[] {
  const ids = new Set<string>()
  for (const cmd of commands) if (cmd.kind === 'mcp' && cmd.mcpServerId) ids.add(cmd.mcpServerId)
  if (ids.size === 0) return []
  const servers = resolveEffectiveMcpServers(marketplaceOverrides).filter((s) => ids.has(s.id))
  const entries = catalogEntriesById(
    servers.flatMap((s) => (s.source === 'marketplace' && s.packageId ? [s.packageId] : []))
  )
  return servers.map((server) => {
    const entry =
      server.source === 'marketplace' && server.packageId ? entries.get(server.packageId) : undefined
    return {
      id: server.id,
      name: (entry?.kind === 'mcp' ? entry.name : server.name) || server.id,
      ...(entry?.iconUrl ? { iconUrl: entry.iconUrl, iconMono: entry.iconMono ?? false } : {})
    }
  })
}
