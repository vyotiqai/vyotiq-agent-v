import { getWriteCheckpoint, type InvokeWriteCheckpoint } from '../checkpoints'

/** Official @modelcontextprotocol/server-filesystem write-capable tools. */
const FILESYSTEM_WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'create_directory',
  'move_file'
])

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeWorkspaceRelPath(path: string): string {
  return path.trim().replace(/\\/g, '/')
}

function isFilesystemMcpServer(serverId: string): boolean {
  return serverId === 'filesystem' || serverId === 'fs' || /filesystem/i.test(serverId)
}

/**
 * Snapshot known MCP filesystem write paths before invokeMcpTool.
 * Conservative: only bundled filesystem tool names + explicit path args.
 */
export async function recordMcpFilesystemPriors(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  context: { runDir?: string; skipWriteCheckpoint?: boolean }
): Promise<void> {
  if (context.skipWriteCheckpoint || !context.runDir) return
  if (!isFilesystemMcpServer(serverId) || !FILESYSTEM_WRITE_TOOLS.has(toolName)) return

  const cp = getWriteCheckpoint(context.runDir)
  if (!cp) return

  if (toolName === 'move_file') {
    const source = asString(args.source)
    const destination = asString(args.destination)
    if (source) await cp.recordPrior(source, 'delete')
    if (destination) await cp.recordPrior(destination, 'write')
    return
  }

  if (toolName === 'edit_file' && args.dryRun === true) return

  const path = asString(args.path)
  if (!path) return
  await cp.recordPrior(path, 'write')
}

/**
 * Record MCP filesystem write paths for scoped git_commit staging.
 * Conservative: same tool names and path args as {@link recordMcpFilesystemPriors}.
 */
export function applyMcpFilesystemMutations(
  mutations: Set<string>,
  serverId: string,
  toolName: string,
  args: Record<string, unknown>
): void {
  if (!isFilesystemMcpServer(serverId) || !FILESYSTEM_WRITE_TOOLS.has(toolName)) return

  if (toolName === 'move_file') {
    const source = asString(args.source)
    const destination = asString(args.destination)
    if (source) mutations.add(normalizeWorkspaceRelPath(source))
    if (destination) mutations.add(normalizeWorkspaceRelPath(destination))
    return
  }

  if (toolName === 'edit_file' && args.dryRun === true) return

  const path = asString(args.path)
  if (path) mutations.add(normalizeWorkspaceRelPath(path))
}

/** Test helper: expose the known write-tool set. */
export function mcpFilesystemWriteToolsForTests(): readonly string[] {
  return [...FILESYSTEM_WRITE_TOOLS]
}

export type { InvokeWriteCheckpoint }
