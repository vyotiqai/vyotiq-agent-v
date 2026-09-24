import type { McpServer, McpServerStatus } from '@shared/ipc'

/**
 * Index MCP status by session id and by settings `id` / `packageId` aliases,
 * so a catalog id and the settings server mirrored from it resolve the same row.
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
