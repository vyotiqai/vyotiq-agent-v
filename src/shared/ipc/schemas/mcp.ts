import { z } from 'zod'

export const McpServerStatusSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean(),
  connected: z.boolean(),
  toolCount: z.number().int().min(0),
  /** True when a Bearer token is stored in OS secure storage for this server. */
  hasAuthToken: z.boolean().optional(),
  /** True when a static OAuth client secret is stored (per-server or shared Google). */
  hasOAuthClientSecret: z.boolean().optional(),
  /** Fixed loopback URI when static OAuth client credentials are present. */
  oauthRedirectUrl: z.string().optional(),
  error: z.string().optional()
})
export type McpServerStatus = z.infer<typeof McpServerStatusSchema>

export const McpStatusResultSchema = z.object({
  servers: z.array(McpServerStatusSchema),
  hasGoogleMcpClientSecret: z.boolean().optional()
})
export type McpStatusResult = z.infer<typeof McpStatusResultSchema>

/** Omitted/null workspacePath = active workspace scope; a string scopes to that workspace. */
export const McpStatusRequestSchema = z.object({
  workspacePath: z.string().nullish()
})
export type McpStatusRequest = z.infer<typeof McpStatusRequestSchema>

export const McpRefreshRequestSchema = McpStatusRequestSchema
export type McpRefreshRequest = McpStatusRequest

export const McpSetAuthTokenRequestSchema = z.object({
  serverId: z.string().min(1),
  token: z.string().min(1)
})
export type McpSetAuthTokenRequest = z.infer<typeof McpSetAuthTokenRequestSchema>

export const McpClearAuthTokenRequestSchema = z.object({
  serverId: z.string().min(1)
})
export type McpClearAuthTokenRequest = z.infer<typeof McpClearAuthTokenRequestSchema>

export const McpStartOAuthRequestSchema = z.object({
  serverId: z.string().min(1),
  authScope: z.enum(['all-workspaces', 'this-workspace']).optional(),
  workspacePath: z.string().min(1).optional(),
  googleAccess: z.enum(['read', 'read-write']).optional()
})
export type McpStartOAuthRequest = z.infer<typeof McpStartOAuthRequestSchema>

export const McpSetOAuthClientSecretRequestSchema = z.object({
  serverId: z.string().min(1),
  secret: z.string().min(1)
})
export type McpSetOAuthClientSecretRequest = z.infer<typeof McpSetOAuthClientSecretRequestSchema>

export const McpClearOAuthClientSecretRequestSchema = z.object({
  serverId: z.string().min(1)
})
export type McpClearOAuthClientSecretRequest = z.infer<
  typeof McpClearOAuthClientSecretRequestSchema
>

export const McpSetGoogleClientSecretRequestSchema = z.object({
  secret: z.string().min(1)
})
export type McpSetGoogleClientSecretRequest = z.infer<typeof McpSetGoogleClientSecretRequestSchema>

export const McpClearGoogleClientSecretRequestSchema = z.object({}).default({})
export type McpClearGoogleClientSecretRequest = z.infer<
  typeof McpClearGoogleClientSecretRequestSchema
>
