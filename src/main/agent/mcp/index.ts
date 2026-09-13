import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { pathToFileURL } from 'url'
import { basename } from 'path'
import Ajv2020 from 'ajv/dist/2020'
import type { ValidateFunction } from 'ajv'
import type { McpServer } from '../../../shared/ipc'
import type { McpServerStatus } from '../../../shared/ipc'
import type { ToolDefinition } from '../providers/types'
import { logger } from '../../../shared/logger'
import { neutralizeUntrustedBody, wrapUntrustedContent } from '../untrustedContent'
import { mcpToolSummary } from '../../../shared/toolSummary'
import type { ToolResult } from '../tools'
import { sanitizedTerminalEnv } from '../tools/terminal'
import {
  getMcpAuthToken,
  hasMcpAuthToken,
  hasMcpOAuthClientSecret,
  hasMcpOAuthState,
  hasStoredMcpOAuthBlob,
  hasGoogleMcpClientSecret,
  getMcpOAuthState,
  setMcpAuthToken,
  clearMcpOAuthState
} from '../../settings/secrets'
import { getSettings, setSettings, enqueueSettingsMutation, REDACTED_VALUE } from '../../settings/settings'
import {
  getBearerToken,
  headersWithoutAuthorization,
  withBearerToken
} from '../../../shared/utils/mcpAuth'
import { invalidateSlashCommandsCache } from '../slashCommands/listCache'
import {
  beginMcpOAuthCallback,
  cancelMcpOAuthCallback,
  createMcpOAuthProvider
} from './oauth'
import {
  mcpOAuthCallbackListenOpts,
  resolveMcpOAuthStaticClient
} from './oauthStaticClient'
import { linkNativeGithubFromMcpToken } from '../../git/githubAuth'
import {
  isGithubMcpId,
  isGoogleMcpId,
  isHostedAppMcpId,
  isThisWorkspaceMcpAuth,
  mcpAuthAllowedForWorkspace,
  mcpOAuthFixedRedirectUrl,
  MCP_AUTH_SCOPE_THIS,
  type GoogleMcpAccess,
  type McpAuthScope
} from '../../../shared/mcpApps'
import { resolveEffectiveMcpServers } from '../../marketplace/resolve'
import { sanitizeMcpManifestEnv } from '../../marketplace/sanitizeMcpEnv'
import {
  gitMcpNotARepoMessage,
  isGitMcpNotARepoError,
  isGitMcpServer,
  withCompatibleUvxArgs,
  withWorkspaceRepositoryArgs
} from './uvxCompat'
import { isGitRepo } from '../../git/git'
import { readWorkspacesState } from '../../workspace/workspaces'
import { workspacePathsEqual } from '../../../shared/workspacePath'
import { listActiveRuns } from '../runRegistry'
import { AppError, formatError, isAbortError, mcpConnectErrorCode } from '../../../shared/errors'
import { assertPublicUrl } from '../tools/webFetch'
import {
  assertCircuitClosed,
  circuitKeyMcpConnect,
  circuitKeyMcpInvoke,
  isCircuitOpenError,
  MCP_CONNECT_CIRCUIT_POLICY,
  recordCircuitFailure,
  recordCircuitSuccess,
  releaseCircuitProbe,
  resetCircuit,
  resetCircuitsByPrefix
} from '../circuitBreaker'

export {
  gitMcpNotARepoMessage,
  isGitMcpNotARepoError,
  isGitMcpServer,
  withCompatibleUvxArgs,
  withWorkspaceRepositoryArgs,
  hasUvxMcpWithConstraint
} from './uvxCompat'

/** Workspace root fallback when spawning stdio MCP without an explicit path. */
let mcpStdioWorkspacePath: string | null = null

const STDIO_SESSION_SEP = '::stdio::'

/** Composite session key for workspace-scoped stdio MCP transports. */
export function mcpStdioSessionKey(serverId: string, workspacePath: string): string {
  return `${serverId}${STDIO_SESSION_SEP}${workspacePath}`
}

export function parseMcpStdioSessionKey(
  key: string
): { serverId: string; workspacePath: string } | null {
  const idx = key.indexOf(STDIO_SESSION_SEP)
  if (idx < 0) return null
  return { serverId: key.slice(0, idx), workspacePath: key.slice(idx + STDIO_SESSION_SEP.length) }
}

function isStdioTransport(transport: McpServer['transport'] | undefined): boolean {
  return (transport ?? 'stdio') === 'stdio'
}

function resolveStdioWorkspacePath(workspacePath?: string | null): string | null {
  const explicit = workspacePath?.trim()
  if (explicit) return explicit
  return mcpStdioWorkspacePath?.trim() || null
}

function sessionMapKey(
  server: Pick<McpServer, 'id' | 'transport' | 'authScope' | 'authWorkspacePath'>,
  workspacePath?: string | null
): string {
  if (isStdioTransport(server.transport)) {
    const wp = resolveStdioWorkspacePath(workspacePath)
    return wp ? mcpStdioSessionKey(server.id, wp) : server.id
  }
  if (isThisWorkspaceMcpAuth(server)) {
    const bound = server.authWorkspacePath?.trim()
    if (bound) return mcpStdioSessionKey(server.id, bound)
  }
  return server.id
}

export const MCP_SIGN_IN_REQUIRED = 'Sign in required'

export function isMcpSignInRequiredError(message: string | null | undefined): boolean {
  if (!message) return false
  return /sign in required/i.test(message)
}

function quietMcpConnectSkip(message: string | null | undefined): boolean {
  return isGitMcpNotARepoError(message) || isMcpSignInRequiredError(message)
}

function remoteSyncWorkspacePath(
  server: McpServer,
  openWorkspaces: string[]
): string | null {
  if (!isThisWorkspaceMcpAuth(server)) return null
  const bound = server.authWorkspacePath?.trim()
  if (!bound) return null
  return openWorkspaces.some((wp) => workspacePathsEqual(wp, bound)) ? bound : null
}

/** Workspace paths that should keep stdio MCP sessions (active runs + open workspaces). */
export function collectStdioWorkspacePaths(): string[] {
  const paths = new Set<string>()
  for (const run of listActiveRuns()) {
    if (run.workspacePath?.trim()) paths.add(run.workspacePath.trim())
  }
  try {
    const state = readWorkspacesState()
    for (const p of state.openPaths ?? []) {
      if (p?.trim()) paths.add(p.trim())
    }
  } catch {
    // tests / early startup
  }
  const hint = mcpStdioWorkspacePath?.trim()
  if (hint) paths.add(hint)
  return [...paths]
}

/**
 * Hint the default workspace for stdio MCP when no explicit path is passed.
 * Does not disconnect existing workspace-scoped sessions.
 */
export function setMcpStdioWorkspace(workspacePath: string | null | undefined): void {
  const next = workspacePath?.trim() || null
  if (next === mcpStdioWorkspacePath) return
  mcpStdioWorkspacePath = next
  lastSyncedServersFp = ''
}

export function getMcpStdioWorkspace(): string | null {
  return mcpStdioWorkspacePath
}

