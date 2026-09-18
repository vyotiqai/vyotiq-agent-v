import type { McpServer } from '../../../shared/ipc'
import {
  MCP_OAUTH_FIXED_LOOPBACK_PORT,
  isGoogleMcpId
} from '../../../shared/mcpApps'
import { getSettings } from '../../settings/settings'
import { getGoogleMcpClientSecret, getMcpOAuthClientSecret } from '../../settings/secrets'
import { bundledGoogleMcpClient } from './googleMcpClient'

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
    // Last resort: the client shipped with the app. A user-supplied client
    // still wins, so self-hosters keep full control. Both halves come from the
    // bundle together — mixing a user id with the bundled secret cannot work.
    if (!clientId && !clientSecret) {
      const bundled = bundledGoogleMcpClient()
      if (bundled) return bundled
    }
  }
  if (!clientId) return undefined
  return clientSecret ? { client_id: clientId, client_secret: clientSecret } : { client_id: clientId }
}

export function mcpOAuthCallbackListenOpts(
  staticClient: McpOAuthStaticClient | undefined
): { fixedPort: number } | undefined {
  return staticClient ? { fixedPort: MCP_OAUTH_FIXED_LOOPBACK_PORT } : undefined
}
