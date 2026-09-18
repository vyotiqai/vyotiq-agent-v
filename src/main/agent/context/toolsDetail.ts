import type { ToolDefinition } from '../providers/types'
import { parseMcpToolName } from '../mcp'
import { estimateToolDefTokens } from './toolsBudget'
import type { ContextToolsDetail } from '../../../shared/utils/contextUsage'

/**
 * Split the full per-step tool universe (builtins + connected MCP candidates,
 * before mode/index filtering) into the wire-vs-deferred breakdown shown in
 * the context meter. Active = names present in the step catalog; everything
 * else in `allDefs` is deferred (e.g. MCP tools outside Agent mode, write
 * builtins in Ask mode, index-search tools with indexing off).
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
  for (const def of allDefs) {
    const parsed = parseMcpToolName(def.name)
    const tokens = estimateToolDefTokens(def)
    if (activeNames.has(def.name)) {
      if (parsed) {
        mcp.tokens += tokens
        mcp.count += 1
        const entry = byServer.get(parsed.serverId) ?? { tokens: 0, toolCount: 0 }
        entry.tokens += tokens
        entry.toolCount += 1
        byServer.set(parsed.serverId, entry)
      } else {
        builtin.tokens += tokens
        builtin.count += 1
      }
    } else if (parsed) {
      deferredMcp.tokens += tokens
      deferredMcp.count += 1
    } else {
      deferredBuiltin.tokens += tokens
      deferredBuiltin.count += 1
    }
  }
  const mcpByServer = [...byServer.entries()]
    .map(([serverId, group]) => ({ serverId, tokens: group.tokens, toolCount: group.toolCount }))
    .sort((a, b) => b.tokens - a.tokens || a.serverId.localeCompare(b.serverId))
  return {
    builtin,
    mcp,
    mcpByServer,
    deferredBuiltin,
    deferredMcp,
    total: builtin.tokens + mcp.tokens
  }
}
