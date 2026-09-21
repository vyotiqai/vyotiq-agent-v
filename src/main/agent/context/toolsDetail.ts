import type { ToolDefinition } from '../providers/types'
import { parseMcpToolName } from '../mcp'
import { estimateToolDefTokens } from './toolsBudget'
import type { ContextToolsDetail } from '../../../shared/utils/contextUsage'

/**
 * Split the full per-step tool universe (builtins + connected MCP candidates,
 * before mode/index filtering) into the wire-vs-deferred breakdown shown in
 * the context meter. Active = names present in the step catalog; everything
 * else in `allDefs` is deferred (MCP the run has not loaded, MCP outside Agent
 * mode, write builtins in Ask mode, index-search tools with indexing off).
 * The deferred MCP split per server is what a run would pay to load each one.
 */
export function splitToolCatalogDetail(
  allDefs: ReadonlyArray<ToolDefinition>,
  activeNames: ReadonlySet<string>
): ContextToolsDetail {
  const builtin = { tokens: 0, count: 0 }
  const mcp = { tokens: 0, count: 0 }
  const deferredBuiltin = { tokens: 0, count: 0 }
  const deferredMcp = { tokens: 0, count: 0 }
  const byServer = new Map<string, { tokens: number; toolCount: number }>()
  const deferredByServer = new Map<string, { tokens: number; toolCount: number }>()
  const addTo = (
    map: Map<string, { tokens: number; toolCount: number }>,
    serverId: string,
    tokens: number
  ): void => {
    const entry = map.get(serverId) ?? { tokens: 0, toolCount: 0 }
    entry.tokens += tokens
    entry.toolCount += 1
    map.set(serverId, entry)
  }
  for (const def of allDefs) {
    const parsed = parseMcpToolName(def.name)
    const tokens = estimateToolDefTokens(def)
    if (activeNames.has(def.name)) {
      if (parsed) {
        mcp.tokens += tokens
        mcp.count += 1
        addTo(byServer, parsed.serverId, tokens)
      } else {
        builtin.tokens += tokens
        builtin.count += 1
      }
    } else if (parsed) {
      deferredMcp.tokens += tokens
      deferredMcp.count += 1
      addTo(deferredByServer, parsed.serverId, tokens)
    } else {
      deferredBuiltin.tokens += tokens
      deferredBuiltin.count += 1
    }
  }
  const sortByCost = (
    map: Map<string, { tokens: number; toolCount: number }>
  ): { serverId: string; tokens: number; toolCount: number }[] =>
    [...map.entries()]
      .map(([serverId, group]) => ({ serverId, tokens: group.tokens, toolCount: group.toolCount }))
      .sort((a, b) => b.tokens - a.tokens || a.serverId.localeCompare(b.serverId))
  return {
    builtin,
    mcp,
    mcpByServer: sortByCost(byServer),
    deferredBuiltin,
    deferredMcp,
    deferredMcpByServer: sortByCost(deferredByServer),
    total: builtin.tokens + mcp.tokens
  }
}
