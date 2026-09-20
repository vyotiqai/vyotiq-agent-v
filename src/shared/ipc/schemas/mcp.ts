import { z } from 'zod'

export const McpServerStatusSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean(),
  connected: z.boolean(),
  toolCount: z.number().int().min(0),
  /**
   * A connect attempt is in flight. Distinguishes "still dialling" from
   * "tried and failed", which the UI otherwise cannot tell apart: during the
   * first seconds of a launch every enabled server is not-connected with no
   * error yet, and reporting that as a fault is both wrong and alarming.
   */
  connecting: z.boolean().optional(),
  /** True when a Bearer token is stored in OS secure storage for this server. */
  hasAuthToken: z.boolean().optional(),
  /** True when a static OAuth client secret is stored (per-server or shared Google). */
  hasOAuthClientSecret: z.boolean().optional(),
  /** Fixed loopback URI when static OAuth client credentials are present. */
  oauthRedirectUrl: z.string().optional(),
  error: z.string().optional(),
  /**
   * What kind of failure `error` is, decided in main where the original error
   * object (and its `cause` chain) still exists. The card picks its control
   * from this: `sign-in` offers Sign in, `network` offers Retry, `binary`
   * offers Install / Locate. Without it the renderer would be re-deriving the
   * cause by pattern-matching a sentence written for a human.
   */
  errorKind: z.enum(['sign-in', 'network', 'binary', 'workspace', 'config']).optional(),
  /**
   * Launch binary that could not be found on PATH (e.g. `uvx`). Present instead
   * of a raw ENOENT so the UI can offer an install link and a file picker.
   */
  missingBinary: z.string().optional(),
  /** Vendor install page for `missingBinary`, when the manifest declared it. */
  missingBinaryInstallUrl: z.string().optional()
})
export type McpServerStatus = z.infer<typeof McpServerStatusSchema>

export const McpStatusResultSchema = z.object({
  servers: z.array(McpServerStatusSchema),
  hasGoogleMcpClientSecret: z.boolean().optional(),
  /**
   * A usable Google OAuth client exists — either one the user configured or the
   * one shipped with this build. When true the connect wizard skips asking the
   * user to create a Google Cloud project. The credential itself stays in main.
   */
  hasGoogleMcpClient: z.boolean().optional()
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

/** Ask the user to locate a launch binary (e.g. uvx) that is not on PATH. */
export const McpPickBinaryRequestSchema = z.object({
  /** Binary being located; used for the dialog title only. */
  binary: z.string().min(1).max(128)
})
export type McpPickBinaryRequest = z.infer<typeof McpPickBinaryRequestSchema>

/** Absolute path to the chosen executable, or null when the dialog was cancelled. */
export const McpPickBinaryResultSchema = z.object({
  path: z.string().min(1).nullable()
})
export type McpPickBinaryResult = z.infer<typeof McpPickBinaryResultSchema>