/** Scrubbed base env + optional user-configured MCP server.env overlays. */
export function buildMcpChildEnv(
  serverEnv?: Record<string, string>,
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const env: Record<string, string> = { ...sanitizedTerminalEnv(source) }
  const safeOverlay = sanitizeMcpManifestEnv(serverEnv)
  for (const [key, value] of Object.entries(safeOverlay ?? {})) {
    // Never inject IPC redaction placeholders into the child process.
    if (typeof value !== 'string' || value === REDACTED_VALUE) continue
    env[key] = value
  }
  // Official Python MCP servers on Windows often hang/garble without UTF-8 stdio.
  // Apply after overlay so a redacted PYTHONIOENCODING cannot overwrite the default.
  if (process.platform === 'win32' && !env.PYTHONIOENCODING) {
    env.PYTHONIOENCODING = 'utf-8'
  }
  return env
}

export const MCP_TOOL_PREFIX = 'mcp__'

export function mcpToolName(serverId: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverId}__${toolName}`
}

export function parseMcpToolName(
  name: string
): { serverId: string; toolName: string } | null {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return null
  const rest = name.slice(MCP_TOOL_PREFIX.length)
  const sep = rest.indexOf('__')
  if (sep <= 0) return null
  return { serverId: rest.slice(0, sep), toolName: rest.slice(sep + 2) }
}

type McpResourceSummary = {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

type McpPromptSummary = {
  name: string
  description?: string
  arguments?: Array<{ name: string; description?: string; required?: boolean }>
}

type McpSession = {
  client: Client
  transport: Transport
  tools: ToolDefinition[]
  resources?: McpResourceSummary[]
  prompts?: McpPromptSummary[]
}

export type McpResourceEntry = McpResourceSummary & { serverId: string }
export type McpPromptEntry = McpPromptSummary & { serverId: string }

/**
 * Hard cap on MCP-sourced text fed to the model (chars). The MCP SDK does not
 * bound tool/resource/prompt payloads, so an oversized server response would
 * otherwise consume the whole context window in one step.
 */
export const MCP_CONTENT_CAP = 64 * 1024

/** Truncate to MCP_CONTENT_CAP with an explicit marker when cut. */
function capMcpText(text: string): string {
  if (text.length <= MCP_CONTENT_CAP) return text
  return `${text.slice(0, MCP_CONTENT_CAP)}\n[MCP output truncated: showing ${MCP_CONTENT_CAP} of ${text.length} chars]`
}

const ajv2020 = new Ajv2020({ allErrors: true, strict: false })
/** Compiled per server/tool inputSchema; cleared when a server re-lists tools. */
const mcpArgValidatorCache = new Map<string, ValidateFunction | null>()

/**
 * Defense-in-depth: validate tool arguments against the server-declared
 * inputSchema before the call leaves the process. The MCP server remains the
 * authority and re-validates itself; this stops schema-blind argument
 * injection early and turns schema mismatches into fast tool errors instead
 * of a paid round-trip. Fails open when a schema cannot be compiled.
 */
function validateMcpToolArgs(
  toolName: string,
  args: Record<string, unknown>,
  inputSchema: unknown
): string | null {
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) return null
  let validate = mcpArgValidatorCache.get(toolName)
  if (validate === undefined) {
    try {
      validate = ajv2020.compile(inputSchema)
    } catch (err) {
      logger.warn('MCP inputSchema failed to compile; skipping arg validation', {
        scope: 'mcp',
        correlationId: toolName,
        err
      })
      validate = null
    }
    mcpArgValidatorCache.set(toolName, validate)
  }
  if (!validate) return null
  if (validate(args)) return null
  const detail = ajv2020.errorsText(validate.errors?.slice(0, 5))
  return `Invalid arguments for MCP tool "${toolName}": ${detail}`
}

function wrapMcpPayload(body: string, origin: string): string {
  return wrapUntrustedContent(body, { source: 'mcp', origin })
}

async function probeResourcesAndPrompts(client: Client): Promise<{
  resources: McpResourceSummary[]
  prompts: McpPromptSummary[]
}> {
  const resources: McpResourceSummary[] = []
  const prompts: McpPromptSummary[] = []
  const caps = client.getServerCapabilities()
  if (caps?.resources) {
    try {
      const listed = await client.listResources()
      for (const resource of listed.resources ?? []) {
        resources.push({
          uri: resource.uri,
          name: resource.name,
          description: resource.description
            ? neutralizeUntrustedBody(resource.description)
            : undefined,
          mimeType: resource.mimeType
        })
      }
    } catch {
      // Server may advertise resources but fail list — ignore on connect.
    }
  }
  if (caps?.prompts) {
    try {
      const listed = await client.listPrompts()
      for (const prompt of listed.prompts ?? []) {
        prompts.push({
          name: prompt.name,
          description: prompt.description
            ? neutralizeUntrustedBody(prompt.description)
            : undefined,
          arguments: prompt.arguments
        })
      }
    } catch {
      // Server may advertise prompts but fail list — ignore on connect.
    }
  }
  return { resources, prompts }
}

function resolveTargetServerIds(
  serverId: string | undefined,
  enabledIds?: ReadonlySet<string>,
  workspacePath?: string | null
): string[] {
  const keys = [...sessions.keys()].sort()
  const ids = new Set<string>()
  for (const key of keys) {
    const parsed = parseMcpStdioSessionKey(key)
    ids.add(parsed?.serverId ?? key)
  }
  let list = [...ids].sort()
  if (enabledIds) list = list.filter((id) => enabledIds.has(id))
  if (serverId?.trim()) {
    const want = serverId.trim().toLowerCase()
    list = list.filter((id) => id.toLowerCase() === want)
  }
  return list
}

function resolveSessionForServer(
  serverId: string,
  workspacePath?: string | null
): { key: string; session: McpSession } | null {
  try {
    const cfg = resolveEffectiveMcpServers().find((s) => s.id === serverId)
    if (cfg && isThisWorkspaceMcpAuth(cfg)) {
      if (!mcpAuthAllowedForWorkspace(cfg, workspacePath)) return null
      const bound = cfg.authWorkspacePath!.trim()
      const key = mcpStdioSessionKey(serverId, bound)
      const session = sessions.get(key)
      return session ? { key, session } : null
    }
  } catch {
    // Settings/marketplace unavailable — fall through to session-map lookup.
  }
  const explicit = workspacePath?.trim() || null
  const wp = resolveStdioWorkspacePath(workspacePath)
  if (wp) {
    const stdioKey = mcpStdioSessionKey(serverId, wp)
    if (sessions.has(stdioKey)) {
      return { key: stdioKey, session: sessions.get(stdioKey)! }
    }
  }
  const remote = sessions.get(serverId)
  if (remote) return { key: serverId, session: remote }
  // Explicit cwd (e.g. instance worktree) must not borrow another workspace's stdio session.
  if (explicit) return null
  for (const [key, session] of sessions) {
    const parsed = parseMcpStdioSessionKey(key)
    if (parsed?.serverId === serverId) return { key, session }
  }
  return null
}

export function assertMcpServerAccess(
  serverId: string,
  enabledIds?: ReadonlySet<string>,
  workspacePath?: string | null
): { ok: true; session: McpSession; sessionKey: string } | { ok: false; error: string } {
  const resolved = resolveSessionForServer(serverId, workspacePath)
  if (!resolved) {
    return { ok: false, error: `MCP server not connected: ${serverId}` }
  }
  if (enabledIds && !enabledIds.has(serverId)) {
    return {
      ok: false,
      error: `MCP server "${serverId}" is not enabled for this workspace run`
    }
  }
  return { ok: true, session: resolved.session, sessionKey: resolved.key }
}

function formatResourceContents(
  contents: Array<{ type?: string; text?: string; blob?: string; mimeType?: string }>
): string {
  const joined = contents
    .map((part) => {
      if (part.type === 'text' && part.text) return part.text
      if (part.blob) {
        return `[binary blob mime=${part.mimeType ?? 'unknown'} base64 len=${part.blob.length}]`
      }
      return JSON.stringify(part)
    })
    .join('\n')
  return capMcpText(joined)
}

function formatPromptMessages(
  messages: Array<{ role?: string; content?: { type?: string; text?: string } | string }>
): string {
  const joined = messages
    .map((message) => {
      const role = message.role ?? 'unknown'
      const content = message.content
      if (typeof content === 'string') return `${role}: ${content}`
      if (content?.type === 'text' && content.text) return `${role}: ${content.text}`
      return `${role}: ${JSON.stringify(content)}`
    })
    .join('\n\n')
  return capMcpText(joined)
}

const sessions = new Map<string, McpSession>()
const connectErrors = new Map<string, string>()
const sessionConfigKeys = new Map<string, string>()
const mcpReadOnlyHints = new Map<string, boolean>()
/** Full MCP tool name → definition (kept in sync with `sessions`). */
const toolsByName = new Map<string, ToolDefinition>()

function rebuildToolsByNameIndex(): void {
  toolsByName.clear()
  // Stale validators must not outlive the schema that compiled them.
  mcpArgValidatorCache.clear()
  for (const session of sessions.values()) {
    for (const tool of session.tools) {
      toolsByName.set(tool.name, tool)
    }
  }
}

/** Last connect-config fingerprint per session key — config changes reset the connect circuit. */
const connectConfigByKey = new Map<string, string>()

/** In-flight connect promises — concurrent callers for the same id share one attempt. */
const connecting = new Map<string, Promise<void>>()

/** Serialize syncMcpServers so overlapping IPC/startup callers cannot race reconnects. */
let syncChain: Promise<void> = Promise.resolve()
/** Fingerprint of the last successfully synced payload — skip syncChain when unchanged. */
let lastSyncedServersFp: string | null = null
let lastSyncInflight: Promise<void> | null = null

/** True only when the MCP server declared readOnlyHint for this tool. */
export function getMcpReadOnlyHint(name: string): boolean | undefined {
  return mcpReadOnlyHints.get(name)
}

function sortedRecordEntries(record?: Record<string, string>): Array<[string, string]> {
  const env = record ?? {}
  return Object.keys(env)
    .sort()
    .map((key) => [key, env[key] ?? ''] as const)
}

/** Stable fingerprint of connection-relevant MCP server fields. */
export function mcpServerConfigKey(
  server: Pick<
    McpServer,
    | 'transport'
    | 'command'
    | 'args'
    | 'env'
    | 'url'
    | 'headers'
    | 'oauthClientId'
    | 'authScope'
    | 'authWorkspacePath'
    | 'googleAccess'
  > & {
    id?: string
  },
  workspacePath?: string | null
): string {
  const transport = server.transport ?? 'stdio'
  const stdioWorkspace = transport === 'stdio' ? resolveStdioWorkspacePath(workspacePath) : null
  const authWorkspace =
    transport !== 'stdio' && isThisWorkspaceMcpAuth(server)
      ? server.authWorkspacePath?.trim() ?? ''
      : stdioWorkspace ?? ''
  // Auth secrets only apply to remote transports; skip for stdio (also keeps unit tests
  // that don't mock Electron from touching safeStorage).
  const authPresent =
    server.id && (transport === 'http' || transport === 'sse')
      ? hasMcpAuthToken(server.id) || hasStoredMcpOAuthBlob(server.id)
      : false
  const launchArgs = withWorkspaceRepositoryArgs(
    withCompatibleUvxArgs(server.command, server.args),
    stdioWorkspace
  )
  return JSON.stringify({
    transport,
    command: server.command ?? '',
    // Fingerprint the launch args we actually use so repairing `--with mcp<2`
    // in settings does not thrash reconnects against older stored args.
    args: launchArgs,
    cwd: transport === 'stdio' ? stdioWorkspace ?? '' : authWorkspace,
    env: sortedRecordEntries(server.env),
    url: server.url ?? '',
    // Never fingerprint secret token values — only presence + non-auth headers.
    headers: sortedRecordEntries(headersWithoutAuthorization(server.headers)),
    authPresent,
    oauthClientId: server.oauthClientId ?? '',
    authScope: server.authScope ?? '',
    authWorkspacePath: server.authWorkspacePath ?? '',
    googleAccess: server.googleAccess ?? ''
  })
}

/**
 * Resolve request headers for remote MCP: non-secret headers from settings plus
 * Bearer token from OS secure storage (wins over any leftover Authorization).
 */
export function resolveMcpRequestHeaders(
  server: Pick<McpServer, 'id' | 'headers' | 'authScope' | 'authWorkspacePath'>,
  workspacePath?: string | null
): Record<string, string> | undefined {
  const base = headersWithoutAuthorization(server.headers)
  if (!mcpAuthAllowedForWorkspace(server, workspacePath)) {
    return base && Object.keys(base).length > 0 ? base : undefined
  }
  const token = getMcpAuthToken(server.id)
  if (token) return withBearerToken(base, token)
  return base && Object.keys(base).length > 0 ? base : undefined
}

/**
 * If settings still hold a plaintext Bearer token, migrate it into safeStorage
 * and return headers with Authorization removed. Throws if safeStorage cannot store the secret.
 */
export function migratePlaintextMcpBearer(
  server: McpServer
): { server: McpServer; migrated: boolean } {
  const bearer = getBearerToken(server.headers)
  if (!bearer) return { server, migrated: false }
  if (!hasMcpAuthToken(server.id)) {
    setMcpAuthToken(server.id, bearer)
  }
  const nextHeaders = headersWithoutAuthorization(server.headers)
  return {
    server: { ...server, headers: nextHeaders },
    migrated: true
  }
}

export function validateMcpServers(servers: McpServer[]): string | null {
  const seen = new Set<string>()
  for (const server of servers) {
    if (server.id.includes('__')) {
      return `MCP server id must not contain "__": ${server.id}`
    }
    if (seen.has(server.id)) return `Duplicate MCP server id: ${server.id}`
    seen.add(server.id)
  }
  return null
}

function findSessionForStatus(
  server: McpServer,
  workspacePath?: string | null
): { session?: McpSession; error?: string } {
  if (isThisWorkspaceMcpAuth(server) && !mcpAuthAllowedForWorkspace(server, workspacePath)) {
    return {}
  }
  const key = sessionMapKey(server, workspacePath)
  const session = sessions.get(key)
  if (session) {
    return { session, error: connectErrors.get(key) }
  }
  if (isStdioTransport(server.transport)) {
    const wp = resolveStdioWorkspacePath(workspacePath)
    if (wp) {
      const stdioKey = mcpStdioSessionKey(server.id, wp)
      const stdioSession = sessions.get(stdioKey)
      if (stdioSession) {
        return { session: stdioSession, error: connectErrors.get(stdioKey) }
      }
      const stdioErr = connectErrors.get(stdioKey)
      if (stdioErr) return { error: stdioErr }
    }
    for (const [k, s] of sessions) {
      const parsed = parseMcpStdioSessionKey(k)
      if (parsed?.serverId === server.id) {
        return { session: s, error: connectErrors.get(k) }
      }
    }
    for (const [k, err] of connectErrors) {
      const parsed = parseMcpStdioSessionKey(k)
      if (parsed?.serverId === server.id) return { error: err }
    }
  }
  return {
    session: sessions.get(server.id),
    error: connectErrors.get(server.id)
  }
}

export function getMcpServerStatus(
  servers: McpServer[],
  workspacePath?: string | null
): McpServerStatus[] {
  return servers.map((server) => {
    const { session, error } = findSessionForStatus(server, workspacePath)
    const authVisible = mcpAuthAllowedForWorkspace(server, workspacePath)
    const staticClient = (() => {
      try {
        return resolveMcpOAuthStaticClient(server)
      } catch {
        return undefined
      }
    })()
    const hasPerServerSecret = (() => {
      try {
        return hasMcpOAuthClientSecret(server.id)
      } catch {
        return false
      }
    })()
    const hasSharedGoogleSecret =
      isGoogleMcpId(server.id) &&
      (() => {
        try {
          return hasGoogleMcpClientSecret()
        } catch {
          return false
        }
      })()
    return {
      id: server.id,
      name: server.name,
      enabled: server.enabled,
      connected: authVisible && Boolean(session),
      toolCount: authVisible ? (session?.tools.length ?? 0) : 0,
      hasAuthToken: authVisible && (hasMcpAuthToken(server.id) || hasMcpOAuthState(server.id)),
      hasOAuthClientSecret: hasPerServerSecret || hasSharedGoogleSecret,
      ...(staticClient ? { oauthRedirectUrl: mcpOAuthFixedRedirectUrl() } : {}),
      ...(error && authVisible ? { error } : {})
    }
  })
}

export function mcpStatusExtras(): { hasGoogleMcpClientSecret: boolean } {
  try {
    return { hasGoogleMcpClientSecret: hasGoogleMcpClientSecret() }
  } catch {
    return { hasGoogleMcpClientSecret: false }
  }
}

export async function refreshMcpServers(servers: McpServer[]): Promise<McpServerStatus[]> {
  // Force reconnect so dead stdio/HTTP sessions are recovered (sync alone skips existing entries).
  resetCircuitsByPrefix('mcp-connect:')
  resetCircuitsByPrefix('mcp-invoke:')
  connectConfigByKey.clear()
  for (const id of [...sessions.keys()]) {
    await disconnectMcpServer(id)
  }
  // Disconnect does not change the sync fingerprint; clear so syncMcpServers reconnects.
  lastSyncedServersFp = ''
  await syncMcpServers(servers)
  return getMcpServerStatus(servers)
}

/**
 * Client that declares the MCP `roots` capability and answers `roots/list` with
 * the active workspace root. Servers that scope themselves via roots (e.g.
 * filesystem) otherwise fall back to spawn cwd or fail — this makes the
 * workspace the explicit root. `listChanged: false`: sessions are keyed per
 * workspace, so a workspace change is a new connection, not a notification.
 */
function createMcpClient(workspacePath?: string | null): Client {
  const client = new Client({ name: 'vyotiq', version: '1.0.0' }, {
    capabilities: {
      roots: { listChanged: false }
    }
  })
  client.setRequestHandler(ListRootsRequestSchema, () => {
    const workspace = resolveStdioWorkspacePath(workspacePath)
    if (!workspace) return { roots: [] }
    return {
      roots: [
        {
          uri: pathToFileURL(workspace).href,
          name: basename(workspace)
        }
      ]
    }
  })
  return client
}

async function createTransport(
  server: McpServer,
  opts?: { authProvider?: ReturnType<typeof createMcpOAuthProvider>; workspacePath?: string | null }
): Promise<Transport> {
  const transport = server.transport ?? 'stdio'
  if (transport === 'stdio') {
    const command = (server.command ?? '').trim()
    if (!command) throw new Error(`MCP server ${server.id}: command required for stdio`)
    const cwd = resolveStdioWorkspacePath(opts?.workspacePath) ?? undefined
    const env = buildMcpChildEnv(server.env)
    const args = withWorkspaceRepositoryArgs(
      withCompatibleUvxArgs(command, server.args),
      cwd ?? null
    )
    return new StdioClientTransport({
      command,
      args,
      env,
      ...(cwd ? { cwd } : {})
    })
  }

  const urlRaw = (server.url ?? '').trim()
  if (!urlRaw) throw new Error(`MCP server ${server.id}: url required for ${transport}`)
  // Same SSRF posture as marketplace/catalog fetchPublicResponse — remote MCP is
  // public HTTP(S) only. Local MCP uses stdio; no product exception for loopback HTTP/SSE.
  const url = await assertPublicUrl(urlRaw)

  // Static Bearer takes precedence. With OAuth authProvider, do not set Authorization
  // via requestInit (SDK docs: headers + authProvider conflict).
  if (opts?.authProvider) {
    const base = headersWithoutAuthorization(server.headers)
    const requestInit = base && Object.keys(base).length > 0 ? { headers: base } : undefined
    if (transport === 'http') {
      return new StreamableHTTPClientTransport(url, {
        requestInit,
        authProvider: opts.authProvider
      })
    }
    return new SSEClientTransport(url, {
      requestInit,
      authProvider: opts.authProvider
    })
  }

  const headers = resolveMcpRequestHeaders(server, opts?.workspacePath)
  const requestInit = headers ? { headers } : undefined

  if (transport === 'http') {
    return new StreamableHTTPClientTransport(url, { requestInit })
  }
  return new SSEClientTransport(url, { requestInit })
}

type PendingMcpConnection = { client: Client; transport: Transport }

async function closePendingConnection(connection: PendingMcpConnection): Promise<void> {
  try {
    await connection.client.close()
  } catch {
    try {
      await connection.transport.close()
    } catch {
      // ignore cleanup failures
    }
  }
}

async function connectWithOptionalOAuth(
  server: McpServer,
  track: (connection: PendingMcpConnection) => void,
  workspacePath?: string | null,
  opts?: { interactiveOAuth?: boolean }
): Promise<{
  client: Client
  transport: Transport
}> {
  if (!mcpAuthAllowedForWorkspace(server, workspacePath)) {
    throw new Error(MCP_SIGN_IN_REQUIRED)
  }

  const transportKind = server.transport ?? 'stdio'
  if (transportKind === 'stdio' || hasMcpAuthToken(server.id)) {
    const transport = await createTransport(server, { workspacePath })
    const client = createMcpClient(workspacePath)
    track({ client, transport })
    await client.connect(transport)
    return { client, transport }
  }

  const interactive = opts?.interactiveOAuth === true
  const hostedUnconnected =
    isHostedAppMcpId(server.id) && !hasMcpOAuthState(server.id) && !hasMcpAuthToken(server.id)

  if (hostedUnconnected && !interactive) {
    throw new Error(MCP_SIGN_IN_REQUIRED)
  }

  if (isGoogleMcpId(server.id) && interactive) {
    const staticClient = resolveMcpOAuthStaticClient(server)
    if (!staticClient?.client_id || !staticClient.client_secret) {
      throw new Error('Add a Google Cloud OAuth client ID and secret before signing in.')
    }
  }

  // Prefer stored OAuth tokens via authProvider; otherwise try unauthenticated first.
  if (hasMcpOAuthState(server.id) && !interactive) {
    return connectRemoteWithOAuth(server, track, workspacePath, { interactive: false })
  }

  if (interactive) {
    return connectRemoteWithOAuth(server, track, workspacePath, { interactive: true })
  }

  const transport = await createTransport(server, { workspacePath })
  const client = createMcpClient(workspacePath)
  const connection = { client, transport }
  track(connection)
  try {
    await client.connect(transport)
    return connection
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) throw err
    if (isHostedAppMcpId(server.id)) {
      await closePendingConnection(connection)
      throw new Error(MCP_SIGN_IN_REQUIRED)
    }
    await closePendingConnection(connection)
    logger.info('MCP server requires OAuth — starting browser flow', {
      scope: 'mcp',
      serverId: server.id
    })
    return connectRemoteWithOAuth(server, track, workspacePath, { interactive: true })
  }
}

async function maybeLinkNativeGithubAfterMcpAuth(serverId: string): Promise<void> {
  if (!isGithubMcpId(serverId)) return
  try {
    const token =
      getMcpAuthToken(serverId) || getMcpOAuthState(serverId)?.tokens?.access_token || ''
    await linkNativeGithubFromMcpToken(token)
  } catch (err) {
    logger.warn('Could not link native GitHub after MCP auth', { scope: 'mcp', serverId, err })
  }
}

async function connectRemoteWithOAuth(
  server: McpServer,
  track: (connection: PendingMcpConnection) => void,
  workspacePath?: string | null,
  opts?: { interactive: boolean }
): Promise<{
  client: Client
  transport: Transport
}> {
  const staticClient = resolveMcpOAuthStaticClient(server)
  const { redirectUrl, waitForCode } = await beginMcpOAuthCallback(
    server.id,
    mcpOAuthCallbackListenOpts(staticClient)
  )
  const authProvider = createMcpOAuthProvider(server.id, redirectUrl, {
    staticClient,
    googleAccess: server.googleAccess
  })
  const transport = await createTransport(server, { authProvider, workspacePath })
  const client = createMcpClient(workspacePath)
  track({ client, transport })

  try {
    await client.connect(transport)
    cancelMcpOAuthCallback(server.id)
    return { client, transport }
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) {
      cancelMcpOAuthCallback(server.id)
      try {
        await client.close()
      } catch {
        // ignore
      }
      throw err
    }

    if (!opts?.interactive && isHostedAppMcpId(server.id)) {
      cancelMcpOAuthCallback(server.id)
      try {
        await client.close()
      } catch {
        // ignore
      }
      throw new Error(MCP_SIGN_IN_REQUIRED)
    }

    logger.info('MCP OAuth required — waiting for browser callback', {
      scope: 'mcp',
      serverId: server.id
    })
    try {
      const code = await waitForCode()
      if ('finishAuth' in transport && typeof transport.finishAuth === 'function') {
        await (
          transport as StreamableHTTPClientTransport | SSEClientTransport
        ).finishAuth(code)
      }
      try {
        await client.close()
      } catch {
        // ignore
      }
      const transport2 = await createTransport(server, { authProvider, workspacePath })
      const client2 = createMcpClient(workspacePath)
      track({ client: client2, transport: transport2 })
      await client2.connect(transport2)
      await maybeLinkNativeGithubAfterMcpAuth(server.id)
      return { client: client2, transport: transport2 }
    } catch (oauthErr) {
      cancelMcpOAuthCallback(server.id)
      try {
        await client.close()
      } catch {
        // ignore
      }
      throw oauthErr
    }
  }
}

export async function connectMcpServer(
  server: McpServer,
  workspacePath?: string | null,
  opts?: { interactiveOAuth?: boolean }
): Promise<void> {
  const key = sessionMapKey(server, workspacePath)
  if (sessions.has(key)) return
  const inflight = connecting.get(key)
  if (inflight) {
    await inflight
    return
  }

  const attempt = (async () => {
    // OAuth browser flow may take minutes; non-OAuth still fails fast via server errors.
    const CONNECT_TIMEOUT_MS = 120_000
    const connectAbort = AbortSignal.timeout(CONNECT_TIMEOUT_MS)
    const pending = new Set<PendingMcpConnection>()
    let connected: { client: Client; transport: Transport }
    try {
      connected = await Promise.race([
        connectWithOptionalOAuth(
          server,
          (connection) => pending.add(connection),
          workspacePath,
          opts
        ),
        new Promise<never>((_, reject) => {
          connectAbort.addEventListener(
            'abort',
            () =>
              reject(
                new Error(
                  `MCP connect timed out after ${CONNECT_TIMEOUT_MS / 1000}s (${server.id})`
                )
              ),
            { once: true }
          )
        })
      ])
    } catch (err) {
      const failure = err instanceof Error ? err : new Error('MCP connection failed')
      cancelMcpOAuthCallback(server.id, failure)
      await Promise.all([...pending].map(closePendingConnection))
      throw err
    }

    // Another concurrent path may have won while we were connecting.
    if (sessions.has(key)) {
      try {
        await connected.client.close()
      } catch {
        // ignore
      }
      return
    }

    const { client, transport } = connected
    const listed = await client.listTools()
    const tools: ToolDefinition[] = (listed.tools ?? []).map((t) => {
      const fullName = mcpToolName(server.id, t.name)
      mcpReadOnlyHints.set(fullName, t.annotations?.readOnlyHint === true)
      return {
        name: fullName,
        description: neutralizeUntrustedBody(
          t.description ?? `MCP tool ${t.name} (${server.name})`
        ),
        parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} }
      }
    })
    const { resources, prompts } = await probeResourcesAndPrompts(client)
    // If the server is still in the effective settings map, drop the session when
    // it was disabled or reconfigured mid-connect. Servers not in the map (explicit
    // connectMcpServer / unit fixtures) keep the just-established session.
    const desired = resolveEffectiveMcpServers().find((s) => s.id === server.id)
    if (
      desired &&
      (!desired.enabled ||
        mcpServerConfigKey(desired, workspacePath) !== mcpServerConfigKey(server, workspacePath))
    ) {
      try {
        await client.close()
      } catch {
        // ignore
      }
      return
    }
    sessions.set(key, { client, transport, tools, resources, prompts })
    rebuildToolsByNameIndex()
    sessionConfigKeys.set(key, mcpServerConfigKey(server, workspacePath))
    connectErrors.delete(key)
    connectErrors.delete(server.id)
    logger.info('MCP server connected', {
      scope: 'mcp',
      serverId: server.id,
      transport: server.transport ?? 'stdio',
      workspacePath: isStdioTransport(server.transport) ? resolveStdioWorkspacePath(workspacePath) : undefined,
      toolCount: tools.length,
      resourceCount: resources.length,
      promptCount: prompts.length
    })
  })()

  connecting.set(key, attempt)
  try {
    await attempt
  } finally {
    if (connecting.get(key) === attempt) connecting.delete(key)
  }
}

export type StartMcpOAuthOpts = {
  authScope?: McpAuthScope
  workspacePath?: string | null
  googleAccess?: GoogleMcpAccess
}

async function persistMcpOAuthConnectOpts(
  serverId: string,
  opts: StartMcpOAuthOpts
): Promise<void> {
  if (!opts.authScope && !opts.googleAccess) return
  await enqueueSettingsMutation(() => {
    const settings = getSettings()
    const nextServers = (settings.mcpServers ?? []).map((s) => {
      if (s.id !== serverId) return s
      const next: McpServer = { ...s }
      if (opts.authScope) {
        next.authScope = opts.authScope
        if (opts.authScope === MCP_AUTH_SCOPE_THIS) {
          const wp = opts.workspacePath?.trim()
          if (!wp) {
            throw new Error('This-workspace connect needs an open workspace.')
          }
          next.authWorkspacePath = wp
        } else {
          delete next.authWorkspacePath
        }
      }
      if (opts.googleAccess && isGoogleMcpId(serverId)) {
        next.googleAccess = opts.googleAccess
      }
      return next
    })
    setSettings({ mcpServers: nextServers })
  })
}

/** Force re-auth for a remote MCP server (clears OAuth tokens and reconnects). */
export async function startMcpOAuth(serverId: string, opts?: StartMcpOAuthOpts): Promise<void> {
  const id = serverId.trim()
  if (!id) throw new Error('MCP server id is required')
  if (opts) await persistMcpOAuthConnectOpts(id, opts)
  clearMcpOAuthState(id)
  await disconnectMcpServer(id)
  const servers = resolveEffectiveMcpServers()
  const server = servers.find((s) => s.id === id)
  if (!server) throw new Error(`MCP server not found: ${id}`)
  if ((server.transport ?? 'stdio') === 'stdio') {
    throw new Error('OAuth is only supported for HTTP/SSE MCP servers')
  }
  if (!server.enabled) throw new Error('Enable the MCP server before starting OAuth')
  const wp = isThisWorkspaceMcpAuth(server)
    ? server.authWorkspacePath?.trim() || getMcpStdioWorkspace()
    : null
  await connectMcpServer(server, wp, { interactiveOAuth: true })
}

export async function disconnectMcpServer(serverId: string): Promise<void> {
  const keys = [...sessions.keys()].filter(
    (key) => key === serverId || parseMcpStdioSessionKey(key)?.serverId === serverId
  )
  for (const key of keys) {
    await disconnectMcpSessionByKey(key)
  }
}

async function disconnectMcpSessionByKey(sessionKey: string): Promise<void> {
  const session = sessions.get(sessionKey)
  if (!session) return
  try {
    await session.client.close()
  } catch {
    // ignore
  }
  for (const tool of session.tools) {
    mcpReadOnlyHints.delete(tool.name)
  }
  sessions.delete(sessionKey)
  rebuildToolsByNameIndex()
  sessionConfigKeys.delete(sessionKey)
  connectErrors.delete(sessionKey)
  const parsed = parseMcpStdioSessionKey(sessionKey)
  if (parsed) connectErrors.delete(parsed.serverId)
}

export async function syncMcpServers(
  servers: McpServer[],
  opts?: { forceRetryFailures?: boolean }
): Promise<void> {
  const stdioWorkspaces = collectStdioWorkspacePaths()
  if (opts?.forceRetryFailures) {
    for (const server of servers) {
      if (!server.enabled) continue
      const keysToCheck = isStdioTransport(server.transport)
        ? stdioWorkspaces.map((wp) => sessionMapKey(server, wp))
        : isThisWorkspaceMcpAuth(server)
          ? [sessionMapKey(server, remoteSyncWorkspacePath(server, stdioWorkspaces))]
          : [server.id]
      for (const key of keysToCheck) {
        if (sessions.has(key)) continue
        if (!connectErrors.has(key) && !connectErrors.has(server.id)) continue
        const err = connectErrors.get(key) ?? connectErrors.get(server.id)
        if (quietMcpConnectSkip(err)) continue
        resetCircuit(circuitKeyMcpConnect(key))
        resetCircuit(circuitKeyMcpConnect(server.id))
        connectConfigByKey.delete(key)
        connectConfigByKey.delete(server.id)
      }
    }
    if (
      servers.some((s) => {
        if (!s.enabled) return false
        const keys = isStdioTransport(s.transport)
          ? stdioWorkspaces.map((wp) => sessionMapKey(s, wp))
          : isThisWorkspaceMcpAuth(s)
            ? [sessionMapKey(s, remoteSyncWorkspacePath(s, stdioWorkspaces))]
            : [s.id]
        return keys.some((key) => {
          if (sessions.has(key)) return false
          const err = connectErrors.get(key) ?? connectErrors.get(s.id)
          return Boolean(err) && !quietMcpConnectSkip(err)
        })
      })
    ) {
      lastSyncedServersFp = ''
    }
  }
  const fpParts: string[] = [stdioWorkspaces.sort().join(',')]
  for (const s of servers) {
    if (!s.enabled) {
      fpParts.push(`${s.id}:0`)
      continue
    }
    if (isStdioTransport(s.transport)) {
      for (const wp of stdioWorkspaces) {
        fpParts.push(`${s.id}@${wp}:1:${mcpServerConfigKey(s, wp)}`)
      }
    } else if (isThisWorkspaceMcpAuth(s)) {
      const wp = remoteSyncWorkspacePath(s, stdioWorkspaces)
      if (wp) fpParts.push(`${s.id}@${wp}:1:${mcpServerConfigKey(s, wp)}`)
      else fpParts.push(`${s.id}:bound-closed`)
    } else {
      fpParts.push(`${s.id}:1:${mcpServerConfigKey(s)}`)
    }
  }
  const fp = fpParts.sort().join('|')
  if (fp === lastSyncedServersFp) {
    if (lastSyncInflight) await lastSyncInflight
    return
  }
  const run = syncChain.then(() => syncMcpServersUnlocked(servers, stdioWorkspaces))
  // Keep the chain alive even when a sync rejects so later callers still queue.
  syncChain = run.then(
    () => undefined,
    () => undefined
  )
  lastSyncInflight = run.then(
    () => {
      lastSyncedServersFp = fp
    },
    () => undefined
  )
  await run
}

async function syncMcpServersUnlocked(
  servers: McpServer[],
  stdioWorkspaces: string[]
): Promise<void> {
  const duplicateError = validateMcpServers(servers)
  if (duplicateError) {
    throw new Error(duplicateError)
  }

  // Migrate any leftover plaintext Bearer tokens into OS secure storage.
  let migratedAny = false
  const migratedServers = servers.map((server) => {
    const { server: next, migrated } = migratePlaintextMcpBearer(server)
    if (migrated) migratedAny = true
    return next
  })
  if (migratedAny) {
    try {
      const settings = getSettings()
      const byId = new Map(migratedServers.map((s) => [s.id, s]))
      const nextList = (settings.mcpServers ?? []).map((s) => byId.get(s.id) ?? s)
      // Also strip Authorization from any server we migrated that is in settings.
      for (const s of migratedServers) {
        if (!byId.has(s.id)) continue
        const idx = nextList.findIndex((x) => x.id === s.id)
        if (idx >= 0) nextList[idx] = s
      }
      void enqueueSettingsMutation(() => setSettings({ mcpServers: nextList }))
    } catch (err) {
      logger.warn('Failed to persist migrated MCP auth headers', { scope: 'mcp', err })
    }
  }

  const enabled = migratedServers.filter((s) => s.enabled)
  const enabledIds = new Set(enabled.map((s) => s.id))
  const neededKeys = new Set<string>()
  for (const server of enabled) {
    if (isStdioTransport(server.transport)) {
      for (const wp of stdioWorkspaces) neededKeys.add(sessionMapKey(server, wp))
    } else if (isThisWorkspaceMcpAuth(server)) {
      const wp = remoteSyncWorkspacePath(server, stdioWorkspaces)
      if (wp) neededKeys.add(sessionMapKey(server, wp))
    } else {
      neededKeys.add(server.id)
    }
  }

  for (const key of [...sessions.keys()]) {
    const parsed = parseMcpStdioSessionKey(key)
    const serverId = parsed?.serverId ?? key
    if (!enabledIds.has(serverId) || !neededKeys.has(key)) {
      await disconnectMcpSessionByKey(key)
    }
  }

  const syncOne = async (server: McpServer, workspacePath: string | null): Promise<void> => {
    const key = sessionMapKey(server, workspacePath)
    const configKey = mcpServerConfigKey(server, workspacePath)
    const connectedKey = sessionConfigKeys.get(key)
    if (sessions.has(key) && connectedKey !== configKey) {
      await disconnectMcpSessionByKey(key)
      resetCircuit(circuitKeyMcpConnect(key))
      resetCircuit(circuitKeyMcpConnect(server.id))
      connectConfigByKey.delete(key)
      connectConfigByKey.delete(server.id)
    }
    if (sessions.has(key)) return

    if (isGitMcpServer(server) && workspacePath) {
      if (!isGitRepo(workspacePath)) {
        const message = gitMcpNotARepoMessage(workspacePath)
        const prior = connectErrors.get(key)
        connectErrors.set(key, message)
        if (prior !== message) {
          logger.warn('MCP connect skipped — workspace is not a Git repository', {
            scope: 'mcp',
            serverId: server.id,
            workspacePath,
            reason: message
          })
        }
        return
      }
      if (isGitMcpNotARepoError(connectErrors.get(key))) {
        connectErrors.delete(key)
      }
    }

    if (connectConfigByKey.get(key) !== configKey) {
      resetCircuit(circuitKeyMcpConnect(key))
      connectConfigByKey.set(key, configKey)
    }
    try {
      assertCircuitClosed(circuitKeyMcpConnect(key), MCP_CONNECT_CIRCUIT_POLICY)
    } catch (err) {
      if (isCircuitOpenError(err)) return
      throw err
    }
    try {
      await connectMcpServer(server, workspacePath)
      recordCircuitSuccess(circuitKeyMcpConnect(key))
    } catch (err) {
      const message = formatError(err)
      const code = mcpConnectErrorCode(err)
      connectErrors.set(key, message)
      recordCircuitFailure(circuitKeyMcpConnect(key), MCP_CONNECT_CIRCUIT_POLICY)
      if (quietMcpConnectSkip(message)) return
      const logged = new AppError(message, {
        code,
        severity: 'warn',
        retriable: !isGitMcpNotARepoError(message),
        cause: err instanceof Error ? err : undefined
      })
      logger.warn('MCP connect failed', {
        scope: 'mcp',
        serverId: server.id,
        workspacePath: workspacePath ?? undefined,
        code,
        reason: message,
        err: logged
      })
    }
  }

  for (const server of enabled) {
    if (isStdioTransport(server.transport)) {
      for (const wp of stdioWorkspaces) {
        await syncOne(server, wp)
      }
    } else if (isThisWorkspaceMcpAuth(server)) {
      const wp = remoteSyncWorkspacePath(server, stdioWorkspaces)
      if (wp) await syncOne(server, wp)
    } else {
      await syncOne(server, null)
    }
  }
  // MCP tools/status feed /mcp slash availability — bust the 5s list cache.
  invalidateSlashCommandsCache()
}

export function listMcpToolDefinitions(): ToolDefinition[] {
  const seen = new Set<string>()
  const out: ToolDefinition[] = []
  for (const session of sessions.values()) {
    for (const tool of session.tools) {
      if (seen.has(tool.name)) continue
      seen.add(tool.name)
      out.push({
        ...tool,
        description: neutralizeUntrustedBody(tool.description)
      })
    }
  }
  return out
}

export async function listMcpResources(
  serverId?: string,
  enabledIds?: ReadonlySet<string>,
  signal?: AbortSignal,
  workspacePath?: string | null
): Promise<McpResourceEntry[]> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const targetIds = resolveTargetServerIds(serverId, enabledIds, workspacePath)
  const out: McpResourceEntry[] = []
  for (const id of targetIds) {
    const resolved = resolveSessionForServer(id, workspacePath)
    if (!resolved) continue
    const session = resolved.session
    try {
      const listed = await session.client.listResources(undefined, { signal })
      for (const resource of listed.resources ?? []) {
        out.push({
          serverId: id,
          uri: resource.uri,
          name: resource.name,
          description: resource.description
            ? neutralizeUntrustedBody(resource.description)
            : undefined,
          mimeType: resource.mimeType
        })
      }
    } catch (err) {
      if (signal?.aborted || isAbortError(err)) throw err
      for (const resource of session.resources ?? []) {
        out.push({ serverId: id, ...resource })
      }
    }
  }
  return out
}

function beginMcpInvoke(sessionKey: string): { ok: true } | { ok: false; error: string } {
  try {
    assertCircuitClosed(circuitKeyMcpInvoke(sessionKey))
    return { ok: true }
  } catch (err) {
    if (isCircuitOpenError(err)) return { ok: false, error: err.message }
    throw err
  }
}

export async function readMcpResource(
  serverId: string,
  uri: string,
  signal: AbortSignal,
  enabledIds?: ReadonlySet<string>,
  workspacePath?: string | null
): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  const access = assertMcpServerAccess(serverId, enabledIds, workspacePath)
  if (!access.ok) return access
  const gate = beginMcpInvoke(access.sessionKey)
  if (!gate.ok) return gate
  try {
    const result = await access.session.client.readResource({ uri }, { signal })
    const text = formatResourceContents(
      (result.contents ?? []) as Array<{
        type?: string
        text?: string
        blob?: string
        mimeType?: string
      }>
    )
    recordCircuitSuccess(circuitKeyMcpInvoke(access.sessionKey))
    return { ok: true, content: wrapMcpPayload(text || '(empty)', `${serverId}:${uri}`) }
  } catch (err) {
    if (signal.aborted || isAbortError(err)) {
      releaseCircuitProbe(circuitKeyMcpInvoke(access.sessionKey))
      throw err
    }
    recordCircuitFailure(circuitKeyMcpInvoke(access.sessionKey))
    connectErrors.set(access.sessionKey, formatError(err))
    await disconnectMcpSessionByKey(access.sessionKey)
    return { ok: false, error: formatError(err) }
  }
}

export async function listMcpPrompts(
  serverId?: string,
  enabledIds?: ReadonlySet<string>,
  signal?: AbortSignal,
  workspacePath?: string | null
): Promise<McpPromptEntry[]> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const targetIds = resolveTargetServerIds(serverId, enabledIds, workspacePath)
  const out: McpPromptEntry[] = []
  for (const id of targetIds) {
    const resolved = resolveSessionForServer(id, workspacePath)
    if (!resolved) continue
    const session = resolved.session
    try {
      const listed = await session.client.listPrompts(undefined, { signal })
      for (const prompt of listed.prompts ?? []) {
        out.push({
          serverId: id,
          name: prompt.name,
          description: prompt.description
            ? neutralizeUntrustedBody(prompt.description)
            : undefined,
          arguments: prompt.arguments
        })
      }
    } catch (err) {
      if (signal?.aborted || isAbortError(err)) throw err
      for (const prompt of session.prompts ?? []) {
        out.push({ serverId: id, ...prompt })
      }
    }
  }
  return out
}

export async function getMcpPrompt(
  serverId: string,
  name: string,
  promptArgs: Record<string, string> | undefined,
  signal: AbortSignal,
  enabledIds?: ReadonlySet<string>,
  workspacePath?: string | null
): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  const access = assertMcpServerAccess(serverId, enabledIds, workspacePath)
  if (!access.ok) return access
  const gate = beginMcpInvoke(access.sessionKey)
  if (!gate.ok) return gate
  try {
    const result = await access.session.client.getPrompt(
      { name, arguments: promptArgs },
      { signal }
    )
    const header = result.description ? `${result.description}\n\n` : ''
    const body = formatPromptMessages(
      (result.messages ?? []) as Array<{
        role?: string
        content?: { type?: string; text?: string } | string
      }>
    )
    recordCircuitSuccess(circuitKeyMcpInvoke(access.sessionKey))
    return { ok: true, content: wrapMcpPayload((header + body).trim() || '(empty)', `${serverId}/${name}`) }
  } catch (err) {
    if (signal.aborted || isAbortError(err)) {
      releaseCircuitProbe(circuitKeyMcpInvoke(access.sessionKey))
      throw err
    }
    recordCircuitFailure(circuitKeyMcpInvoke(access.sessionKey))
    connectErrors.set(access.sessionKey, formatError(err))
    await disconnectMcpSessionByKey(access.sessionKey)
    return { ok: false, error: formatError(err) }
  }
}

export function getMcpToolDefinition(fullName: string): ToolDefinition | undefined {
  return toolsByName.get(fullName)
}

export async function invokeMcpTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  fullToolName?: string,
  enabledIds?: ReadonlySet<string>,
  workspacePath?: string | null
): Promise<ToolResult> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  const summary = mcpToolSummary(toolName, args)
  const access = assertMcpServerAccess(serverId, enabledIds, workspacePath)
  if (!access.ok) {
    return { ok: false, summary, content: access.error }
  }
  const session = access.session
  const gate = beginMcpInvoke(access.sessionKey)
  if (!gate.ok) {
    return { ok: false, summary, content: gate.error }
  }
  try {
    const toolDef = access.session.tools.find((tool) => tool.name === toolName)
    const argsError = toolDef
      ? validateMcpToolArgs(toolName, args, toolDef.parameters)
      : null
    if (argsError) {
      return { ok: false, summary, content: argsError }
    }
    const result = await session.client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { signal }
    )
    const text = (result.content as Array<{ type?: string; text?: string }>)
      .map((c) => (c.type === 'text' ? c.text ?? '' : JSON.stringify(c)))
      .join('\n')
    const ok = result.isError !== true
    const prefix = ok ? '' : `[MCP ${fullToolName ?? toolName} error]\n`
    const content =
      prefix +
      wrapMcpPayload(capMcpText(text || '(empty)'), `${serverId}/${toolName}`)
    recordCircuitSuccess(circuitKeyMcpInvoke(access.sessionKey))
    return { ok, summary, content }
  } catch (err) {
    if (signal.aborted || isAbortError(err)) {
      releaseCircuitProbe(circuitKeyMcpInvoke(access.sessionKey))
      throw new DOMException('Aborted', 'AbortError')
    }
    recordCircuitFailure(circuitKeyMcpInvoke(access.sessionKey))
    const message = formatError(err)
    const transient =
      /timeout|ETIMEDOUT|ECONNRESET|socket hang up/i.test(message)
    if (transient) {
      // Keep the session; model can retry. Permanent protocol errors still drop it.
      connectErrors.set(access.sessionKey, message)
      return {
        ok: false,
        summary,
        content: `MCP invoke failed on "${serverId}" (session kept for retry): ${message}`
      }
    }
    connectErrors.set(access.sessionKey, message)
    await disconnectMcpSessionByKey(access.sessionKey)
    return {
      ok: false,
      summary,
      content: `MCP invoke failed on "${serverId}" (disconnected; will reconnect on next sync): ${message}`
    }
  }
}

export async function shutdownMcpServers(): Promise<void> {
  for (const id of [...sessions.keys()]) {
    await disconnectMcpServer(id)
  }
}

/** Test helper */
export function resetMcpSessionsForTests(): void {
  sessions.clear()
  connectErrors.clear()
  sessionConfigKeys.clear()
  mcpReadOnlyHints.clear()
  connectConfigByKey.clear()
  resetCircuitsByPrefix('mcp-')
  connecting.clear()
  syncChain = Promise.resolve()
  lastSyncedServersFp = null
  lastSyncInflight = null
  mcpStdioWorkspacePath = null
}

/** Test helper — register MCP readOnlyHint values without a live server. */
export function setMcpReadOnlyHintsForTests(hints: Record<string, boolean>): void {
  for (const [name, readOnly] of Object.entries(hints)) {
    mcpReadOnlyHints.set(name, readOnly)
  }
}

/** Test helper — connected MCP server ids (deduped from session keys). */
export function listConnectedMcpServerIdsForTests(): string[] {
  const ids = new Set<string>()
  for (const key of sessions.keys()) {
    const parsed = parseMcpStdioSessionKey(key)
    ids.add(parsed?.serverId ?? key)
  }
  return [...ids]
}

/** Test helper — register a mock MCP session without a live transport. */
export function registerMcpSessionForTests(
  serverId: string,
  client: Pick<
    Client,
    | 'listTools'
    | 'listResources'
    | 'readResource'
    | 'listPrompts'
    | 'getPrompt'
    | 'getServerCapabilities'
    | 'close'
  > &
    Partial<Pick<Client, 'callTool'>>,
  tools: ToolDefinition[] = []
): void {
  sessions.set(serverId, {
    client: client as Client,
    transport: {} as Transport,
    tools
  })
}
