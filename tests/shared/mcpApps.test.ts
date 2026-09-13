import { describe, expect, it } from 'vitest'
import {
  GITHUB_MCP_ID,
  GMAIL_MCP_ID,
  MCP_AUTH_SCOPE_THIS,
  MCP_OAUTH_FIXED_LOOPBACK_PORT,
  isGithubMcpId,
  isGoogleMcpId,
  isHostedAppMcpId,
  isMcpServerToolName,
  mcpAuthAllowedForWorkspace,
  mcpOAuthFixedPortBusyMessage,
  mcpOAuthFixedRedirectUrl
} from '@shared/mcpApps'

describe('mcpApps helpers', () => {
  it('identifies hosted GitHub and Google MCP ids', () => {
    expect(isGithubMcpId(GITHUB_MCP_ID)).toBe(true)
    expect(isGoogleMcpId(GMAIL_MCP_ID)).toBe(true)
    expect(isHostedAppMcpId('google-drive')).toBe(true)
    expect(isHostedAppMcpId('filesystem')).toBe(false)
    expect(isMcpServerToolName('mcp__gmail__list')).toBe(true)
    expect(isMcpServerToolName('mcp_list_tools')).toBe(false)
  })

  it('builds the fixed Google redirect URI', () => {
    expect(mcpOAuthFixedRedirectUrl()).toBe(
      `http://127.0.0.1:${MCP_OAUTH_FIXED_LOOPBACK_PORT}/oauth/callback`
    )
    expect(mcpOAuthFixedPortBusyMessage(19847)).toMatch(/19847/)
    expect(mcpOAuthFixedPortBusyMessage(19847)).toMatch(/already in use/)
  })

  it('does not allow this-workspace tokens from another workspace', () => {
    const server = {
      authScope: MCP_AUTH_SCOPE_THIS,
      authWorkspacePath: 'C:\\Users\\ajay\\proj-a'
    }
    expect(mcpAuthAllowedForWorkspace(server, 'C:\\Users\\ajay\\proj-a')).toBe(true)
    expect(mcpAuthAllowedForWorkspace(server, 'C:\\Users\\ajay\\proj-b')).toBe(false)
    expect(mcpAuthAllowedForWorkspace(server, null)).toBe(false)
    expect(mcpAuthAllowedForWorkspace({ authScope: 'all-workspaces' }, 'C:\\elsewhere')).toBe(
      true
    )
    expect(mcpAuthAllowedForWorkspace({}, 'C:\\elsewhere')).toBe(true)
  })
})
