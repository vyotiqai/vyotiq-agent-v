/**
 * Official Python MCP reference servers (fetch, time) still import `McpError`,
 * which was renamed in the MCP Python SDK v2. Bare `uvx mcp-server-*` pulls
 * mcp>=2 and crashes on startup. Pin the SDK to v1 until those packages update.
 */
import { scrubPath } from '../../../shared/utils/scrub'

const UVX_PACKAGES_NEEDING_MCP_V1 = new Set(['mcp-server-fetch', 'mcp-server-time'])

/** Marketplace / settings id for the official git MCP, or args that launch it. */
export function isGitMcpServer(server: {
  id?: string
  args?: string[] | null
}): boolean {
  if ((server.id ?? '').trim().toLowerCase() === 'git') return true
  return (server.args ?? []).some((a) => a === 'mcp-server-git')
}

/** Explicit connect error when Git MCP is configured but the workspace has no `.git`. */
export function gitMcpNotARepoMessage(workspacePath: string): string {
  return (
    `Workspace is not a Git repository (${scrubPath(workspacePath)}). ` +
    'Git MCP was not started — run git init or open a cloned repo.'
  )
}

/**
 * True for permanent Git MCP failures that must not be force-retried on resume
 * (our preflight message or mcp-server-git's native "not a valid Git repository").
 */
export function isGitMcpNotARepoError(message: string | null | undefined): boolean {
  if (!message) return false
  return (
    /Workspace is not a Git repository/i.test(message) ||
    /is not a valid Git repository/i.test(message) ||
    /not a git repository/i.test(message)
  )
}

/** True when args already include a uv `--with` constraint that mentions mcp. */
export function hasUvxMcpWithConstraint(args: string[]): boolean {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--with' && /mcp/i.test(args[i + 1] ?? '')) return true
  }
  return false
}

/**
 * Return stdio args suitable for launching via `uvx`, injecting `--with mcp<2`
 * for known-broken official packages when the caller did not already pin mcp.
 */
export function withCompatibleUvxArgs(
  command: string | undefined,
  args: string[] | undefined
): string[] {
  const next = [...(args ?? [])]
  if ((command ?? '').trim().toLowerCase() !== 'uvx') return next
  if (hasUvxMcpWithConstraint(next)) return next
  const needsPin = next.some((a) => UVX_PACKAGES_NEEDING_MCP_V1.has(a))
  if (!needsPin) return next
  return ['--with', 'mcp<2', ...next]
}

/**
 * Rewrite `--repository .` (or empty) to an absolute workspace path so git MCP
 * does not depend on Electron's process cwd.
 */
export function withWorkspaceRepositoryArgs(
  args: string[] | undefined,
  workspacePath: string | null | undefined
): string[] {
  const next = [...(args ?? [])]
  const root = workspacePath?.trim()
  if (!root) return next
  for (let i = 0; i < next.length - 1; i++) {
    if (next[i] !== '--repository') continue
    const value = (next[i + 1] ?? '').trim()
    if (value === '.' || value === '') {
      next[i + 1] = root
    }
  }
  return next
}
