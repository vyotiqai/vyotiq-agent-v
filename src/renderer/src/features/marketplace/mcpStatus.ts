import type { McpServer, McpServerStatus } from '@shared/ipc'

export function mcpStatusLabel(
  status: McpServerStatus | undefined,
  opts?: { workspaceEnabled?: boolean }
): string {
  if (opts?.workspaceEnabled === false) {
    if (status?.connected) {
      const n = status.toolCount
      return `Force off here · connected globally · ${n} tool${n === 1 ? '' : 's'}`
    }
    return 'Force off in this workspace'
  }
  if (!status) return 'Not connected'
  if (!status.enabled) return 'Disabled'
  if (status.connected) {
    const n = status.toolCount
    return `Connected · ${n} tool${n === 1 ? '' : 's'}`
  }
  // An OAuth server that has never been signed into reports "Sign in
  // required" as its connect error. That is the state working as designed,
  // so it reads as a next step rather than a failure.
  if (status.errorKind === 'sign-in') return 'Sign in to connect'
  // Still dialling. Reporting the previous attempt's failure here would make
  // every launch look like an outage for its first few seconds.
  if (status.connecting) return 'Connecting…'
  if (status.error) return 'Connection failed'
  return 'Not connected'
}

export function mcpStatusClass(
  status: McpServerStatus | undefined,
  opts?: { workspaceEnabled?: boolean }
): string {
  if (opts?.workspaceEnabled === false) return 'text-secondary'
  if (!status || !status.enabled) return 'text-secondary'
  if (status.connected) return 'text-success'
  if (status.errorKind === 'sign-in' || status.connecting) return 'text-secondary'
  if (status.error) return 'text-danger'
  return 'text-secondary'
}

/**
 * Index MCP status by session id and by settings `id` / `packageId` aliases
 * so Browse (catalog id) and Manage (settings server id) resolve the same row.
 */
export function indexMcpStatusById(
  rows: McpServerStatus[],
  servers: Array<Pick<McpServer, 'id' | 'packageId'>>
): Map<string, McpServerStatus> {
  const map = new Map<string, McpServerStatus>()
  for (const row of rows) map.set(row.id, row)
  for (const server of servers) {
    const row =
      map.get(server.id) ?? (server.packageId ? map.get(server.packageId) : undefined)
    if (!row) continue
    if (!map.has(server.id)) map.set(server.id, row)
    if (server.packageId && !map.has(server.packageId)) map.set(server.packageId, row)
  }
  return map
}
