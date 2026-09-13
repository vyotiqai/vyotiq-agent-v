/** Per-server MCP tool allow / deny filtering (bare tool names, not mcp__ prefixed). */

export type McpToolPolicy = {
  allowedTools?: string[] | null
  deniedTools?: string[] | null
}

/**
 * Whether a bare MCP tool name is permitted for this server.
 * - `deniedTools` always wins (exclude).
 * - If `allowedTools` is non-empty, only those names are allowed.
 * - Empty / missing allow list → all tools (minus denied).
 */
export function isMcpToolPermitted(toolName: string, policy: McpToolPolicy): boolean {
  const name = toolName.trim()
  if (!name) return false
  const denied = policy.deniedTools
  if (denied && denied.some((t) => t === name)) return false
  const allowed = policy.allowedTools
  if (allowed && allowed.length > 0) {
    return allowed.some((t) => t === name)
  }
  return true
}

/** Parse newline / comma-separated tool names into a clean list (or undefined if empty). */
export function parseMcpToolNameList(text: string): string[] | undefined {
  const names = text
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  return names.length > 0 ? names : undefined
}

export function formatMcpToolNameList(names: string[] | undefined | null): string {
  if (!names || names.length === 0) return ''
  return names.join('\n')
}
