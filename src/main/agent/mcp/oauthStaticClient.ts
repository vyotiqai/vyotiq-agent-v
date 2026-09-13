import type { McpServer } from '../../../shared/ipc'
import {
  MCP_OAUTH_FIXED_LOOPBACK_PORT,
  isGoogleMcpId
} from '../../../shared/mcpApps'
import { getSettings } from '../../settings/settings'
import { getGoogleMcpClientSecret, getMcpOAuthClientSecret } from '../../settings/secrets'

export type McpOAuthStaticClient = {
  client_id: string
  client_secret?: string
}

export function resolveMcpOAuthStaticClient(
  server: Pick<McpServer, 'id' | 'oauthClientId'>
): McpOAuthStaticClient | undefined {
  const perId = server.oauthClientId?.trim() ?? ''
  const perSecret = getMcpOAuthClientSecret(server.id)?.trim() ?? ''
  let clientId = perId
  let clientSecret = perSecret
  if (isGoogleMcpId(server.id)) {
    if (!clientId) clientId = getSettings().googleMcpClientId?.trim() ?? ''
    if (!clientSecret) clientSecret = getGoogleMcpClientSecret()?.trim() ?? ''
  }
  if (!clientId) return undefined
  return clientSecret ? { client_id: clientId, client_secret: clientSecret } : { client_id: clientId }
}

export function mcpOAuthCallbackListenOpts(
  staticClient: McpOAuthStaticClient | undefined
): { fixedPort: number } | undefined {
  return staticClient ? { fixedPort: MCP_OAUTH_FIXED_LOOPBACK_PORT } : undefined
}
