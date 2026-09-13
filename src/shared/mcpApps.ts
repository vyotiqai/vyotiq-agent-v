/** Bundled hosted-app MCP package ids (HTTP + OAuth/PAT). */

import { workspacePathsEqual } from './workspacePath'

export const GITHUB_MCP_ID = 'github'
export const GMAIL_MCP_ID = 'gmail'
export const GOOGLE_DRIVE_MCP_ID = 'google-drive'
export const GOOGLE_CALENDAR_MCP_ID = 'google-calendar'

export const GOOGLE_MCP_IDS = [
  GMAIL_MCP_ID,
  GOOGLE_DRIVE_MCP_ID,
  GOOGLE_CALENDAR_MCP_ID
] as const

export type GoogleMcpId = (typeof GOOGLE_MCP_IDS)[number]

export const HOSTED_APP_MCP_IDS = [GITHUB_MCP_ID, ...GOOGLE_MCP_IDS] as const

export const MCP_OAUTH_FIXED_LOOPBACK_PORT = 19847
export const MCP_OAUTH_CALLBACK_PATH = '/oauth/callback'

export const MCP_AUTH_SCOPE_ALL = 'all-workspaces'
export const MCP_AUTH_SCOPE_THIS = 'this-workspace'
export type McpAuthScope = typeof MCP_AUTH_SCOPE_ALL | typeof MCP_AUTH_SCOPE_THIS

export const GOOGLE_ACCESS_READ = 'read'
export const GOOGLE_ACCESS_READ_WRITE = 'read-write'
export type GoogleMcpAccess = typeof GOOGLE_ACCESS_READ | typeof GOOGLE_ACCESS_READ_WRITE

export function mcpOAuthCallbackUrl(port: number): string {
  return `http://127.0.0.1:${port}${MCP_OAUTH_CALLBACK_PATH}`
}

export function mcpOAuthFixedRedirectUrl(): string {
  return mcpOAuthCallbackUrl(MCP_OAUTH_FIXED_LOOPBACK_PORT)
}

export function mcpOAuthFixedPortBusyMessage(port: number): string {
  return (
    `MCP OAuth callback port ${port} is already in use. ` +
    `Close the other process using ${mcpOAuthCallbackUrl(port)} and try Sign in again.`
  )
}

export function isThisWorkspaceMcpAuth(server: {
  authScope?: string
  authWorkspacePath?: string
}): boolean {
  return server.authScope === MCP_AUTH_SCOPE_THIS && Boolean(server.authWorkspacePath?.trim())
}

/** This-workspace tokens must not be sent (or tools exposed) from another workspace. */
export function mcpAuthAllowedForWorkspace(
  server: { authScope?: string; authWorkspacePath?: string },
  workspacePath?: string | null
): boolean {
  if (server.authScope !== MCP_AUTH_SCOPE_THIS) return true
  const bound = server.authWorkspacePath?.trim()
  if (!bound) return false
  const wp = workspacePath?.trim()
  if (!wp) return false
  return workspacePathsEqual(bound, wp)
}

export function isGoogleMcpId(id: string): id is GoogleMcpId {
  return (GOOGLE_MCP_IDS as readonly string[]).includes(id)
}

export function isGithubMcpId(id: string): boolean {
  return id === GITHUB_MCP_ID
}

export function isHostedAppMcpId(id: string): boolean {
  return (HOSTED_APP_MCP_IDS as readonly string[]).includes(id)
}

export function isMcpServerToolName(name: string): boolean {
  return name.startsWith('mcp__')
}
