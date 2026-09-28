import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import {
  ErrorCode,
  ListRootsRequestSchema,
  McpError,
  type Prompt,
  type Resource,
  type Tool
} from '@modelcontextprotocol/sdk/types.js'
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { pathToFileURL } from 'url'
import { basename } from 'path'
import Ajv from 'ajv'
import Ajv2020 from 'ajv/dist/2020'
import type { ValidateFunction } from 'ajv'
import type { McpServer } from '../../../shared/ipc'
import type { McpServerStatus } from '../../../shared/ipc'
import type { ToolDefinition } from '../providers/types'
import { logger } from '../../../shared/logger'
import { neutralizeUntrustedBody, wrapUntrustedContent } from '../untrustedContent'
import { mcpToolSummary } from '../../../shared/toolSummary'
import type { ToolResult } from '../tools'
import type { ToolImageRef } from '../../../shared/ipc'
import { storeToolImage } from '../toolImageStore'
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
  createMcpOAuthProvider,
  MCP_OAUTH_CALLBACK_TIMEOUT_MS
} from './oauth'
import {
  mcpOAuthCallbackListenOpts,
  resolveMcpOAuthStaticClient
} from './oauthStaticClient'
import { hasBundledGoogleMcpClient } from './googleMcpClient'
import {
  clearMcpBinaryCache,
  findMissingMcpBinary,
  mcpSearchPath,
  missingMcpBinaryMessage,
  type MissingMcpBinary
} from './binaries'
import { linkNativeGithubFromMcpToken } from '../../git/githubAuth'
import { getGithubAccessToken, hasGithubAccessToken } from '../../settings/secrets'
import {
  isGithubMcpId,
  isGoogleMcpId,
  isHostedAppMcpId,
  isThisWorkspaceMcpAuth,
  mcpAuthAllowedForWorkspace,
  mcpOAuthFixedRedirectUrl,
  mcpRequiresOAuth,
  MCP_AUTH_SCOPE_THIS,
  type GoogleMcpAccess,
  type McpAuthScope
} from '../../../shared/mcpApps'
import {
  resolveEffectiveMcpServers,
  resolveMcpServersForSessionMap
} from '../../marketplace/resolve'
import { sanitizeMcpManifestEnv } from '../../marketplace/sanitizeMcpEnv'
import {
  gitMcpNotARepoMessage,
  isGitMcpNotARepoError,
  isGitMcpServer,
  withCompatibleUvxArgs,
  withWorkspaceRepositoryArgs
} from './uvxCompat'
import {
  MCP_SIGN_IN_REQUIRED,
  isMcpMissingBinaryError,
  isMcpSignInRequiredError
} from './errorKinds'
import {
  classifyMcpConnectError,
  describeMcpConnectError,
  isRetriableMcpConnectError
} from './connectErrors'
import { httpRetryBackoffMs, sleepAbortable } from '../providers/fetchWithRetry'
import { isGitRepo } from '../../git/git'
import { readWorkspacesState } from '../../workspace/workspaces'
import { workspacePathsEqual } from '../../../shared/workspacePath'
import { workspaceIdFromPath } from '../../../shared/workspaceId'
import { listActiveRuns } from '../runRegistry'
import { formatError, isAbortError, mcpConnectErrorCode } from '../../../shared/errors'
import { assertPublicUrl } from '@main/net/webFetch'
import { recordEgress } from '@main/net/egress'
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

export {
  MCP_SIGN_IN_REQUIRED,
  isMcpMissingBinaryError,
  isMcpSignInRequiredError
} from './errorKinds'

function quietMcpConnectSkip(message: string | null | undefined): boolean {
  return (
    isGitMcpNotARepoError(message) ||
    isMcpSignInRequiredError(message) ||
    // Retrying cannot install a binary. The UI offers Install / Locate, and
    // Refresh clears the resolver cache, so that is the path back.
    isMcpMissingBinaryError(message)
  )
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
  // Hand the child the same PATH we resolved the binary on. Without this a
  // server launched from a Finder-started app finds `npx` but not the tools
  // `npx` then shells out to. `sanitizeMcpManifestEnv` strips PATH from the
  // overlay, so this can only come from us.
  const searchPath = mcpSearchPath(source)
  if (searchPath) {
    env.PATH = searchPath
    // Windows env vars are case-insensitive but the object is not; a leftover
    // `Path` would shadow the value we just set.
    delete env.Path
  }
  return env
}

/** A stdio server whose launch binary is missing, carried so the UI can offer a fix. */
export class McpMissingBinaryError extends Error {
  readonly missing: MissingMcpBinary

  constructor(serverId: string, missing: MissingMcpBinary) {
    super(missingMcpBinaryMessage(missing))
    this.name = 'McpMissingBinaryError'
    this.missing = missing
    this.serverId = serverId
  }

  readonly serverId: string
}

export const MCP_TOOL_PREFIX = 'mcp__'

export function mcpToolName(serverId: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverId}__${toolName}`
}

/**
 * Longest tool name any supported provider accepts. OpenAI-compatible
 * endpoints cap lower (64), so a very long name can still be rejected there;
 * this bound is about the unbounded case, where a single server would break
 * every request.
 */
const MCP_TOOL_NAME_MAX = 128

/**
 * Is this name safe to put in front of a model?
 *
 * MCP does not constrain tool names, but every provider forwards them to the
 * API verbatim and rejects anything outside `[A-Za-z0-9_-]` or past its length
 * cap — with a 400 for the whole request, not just that tool. One unusual tool
 * would therefore break every turn while the server itself looked healthy.
 */
export function isSupportedMcpToolName(fullName: string): boolean {
  return fullName.length <= MCP_TOOL_NAME_MAX && /^[A-Za-z0-9_-]+$/.test(fullName)
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
  /** Kept so a `tools/list_changed` refresh can rebuild names and fallback descriptions. */
  server?: Pick<McpServer, 'id' | 'name'>
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

/** Most entries one resources/prompts listing returns, across servers. */
export const MCP_LIST_ENTRY_CAP = 100
/** Per-entry description cap in those listings. */
const MCP_LIST_DESCRIPTION_CAP = 200
/** Pages followed for one list call — a server that keeps handing out cursors must not spin forever. */
const MCP_LIST_MAX_PAGES = 50

/**
 * Every page of a paginated MCP list. `tools/list`, `resources/list` and
 * `prompts/list` all page with `nextCursor`; reading only the first page
 * silently dropped whatever a server put after it.
 */
async function collectMcpPages<T>(
  fetchPage: (cursor: string | undefined) => Promise<{ items: T[] | undefined; nextCursor?: string }>
): Promise<T[]> {
  const out: T[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < MCP_LIST_MAX_PAGES; page++) {
    const { items, nextCursor } = await fetchPage(cursor)
    out.push(...(items ?? []))
    if (!nextCursor || seen.has(nextCursor)) break
    seen.add(nextCursor)
    cursor = nextCursor
  }
  return out
}

function capListDescription(description: string | undefined): string | undefined {
  if (!description) return undefined
  const neutral = neutralizeUntrustedBody(description)
  return neutral.length > MCP_LIST_DESCRIPTION_CAP
    ? `${neutral.slice(0, MCP_LIST_DESCRIPTION_CAP)}…`
    : neutral
}

function isMcpMethodNotFound(err: unknown): boolean {
  return err instanceof McpError && err.code === ErrorCode.MethodNotFound
}

type McpArgValidator = { validate: ValidateFunction; ajv: Ajv | Ajv2020 }

/**
 * Created on first use and dropped with the validator cache. Ajv keeps every
 * schema it has compiled in an internal Map, so one long-lived instance grew
 * by a schema per called tool on every reconnect.
 */
let ajvDraft07: Ajv | null = null
let ajvDraft2020: Ajv2020 | null = null

/**
 * The dialect a server declared. The TypeScript MCP SDK emits draft-07
 * (`"$schema": "http://json-schema.org/draft-07/schema#"`), which Ajv2020
 * cannot even resolve — compile threw and validation failed open for every
 * tool those servers expose.
 */
function ajvForSchema(schema: Record<string, unknown>): Ajv | Ajv2020 {
  const dialect = typeof schema.$schema === 'string' ? schema.$schema : ''
  if (/draft-0[4-7]/.test(dialect)) {
    return (ajvDraft07 ??= new Ajv({ allErrors: true, strict: false }))
  }
  return (ajvDraft2020 ??= new Ajv2020({ allErrors: true, strict: false }))
}

/**
 * Compiled per server/tool inputSchema; cleared when a server re-lists tools.
 * Keyed by the prefixed `mcp__server__tool` name — a bare key let two servers
 * that both expose, say, `search` validate against each other's schema.
 */
const mcpArgValidatorCache = new Map<string, McpArgValidator | null>()

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
  let validator = mcpArgValidatorCache.get(toolName)
  if (validator === undefined) {
    const schema = inputSchema as Record<string, unknown>
    const ajv = ajvForSchema(schema)
    // The instance fixes the dialect, so the root `$schema` has nothing left to say.
    const { $schema: _dialect, ...body } = schema
    try {
      validator = { validate: ajv.compile(body), ajv }
    } catch (err) {
      logger.warn('MCP inputSchema failed to compile; skipping arg validation', {
        scope: 'mcp',
        correlationId: toolName,
        err
      })
      validator = null
    }
    mcpArgValidatorCache.set(toolName, validator)
  }
  if (!validator) return null
  const { validate, ajv } = validator
  if (validate(args)) return null
  const detail = ajv.errorsText(validate.errors?.slice(0, 5))
  return `Invalid arguments for MCP tool "${toolName}": ${detail}`
}

function wrapMcpPayload(body: string, origin: string): string {
  return wrapUntrustedContent(body, { source: 'mcp', origin })
}

function listAllResources(client: Client, signal?: AbortSignal): Promise<Resource[]> {
  return collectMcpPages(async (cursor) => {
    const listed = await client.listResources(cursor ? { cursor } : undefined, { signal })
    return { items: listed.resources, nextCursor: listed.nextCursor }
  })
}

function listAllPrompts(client: Client, signal?: AbortSignal): Promise<Prompt[]> {
  return collectMcpPages(async (cursor) => {
    const listed = await client.listPrompts(cursor ? { cursor } : undefined, { signal })
    return { items: listed.prompts, nextCursor: listed.nextCursor }
  })
}

function resourceSummary(resource: Resource): McpResourceSummary {
  return {
    uri: resource.uri,
    name: resource.name,
    description: capListDescription(resource.description),
    mimeType: resource.mimeType
  }
}

function promptSummary(prompt: Prompt): McpPromptSummary {
  return {
    name: prompt.name,
    description: capListDescription(prompt.description),
    arguments: prompt.arguments
  }
}

async function probeResourcesAndPrompts(
  client: Client,
  signal?: AbortSignal
): Promise<{
  resources: McpResourceSummary[]
  prompts: McpPromptSummary[]
}> {
  let resources: McpResourceSummary[] = []
  let prompts: McpPromptSummary[] = []
  const caps = client.getServerCapabilities()
  if (caps?.resources) {
    try {
      resources = (await listAllResources(client, signal))
        .slice(0, MCP_LIST_ENTRY_CAP)
        .map(resourceSummary)
    } catch {
      // Server may advertise resources but fail list — ignore on connect.
    }
  }
  if (caps?.prompts) {
    try {
      prompts = (await listAllPrompts(client, signal))
        .slice(0, MCP_LIST_ENTRY_CAP)
        .map(promptSummary)
    } catch {
      // Server may advertise prompts but fail list — ignore on connect.
    }
  }
  return { resources, prompts }
}

function resolveTargetServerIds(
  serverId: string | undefined,
  enabledIds?: ReadonlySet<string>
): string[] {
  const ids = new Set<string>()
  for (const key of sessions.keys()) {
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

type McpContentBlock = {
  type?: string
  text?: string
  data?: string
  mimeType?: string
  resource?: { uri?: string; text?: string; blob?: string; mimeType?: string }
}

/** Decoded size of a base64 payload, without decoding it. */
function base64Bytes(data: string): number {
  return Math.floor((data.replace(/=+$/, '').length * 3) / 4)
}

/**
 * Model-facing text for a tool-result block that is neither text nor a stored
 * image. Binary bodies become a one-line summary, as blobs do in
 * `formatResourceContents`; an embedded resource keeps its base64 under
 * `resource.blob`, so eliding only top-level fields still pasted it whole.
 */
function formatMcpContentBlock(block: McpContentBlock): string {
  switch (block.type) {
    case 'image':
    case 'audio':
      return `[${block.type} mime=${block.mimeType ?? 'unknown'} bytes=${
        typeof block.data === 'string' ? base64Bytes(block.data) : 0
      }]`
    case 'resource': {
      const resource = block.resource
      if (typeof resource?.text === 'string') return resource.text
      if (typeof resource?.blob === 'string') {
        return `[resource uri=${resource.uri ?? 'unknown'} mime=${
          resource.mimeType ?? 'unknown'
        } bytes=${base64Bytes(resource.blob)}]`
      }
      return JSON.stringify(block)
    }
    default:
      return JSON.stringify(block)
  }
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

/**
 * Bumped whenever a session connects or closes or its tool list changes. A
 * per-step catalog cache keyed on config alone never saw a server that came
 * up (or went away) without a settings change.
 */
let mcpSessionGeneration = 0

export function getMcpSessionGeneration(): number {
  return mcpSessionGeneration
}

function rebuildToolsByNameIndex(): void {
  mcpSessionGeneration++
  toolsByName.clear()
  // Stale validators must not outlive the schema that compiled them.
  mcpArgValidatorCache.clear()
  ajvDraft07 = null
  ajvDraft2020 = null
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
/**
 * Count of fingerprint invalidations. A sync records its fingerprint only if
 * none happened while it ran: a session that dies mid-sync is not something
 * that sync rebuilt, and recording over it left the server dead until the
 * config changed.
 */
let syncInvalidations = 0

/** Per-call cap for MCP tool invocations; the SDK default of 60s is too low. */
const MCP_INVOKE_TIMEOUT_MS = 120_000
/** Hard bound even when a server keeps streaming progress notifications. */
const MCP_INVOKE_MAX_TOTAL_TIMEOUT_MS = 600_000

/**
 * Forget the last synced fingerprint so the next `syncMcpServers` really runs.
 *
 * Dropping a session does not change the server list, so without this the
 * fingerprint still matches and sync short-circuits: the session that was just
 * torn down is never rebuilt. That is why a server killed by one failed tool
 * call stayed dead until the user hit Refresh. `refreshMcpServers` has always
 * done this by hand; every teardown path needs it.
 */
function invalidateSyncFingerprint(): void {
  lastSyncedServersFp = ''
  syncInvalidations++
}

/**
 * Does this error mean the session itself is gone, so a fresh connect is
 * required before the tool can work again?
 *
 * Everything else keeps the session. A bad argument, a server-side 500, or a
 * request timeout says nothing about the transport, and tearing the session
 * down on those is what stranded servers: the drop was permanent because sync
 * skipped the unchanged fingerprint. Auth failures count as fatal so the
 * reconnect can refresh the token or surface "Sign in required" honestly,
 * instead of leaving a server that silently answers nothing.
 */
export function isMcpSessionFatalError(message: string | null | undefined): boolean {
  if (!message) return false
  return (
    /not connected/i.test(message) ||
    /connection closed/i.test(message) ||
    /transport (is )?closed/i.test(message) ||
    /session (not found|terminated|expired)/i.test(message) ||
    /\b(EPIPE|ECONNRESET|ECONNREFUSED|ENOTFOUND|ECONNABORTED)\b/i.test(message) ||
    /socket hang up/i.test(message) ||
    /unauthorized|invalid_token|\b401\b/i.test(message) ||
    /fetch failed/i.test(message)
  )
}

/** Reason recorded when a transport closes underneath us. */
const MCP_TRANSPORT_CLOSED = 'MCP server closed the connection'

/**
 * A transport died on its own: a stdio child exited, or the remote expired the
 * session. Without this the entry stays in `sessions` reporting `connected`
 * with a full tool count, sync skips it because the key is present, and the
 * model keeps being offered tools that cannot run.
 */
function handleMcpSessionClosed(sessionKey: string, client: Client): void {
  const session = sessions.get(sessionKey)
  // A deliberate teardown detaches this handler first, and a reconnect may
  // already have replaced the entry, so only react to our own live session.
  if (!session || session.client !== client) return
  for (const tool of session.tools) {
    mcpReadOnlyHints.delete(tool.name)
  }
  sessions.delete(sessionKey)
  rebuildToolsByNameIndex()
  sessionConfigKeys.delete(sessionKey)
  connectErrors.set(sessionKey, MCP_TRANSPORT_CLOSED)
  invalidateSyncFingerprint()
  const stdio = parseMcpStdioSessionKey(sessionKey)
  logger.warn('MCP session closed by transport; will reconnect on next sync', {
    scope: 'mcp',
    serverId: stdio?.serverId ?? sessionKey,
    ...(stdio ? { workspaceId: workspaceIdFromPath(stdio.workspacePath) } : {})
  })
}

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
/**
 * A Bearer the app can supply without asking the user to paste anything.
 *
 * GitHub advertises no dynamic client registration, so the documented route to
 * its hosted MCP is: register an OAuth app by hand, copy a client id, paste a
 * secret. But the app already signs in to GitHub on its own account — device
 * flow, no secret, one click — and `api.githubcopilot.com` takes that same
 * user token as a Bearer. Reusing it turns the one server that most needed
 * manual setup into a server that needs none.
 *
 * Returns nothing unless the sign-in actually happened; a server-specific
 * credential always wins over this (see `resolveMcpBearerToken`).
 */
export function inheritedMcpBearer(serverId: string): string | null {
  if (!isGithubMcpId(serverId)) return null
  // Stored OAuth for this server means the user chose a specific identity for
  // it; inheriting the app's would silently connect them as someone else.
  if (hasStoredMcpOAuthBlob(serverId) || hasMcpOAuthState(serverId)) return null
  try {
    const token = getGithubAccessToken()?.trim()
    return token ? token : null
  } catch {
    // Secure storage unavailable is not a reason to fail the connect: the
    // normal OAuth path is still there.
    return null
  }
}

/**
 * Same question as `inheritedMcpBearer`, without decrypting. Status is polled
 * on every settings change and install, and the answer only needs a yes/no.
 */
export function hasInheritedMcpBearer(serverId: string): boolean {
  if (!isGithubMcpId(serverId)) return false
  if (hasStoredMcpOAuthBlob(serverId) || hasMcpOAuthState(serverId)) return false
  try {
    return hasGithubAccessToken()
  } catch {
    return false
  }
}

/** The Bearer to send, preferring a credential stored for this server. */
export function resolveMcpBearerToken(serverId: string): string | null {
  return getMcpAuthToken(serverId) ?? inheritedMcpBearer(serverId)
}

export function resolveMcpRequestHeaders(
  server: Pick<McpServer, 'id' | 'headers' | 'authScope' | 'authWorkspacePath'>,
  workspacePath?: string | null
): Record<string, string> | undefined {
  const base = headersWithoutAuthorization(server.headers)
  if (!mcpAuthAllowedForWorkspace(server, workspacePath)) {
    return base && Object.keys(base).length > 0 ? base : undefined
  }
  const token = resolveMcpBearerToken(server.id)
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

/**
 * Is a connect for this server in flight right now?
 *
 * Without this the first seconds of every launch look like an outage: sync
 * dials every enabled server, and until the first one answers each reports
 * `enabled: true, connected: false` with no error, which Home renders as
 * "<name> is not connected — the server is enabled but reported no
 * connection." Four servers, four warnings, all of them premature.
 *
 * Mirrors the key resolution in `findSessionForStatus`: stdio servers are
 * keyed per workspace, so a connect for any workspace counts.
 */
function isConnectingForStatus(server: McpServer, workspacePath?: string | null): boolean {
  if (connecting.has(sessionMapKey(server, workspacePath))) return true
  if (connecting.has(server.id)) return true
  if (!isStdioTransport(server.transport)) return false
  for (const key of connecting.keys()) {
    if (parseMcpStdioSessionKey(key)?.serverId === server.id) return true
  }
  return false
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
    // Report a missing launch binary from the server config rather than waiting
    // for a connect attempt, so the fix is offered before the first failure and
    // stays visible while the server sits disconnected.
    const missing =
      isStdioTransport(server.transport) && server.enabled
        ? findMissingMcpBinary(server)
        : null
    const connectingNow =
      authVisible && !session && server.enabled && isConnectingForStatus(server, workspacePath)
    return {
      id: server.id,
      name: server.name,
      enabled: server.enabled,
      connected: authVisible && Boolean(session),
      ...(connectingNow ? { connecting: true } : {}),
      toolCount: authVisible ? (session?.tools.length ?? 0) : 0,
      hasAuthToken:
        authVisible &&
        (hasMcpAuthToken(server.id) ||
          hasMcpOAuthState(server.id) ||
          hasInheritedMcpBearer(server.id)),
      hasOAuthClientSecret: hasPerServerSecret || hasSharedGoogleSecret,
      ...(staticClient ? { oauthRedirectUrl: mcpOAuthFixedRedirectUrl() } : {}),
      ...(missing
        ? {
            missingBinary: missing.binary,
            ...(missing.installUrl ? { missingBinaryInstallUrl: missing.installUrl } : {})
          }
        : {}),
      ...(error && authVisible ? { error, errorKind: classifyMcpConnectError(error) } : {}),
      ...(missing && !error
        ? { error: missingMcpBinaryMessage(missing), errorKind: 'binary' as const }
        : {})
    }
  })
}

export function mcpStatusExtras(): {
  hasGoogleMcpClientSecret: boolean
  hasGoogleMcpClient: boolean
} {
  let storedSecret = false
  try {
    storedSecret = hasGoogleMcpClientSecret()
  } catch {
    storedSecret = false
  }
  // `hasGoogleMcpClient` is what the connect wizard reads to decide whether to
  // ask the user to build a Google Cloud client. The secret itself never
  // crosses the IPC boundary — only whether a usable client exists.
  const userClient = Boolean(getSettings().googleMcpClientId?.trim()) && storedSecret
  return {
    hasGoogleMcpClientSecret: storedSecret,
    hasGoogleMcpClient: userClient || hasBundledGoogleMcpClient()
  }
}

export async function refreshMcpServers(servers: McpServer[]): Promise<McpServerStatus[]> {
  // Refresh is the natural "I just fixed it" action, so re-look-up binaries too:
  // otherwise a user who installs uv and clicks Refresh still sees it missing.
  clearMcpBinaryCache()
  // Force reconnect so dead stdio/HTTP sessions are recovered (sync alone skips existing entries).
  resetCircuitsByPrefix('mcp-connect:')
  resetCircuitsByPrefix('mcp-invoke:')
  connectConfigByKey.clear()
  for (const id of [...sessions.keys()]) {
    await disconnectMcpServer(id)
  }
  // Belt and braces: disconnect already clears the fingerprint, but Refresh
  // must reconnect even if a future teardown path forgets to.
  invalidateSyncFingerprint()
  await syncMcpServers(servers)
  return getMcpServerStatus(servers)
}

/**
 * Try again for the servers whose last connect failed, and leave every live
 * session alone. Refresh tears all of them down, which drops a tool call in
 * flight on a healthy server to retry one that is not. Binaries are looked up
 * again because installing the missing one is the usual fix.
 */
export async function retryFailedMcpServers(servers: McpServer[]): Promise<McpServerStatus[]> {
  clearMcpBinaryCache()
  await syncMcpServers(servers, { forceRetryFailures: true })
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
  const client: Client = new Client({ name: 'vyotiq', version: '1.0.0' }, {
    capabilities: {
      roots: { listChanged: false }
    },
    // Only wired by the SDK when the server advertises `tools.listChanged`.
    // Refresh ourselves rather than auto-refresh: the SDK re-reads one page.
    listChanged: {
      tools: {
        autoRefresh: false,
        onChanged: () => {
          void refreshMcpSessionTools(client)
        }
      }
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

/** Same-origin hops only (http→https, trailing slash); see createMcpFetch. */
const MAX_MCP_REDIRECTS = 3

/**
 * Fetch for remote MCP transports.
 *
 * Without it the SDK uses global fetch, so `assertPublicUrl` guarded only the
 * connect URL: every later request re-resolved DNS unchecked, and redirects
 * were followed with `requestInit.headers` — which carry the MCP bearer token —
 * to whatever host the server named. Validate each request URL, and follow only
 * same-origin redirects, so a credential can never cross an origin boundary.
 *
 * The transfer itself stays on global fetch so streamable HTTP and SSE keep
 * their streaming semantics. This re-checks the address on every request but
 * does not pin it into the connect, so it narrows the rebinding window rather
 * than closing it the way `fetchPinnedPublic` does for buffered reads.
 */
function createMcpFetch(serverId: string): FetchLike {
  return async (input, init) => {
    let target = typeof input === 'string' ? input : input.href
    for (let hop = 0; ; hop++) {
      const validated = await assertPublicUrl(target)
      const res = await fetch(validated, { ...init, redirect: 'manual' })
      if (res.status < 300 || res.status >= 400) return res
      const location = res.headers.get('location')
      if (!location) return res
      if (hop >= MAX_MCP_REDIRECTS) {
        throw new Error(`MCP server ${serverId}: too many redirects from ${validated.origin}`)
      }
      const next = new URL(location, validated)
      if (next.origin !== validated.origin) {
        throw new Error(
          `MCP server ${serverId}: refusing cross-origin redirect to ${next.origin}`
        )
      }
      target = next.href
    }
  }
}

async function createTransport(
  server: McpServer,
  opts?: { authProvider?: ReturnType<typeof createMcpOAuthProvider>; workspacePath?: string | null }
): Promise<Transport> {
  const transport = server.transport ?? 'stdio'
  if (transport === 'stdio') {
    const command = (server.command ?? '').trim()
    if (!command) throw new Error(`MCP server ${server.id}: command required for stdio`)
    // Preflight before spawning: a raw `spawn uvx ENOENT` tells the user
    // nothing actionable, and on macOS the cause is usually a GUI PATH rather
    // than a genuinely missing install.
    const missing = findMissingMcpBinary(server)
    if (missing) throw new McpMissingBinaryError(server.id, missing)
    const cwd = resolveStdioWorkspacePath(opts?.workspacePath) ?? undefined
    const env = buildMcpChildEnv(server.env)
    const args = withWorkspaceRepositoryArgs(
      withCompatibleUvxArgs(command, server.args),
      cwd ?? null
    )
    return new StdioClientTransport({
      // A located binary wins, so "Locate binary…" works without touching PATH.
      command: server.binaryPath?.trim() || command,
      args,
      env,
      ...(cwd ? { cwd } : {})
    })
  }

  const urlRaw = (server.url ?? '').trim()
  if (!urlRaw) throw new Error(`MCP server ${server.id}: url required for ${transport}`)
  // Same SSRF posture as marketplace/catalog fetchPublicResponse — remote MCP is
  // public HTTP(S) only. Local MCP uses stdio; no product exception for loopback HTTP/SSE.
  // Enforcement stays with assertPublicUrl; the egress ledger is recorded either
  // way so a run's outbound origins are answerable from one place.
  let url: URL
  try {
    url = await assertPublicUrl(urlRaw)
  } catch (err) {
    recordEgress(
      { url: urlRaw, purpose: 'mcp_remote', workspacePath: opts?.workspacePath ?? undefined },
      { allowed: false, reason: 'blocked_host', detail: `remote MCP ${server.id} refused` }
    )
    throw err
  }
  recordEgress(
    { url: url.href, purpose: 'mcp_remote', workspacePath: opts?.workspacePath ?? undefined },
    { allowed: true, reason: 'allowed' }
  )

  const fetchImpl = createMcpFetch(server.id)

  // Static Bearer takes precedence. With OAuth authProvider, do not set Authorization
  // via requestInit (SDK docs: headers + authProvider conflict).
  if (opts?.authProvider) {
    const base = headersWithoutAuthorization(server.headers)
    const requestInit = base && Object.keys(base).length > 0 ? { headers: base } : undefined
    if (transport === 'http') {
      return new StreamableHTTPClientTransport(url, {
        requestInit,
        authProvider: opts.authProvider,
        fetch: fetchImpl
      })
    }
    return new SSEClientTransport(url, {
      requestInit,
      authProvider: opts.authProvider,
      fetch: fetchImpl
    })
  }

  const headers = resolveMcpRequestHeaders(server, opts?.workspacePath)
  const requestInit = headers ? { headers } : undefined

  if (transport === 'http') {
    return new StreamableHTTPClientTransport(url, { requestInit, fetch: fetchImpl })
  }
  return new SSEClientTransport(url, { requestInit, fetch: fetchImpl })
}

/**
 * Whole-connect budget: handshake, `tools/list` and the resource/prompt
 * probes. Those three used to run after it on the SDK's per-request default,
 * so a server that stalled on `tools/list` held a sync for minutes more.
 */
const MCP_CONNECT_TIMEOUT_MS = 120_000

/**
 * The `initialize` handshake answers to the connect deadline above, not the
 * SDK's 60s request default. A stdio server launched as `npx -y pkg@latest`
 * checks the registry and, run from a pnpm checkout, walks that project's
 * whole node_modules before the package even starts: 17s idle in this repo,
 * well past 60s on a busy launch. The SDK's timeout fired first, so the
 * 120s budget never applied and the server showed "did not respond in time".
 */
const MCP_INITIALIZE_OPTIONS = { timeout: MCP_CONNECT_TIMEOUT_MS }

type PendingMcpConnection = { client: Client; transport: Transport }

/** The server said no to the credential we sent, as opposed to failing to answer. */
function isMcpAuthRejection(err: unknown): boolean {
  if (err instanceof UnauthorizedError) return true
  const message = err instanceof Error ? err.message : String(err ?? '')
  return /(^|[^0-9])(401|403)([^0-9]|$)|unauthorized|forbidden|invalid_token/i.test(message)
}

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
    await client.connect(transport, MCP_INITIALIZE_OPTIONS)
    return { client, transport }
  }

  // The app's own GitHub sign-in doubles as this server's credential. Try it
  // first, but never let it become a dead end: a token the server rejects
  // falls through to the OAuth path below instead of surfacing a 401 the user
  // has no control to act on.
  if (hasInheritedMcpBearer(server.id)) {
    const transport = await createTransport(server, { workspacePath })
    const client = createMcpClient(workspacePath)
    const connection = { client, transport }
    track(connection)
    try {
      await client.connect(transport, MCP_INITIALIZE_OPTIONS)
      return connection
    } catch (err) {
      if (!isMcpAuthRejection(err)) throw err
      logger.info('App GitHub token rejected by MCP server; falling back to OAuth', {
        scope: 'mcp',
        serverId: server.id
      })
      await closePendingConnection(connection)
    }
  }

  const interactive = opts?.interactiveOAuth === true
  // An unconnected OAuth server has nothing to try: connecting would only
  // produce a 401, and the browser flow must be user-initiated (see below).
  const oauthUnconnected =
    (isHostedAppMcpId(server.id) || mcpRequiresOAuth(server)) &&
    !hasMcpOAuthState(server.id) &&
    !hasMcpAuthToken(server.id)

  if (oauthUnconnected && !interactive) {
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
    await client.connect(transport, MCP_INITIALIZE_OPTIONS)
    return connection
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) throw err
    await closePendingConnection(connection)
    // Never open a browser the user did not ask for. A background sync that
    // hits 401 surfaces "Sign in required" in the UI instead; the browser flow
    // runs only from an explicit Connect (startMcpOAuth sets interactiveOAuth).
    if (!interactive) throw new Error(MCP_SIGN_IN_REQUIRED)
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

/** Text the MCP SDK throws when an auth server advertises no registration endpoint. */
const SDK_NO_DCR = 'does not support dynamic client registration'

/**
 * The SDK's wording is accurate but leaves the user nothing to do. Say what
 * actually fixes it: this server needs an OAuth app registered once by hand.
 */
export function friendlyMcpOAuthError(err: unknown, server: McpServer): unknown {
  if (!(err instanceof Error) || !err.message.includes(SDK_NO_DCR)) return err
  const where = server.setupUrl?.trim() ? ` Register one at ${server.setupUrl.trim()}` : ''
  return new Error(
    `${server.name} cannot register this app automatically. ` +
      `Add its OAuth client ID and secret, then connect again.${where}`
  )
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
    await client.connect(transport, MCP_INITIALIZE_OPTIONS)
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
      throw friendlyMcpOAuthError(err, server)
    }

    // Stored tokens were rejected (expired, revoked, scope change). Re-consent
    // needs a browser, so it waits for an explicit Connect rather than opening
    // one from whatever background sync happened to trigger this connect.
    if (!opts?.interactive) {
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
      await client2.connect(transport2, MCP_INITIALIZE_OPTIONS)
      await maybeLinkNativeGithubAfterMcpAuth(server.id)
      return { client: client2, transport: transport2 }
    } catch (oauthErr) {
      cancelMcpOAuthCallback(server.id)
      try {
        await client.close()
      } catch {
        // ignore
      }
      throw friendlyMcpOAuthError(oauthErr, server)
    }
  }
}

/**
 * An interactive sign-in waits on the user in a browser. It gets the callback
 * server's own window plus room for the token exchange and the reconnect —
 * the 120s budget closed that server while users were still on the consent page.
 */
const MCP_OAUTH_EXCHANGE_MARGIN_MS = 30_000

let connectTimeoutOverrideMs: number | null = null

/** Test helper — shrink the non-interactive connect budget. */
export function setMcpConnectTimeoutForTests(ms: number | null): void {
  connectTimeoutOverrideMs = ms
}

export function mcpConnectTimeoutMs(opts?: { interactiveOAuth?: boolean }): number {
  if (opts?.interactiveOAuth) return MCP_OAUTH_CALLBACK_TIMEOUT_MS + MCP_OAUTH_EXCHANGE_MARGIN_MS
  return connectTimeoutOverrideMs ?? MCP_CONNECT_TIMEOUT_MS
}

function mcpConnectTimedOut(serverId: string, timeoutMs: number): Error {
  return new Error(`MCP connect timed out after ${Math.round(timeoutMs / 1000)}s (${serverId})`)
}

/**
 * Attempts allowed when the failure says the request never reached the server.
 *
 * A remote MCP connect used to be one shot through the runtime's 10s connect
 * timeout, so a DNS blip or a half-open Wi-Fi link left the server showing
 * "Connect failed" until the user noticed and hit Refresh. Those clear in a
 * second or two. Anything still failing on the third try is not transient, and
 * the circuit breaker in `syncOne` takes over for the sustained case.
 */
const MCP_CONNECT_ATTEMPTS = 3

async function connectWithTransientRetry(
  server: McpServer,
  pending: Set<PendingMcpConnection>,
  connectAbort: AbortSignal,
  timeoutMs: number,
  workspacePath?: string | null,
  opts?: { interactiveOAuth?: boolean }
): Promise<{ client: Client; transport: Transport }> {
  const deadline = new Promise<never>((_, reject) => {
    connectAbort.addEventListener(
      'abort',
      () => reject(mcpConnectTimedOut(server.id, timeoutMs)),
      { once: true }
    )
  })
  // The race may settle on the connect side and leave this promise rejecting
  // with nobody awaiting it, which main reports as an unhandled rejection.
  deadline.catch(() => {})

  let lastError: unknown
  for (let attempt = 1; attempt <= MCP_CONNECT_ATTEMPTS; attempt++) {
    try {
      return await Promise.race([
        connectWithOptionalOAuth(
          server,
          (connection) => pending.add(connection),
          workspacePath,
          opts
        ),
        deadline
      ])
    } catch (err) {
      lastError = err
      if (
        connectAbort.aborted ||
        attempt >= MCP_CONNECT_ATTEMPTS ||
        !isRetriableMcpConnectError(err)
      ) {
        throw err
      }
      // The half-built client from this attempt still holds a socket — and for
      // stdio a live child process. Close them before dialling again, or every
      // retry leaks one for the lifetime of the app.
      const stale = [...pending]
      pending.clear()
      await Promise.all(stale.map(closePendingConnection))
      logger.info('Retrying MCP connect after a transient network failure', {
        scope: 'mcp',
        serverId: server.id,
        attempt,
        reason: formatError(err)
      })
      await sleepAbortable(httpRetryBackoffMs(attempt), connectAbort)
    }
  }
  throw lastError ?? new Error('MCP connection failed')
}

/**
 * Provider-safe definitions for a server's listed tools. Records each tool's
 * readOnlyHint as a side effect; names no provider accepts are dropped.
 */
function toolDefinitionsFromListing(
  server: Pick<McpServer, 'id' | 'name'>,
  listed: Tool[]
): { tools: ToolDefinition[]; skipped: string[] } {
  const tools: ToolDefinition[] = []
  const skipped: string[] = []
  for (const t of listed) {
    const fullName = mcpToolName(server.id, t.name)
    if (!isSupportedMcpToolName(fullName)) {
      skipped.push(t.name)
      continue
    }
    mcpReadOnlyHints.set(fullName, t.annotations?.readOnlyHint === true)
    tools.push({
      name: fullName,
      description: neutralizeUntrustedBody(
        t.description ?? `MCP tool ${t.name} (${server.name})`
      ),
      parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} }
    })
  }
  if (skipped.length > 0) {
    logger.warn('Skipped MCP tools whose names no provider will accept', {
      scope: 'mcp',
      serverId: server.id,
      tools: skipped.slice(0, 10)
    })
  }
  return { tools, skipped }
}

/**
 * Every tool a server offers. A server with only resources or prompts answers
 * `tools/list` with -32601; that is "no tools", not a failed connect — treating
 * it as one meant such a server could never connect.
 */
async function listAllTools(client: Client, signal?: AbortSignal): Promise<Tool[]> {
  try {
    return await collectMcpPages(async (cursor) => {
      const listed = await client.listTools(cursor ? { cursor } : undefined, { signal })
      return { items: listed.tools, nextCursor: listed.nextCursor }
    })
  } catch (err) {
    if (isMcpMethodNotFound(err)) return []
    throw err
  }
}

/** `notifications/tools/list_changed`: re-list and swap the session's tools in place. */
async function refreshMcpSessionTools(client: Client): Promise<void> {
  const entry = [...sessions.entries()].find(([, s]) => s.client === client)
  if (!entry) return
  const [key, session] = entry
  const server = session.server
  if (!server) return
  let listed: Tool[]
  try {
    listed = await listAllTools(client, AbortSignal.timeout(mcpConnectTimeoutMs()))
  } catch (err) {
    logger.warn('MCP tool list refresh failed', { scope: 'mcp', serverId: server.id, err: formatError(err) })
    return
  }
  // The session may have been torn down while the list was in flight.
  if (sessions.get(key) !== session) return
  for (const tool of session.tools) mcpReadOnlyHints.delete(tool.name)
  session.tools = toolDefinitionsFromListing(server, listed).tools
  rebuildToolsByNameIndex()
  invalidateSlashCommandsCache()
}

/**
 * Should a just-connected session be dropped? Compared against the view sync
 * connects from — the session map, with workspace Force on/off applied. The
 * global list alone disabled a server forced on for an open workspace, so it
 * connected and was closed on every sync. Servers absent from both lists
 * (explicit connectMcpServer / unit fixtures) keep their session.
 */
function connectedServerNoLongerWanted(
  server: McpServer,
  workspacePath?: string | null
): boolean {
  const desired = resolveMcpServersForSessionMap().find((s) => s.id === server.id)
  if (desired) {
    return mcpServerConfigKey(desired, workspacePath) !== mcpServerConfigKey(server, workspacePath)
  }
  // Known, but enabled for no open workspace: disabled mid-connect.
  return resolveEffectiveMcpServers().some((s) => s.id === server.id)
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
    const timeoutMs = mcpConnectTimeoutMs(opts)
    const connectAbort = AbortSignal.timeout(timeoutMs)
    const pending = new Set<PendingMcpConnection>()
    let connected: { client: Client; transport: Transport }
    try {
      connected = await connectWithTransientRetry(
        server,
        pending,
        connectAbort,
        timeoutMs,
        workspacePath,
        opts
      )
    } catch (err) {
      const failure = err instanceof Error ? err : new Error('MCP connection failed')
      cancelMcpOAuthCallback(server.id, failure)
      await Promise.all([...pending].map(closePendingConnection))
      throw err
    }

    const { client, transport } = connected
    let tools: ToolDefinition[]
    let skippedToolCount: number
    let resources: McpResourceSummary[]
    let prompts: McpPromptSummary[]
    try {
      // Another concurrent path may have won while we were connecting.
      if (sessions.has(key)) {
        await closePendingConnection(connected)
        return
      }
      // Listing runs under the same deadline as the handshake.
      const listed = toolDefinitionsFromListing(server, await listAllTools(client, connectAbort))
      tools = listed.tools
      skippedToolCount = listed.skipped.length
      ;({ resources, prompts } = await probeResourcesAndPrompts(client, connectAbort))
      if (connectedServerNoLongerWanted(server, workspacePath)) {
        await closePendingConnection(connected)
        return
      }
    } catch (err) {
      // Past the handshake nothing else owns this client: close it, or a
      // stdio child outlives the failed connect (one more per retry).
      await closePendingConnection(connected)
      throw connectAbort.aborted ? mcpConnectTimedOut(server.id, timeoutMs) : err
    }
    sessions.set(key, {
      client,
      transport,
      tools,
      resources,
      prompts,
      server: { id: server.id, name: server.name }
    })
    rebuildToolsByNameIndex()
    sessionConfigKeys.set(key, mcpServerConfigKey(server, workspacePath))
    connectErrors.delete(key)
    connectErrors.delete(server.id)
    // Notice a dead transport when it dies, not when the model next calls it.
    client.onclose = () => handleMcpSessionClosed(key, client)
    client.onerror = (err) => {
      logger.warn('MCP transport error', {
        scope: 'mcp',
        serverId: server.id,
        err: formatError(err)
      })
    }
    const stdioWorkspace = isStdioTransport(server.transport)
      ? resolveStdioWorkspacePath(workspacePath)
      : null
    logger.info('MCP server connected', {
      scope: 'mcp',
      serverId: server.id,
      transport: server.transport ?? 'stdio',
      // A stdio server runs once per open workspace; without the id, the
      // second workspace's connect reads as the same server reconnecting.
      ...(stdioWorkspace ? { workspaceId: workspaceIdFromPath(stdioWorkspace) } : {}),
      toolCount: tools.length,
      skippedToolCount,
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
  // Session-map view first: a server forced on for an open workspace is
  // enabled there even when the global flag is off.
  const server =
    resolveMcpServersForSessionMap().find((s) => s.id === id) ??
    resolveEffectiveMcpServers().find((s) => s.id === id)
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

/**
 * Tear a session down.
 *
 * `keepError` preserves the reason the caller just recorded. A failure-driven
 * teardown must keep it: the UI has nothing else to show, and the run loop
 * one-shot retry gates on a non-empty error, so clearing it left the server
 * disconnected with no explanation and no retry. Routine teardowns (disabled,
 * reconfigured, uninstalled) still clear it, because there is no failure.
 *
 * `fromSync` marks a teardown the running sync makes on its way to the config
 * it is about to record, so it does not count as an invalidation.
 */
async function disconnectMcpSessionByKey(
  sessionKey: string,
  opts?: { keepError?: boolean; fromSync?: boolean }
): Promise<void> {
  const session = sessions.get(sessionKey)
  if (!session) return
  // Detach first: closing fires `onclose`, which would otherwise re-enter and
  // overwrite the reason the caller just recorded with the generic one.
  session.client.onclose = undefined
  session.client.onerror = undefined
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
  if (!opts?.keepError) {
    connectErrors.delete(sessionKey)
    const parsed = parseMcpStdioSessionKey(sessionKey)
    if (parsed) connectErrors.delete(parsed.serverId)
  }
  // The server list is unchanged, so sync would skip this key on fingerprint
  // alone and never rebuild what we just removed.
  if (!opts?.fromSync) invalidateSyncFingerprint()
}

/** A session this server should have, and the workspace it is bound to (null for global remote). */
type SessionTarget = { key: string; workspacePath: string | null }

/**
 * The sessions an enabled server should hold: one per stdio workspace, one for
 * a this-workspace remote whose bound workspace is open (none while it is
 * closed), otherwise one global session.
 */
function desiredSessionTargets(server: McpServer, stdioWorkspaces: string[]): SessionTarget[] {
  if (isStdioTransport(server.transport)) {
    return stdioWorkspaces.map((wp) => ({ key: sessionMapKey(server, wp), workspacePath: wp }))
  }
  if (isThisWorkspaceMcpAuth(server)) {
    const wp = remoteSyncWorkspacePath(server, stdioWorkspaces)
    return wp ? [{ key: sessionMapKey(server, wp), workspacePath: wp }] : []
  }
  return [{ key: server.id, workspacePath: null }]
}

/** A failed session sync would retry: no session and a non-quiet error on record. */
function hasRetriableFailure(server: McpServer, key: string): boolean {
  if (sessions.has(key)) return false
  const err = connectErrors.get(key) ?? connectErrors.get(server.id)
  return Boolean(err) && !quietMcpConnectSkip(err)
}

export async function syncMcpServers(
  servers: McpServer[],
  opts?: { forceRetryFailures?: boolean }
): Promise<void> {
  const stdioWorkspaces = collectStdioWorkspacePaths()
  if (opts?.forceRetryFailures) {
    let retrying = false
    for (const server of servers) {
      if (!server.enabled) continue
      for (const { key } of desiredSessionTargets(server, stdioWorkspaces)) {
        if (!hasRetriableFailure(server, key)) continue
        retrying = true
        resetCircuit(circuitKeyMcpConnect(key))
        resetCircuit(circuitKeyMcpConnect(server.id))
        connectConfigByKey.delete(key)
        connectConfigByKey.delete(server.id)
      }
    }
    if (retrying) lastSyncedServersFp = ''
  }
  const fpParts: string[] = [stdioWorkspaces.sort().join(',')]
  for (const s of servers) {
    if (!s.enabled) {
      fpParts.push(`${s.id}:0`)
      continue
    }
    const targets = desiredSessionTargets(s, stdioWorkspaces)
    if (targets.length === 0 && !isStdioTransport(s.transport)) {
      fpParts.push(`${s.id}:bound-closed`)
    }
    for (const { workspacePath } of targets) {
      fpParts.push(
        workspacePath
          ? `${s.id}@${workspacePath}:1:${mcpServerConfigKey(s, workspacePath)}`
          : `${s.id}:1:${mcpServerConfigKey(s)}`
      )
    }
  }
  const fp = fpParts.sort().join('|')
  if (fp === lastSyncedServersFp) {
    if (lastSyncInflight) await lastSyncInflight
    return
  }
  let invalidationsAtStart = -1
  const run = syncChain.then(() => {
    invalidationsAtStart = syncInvalidations
    return syncMcpServersUnlocked(servers, stdioWorkspaces)
  })
  // Keep the chain alive even when a sync rejects so later callers still queue.
  syncChain = run.then(
    () => undefined,
    () => undefined
  )
  lastSyncInflight = run.then(
    () => {
      if (syncInvalidations === invalidationsAtStart) lastSyncedServersFp = fp
    },
    () => undefined
  )
  await run
}

/** Connects in flight at once during a sync. Each stdio server is a process spawn. */
const MCP_SYNC_CONCURRENCY = 6

/**
 * Servers with a static OAuth client bind the one fixed loopback port while
 * they connect, so two of them at once would collide with EADDRINUSE.
 */
function usesFixedOAuthPort(server: McpServer): boolean {
  if (isStdioTransport(server.transport)) return false
  try {
    return resolveMcpOAuthStaticClient(server) != null
  } catch {
    return false
  }
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
  const targets = enabled.flatMap((server) =>
    desiredSessionTargets(server, stdioWorkspaces).map((target) => ({ server, ...target }))
  )
  const neededKeys = new Set(targets.map((t) => t.key))

  for (const key of [...sessions.keys()]) {
    const parsed = parseMcpStdioSessionKey(key)
    const serverId = parsed?.serverId ?? key
    if (!enabledIds.has(serverId) || !neededKeys.has(key)) {
      await disconnectMcpSessionByKey(key, { fromSync: true })
    }
  }

  const syncOne = async (server: McpServer, workspacePath: string | null): Promise<void> => {
    const key = sessionMapKey(server, workspacePath)
    const configKey = mcpServerConfigKey(server, workspacePath)
    const connectedKey = sessionConfigKeys.get(key)
    if (sessions.has(key) && connectedKey !== configKey) {
      await disconnectMcpSessionByKey(key, { fromSync: true })
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
      // What the card will show. The thrown error itself goes to the log as
      // `err`, so the six IP addresses undici prints (or the SDK's own
      // "Request timed out") stay available for diagnosis without being the
      // thing the user is asked to read. Log fields pass an allowlist:
      // anything not on it, such as a workspace path, is dropped silently.
      const message = describeMcpConnectError(err, server)
      const code = mcpConnectErrorCode(err)
      connectErrors.set(key, message)
      recordCircuitFailure(circuitKeyMcpConnect(key), MCP_CONNECT_CIRCUIT_POLICY)
      if (quietMcpConnectSkip(message)) return
      const stdioWorkspace = isStdioTransport(server.transport)
        ? resolveStdioWorkspacePath(workspacePath)
        : null
      logger.warn('MCP connect failed', {
        scope: 'mcp',
        serverId: server.id,
        ...(stdioWorkspace ? { workspaceId: workspaceIdFromPath(stdioWorkspace) } : {}),
        code,
        kind: classifyMcpConnectError(err),
        reason: message,
        err
      })
    }
  }

  // Sessions are independent, so connect them side by side: serially, one
  // slow `npx` server held every run step that awaited this sync for the sum
  // of all connects. Fixed-port OAuth servers share one lane.
  const oauthLane = targets.filter((t) => usesFixedOAuthPort(t.server))
  const queue = targets.filter((t) => !usesFixedOAuthPort(t.server))
  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      await syncOne(next.server, next.workspacePath)
    }
  }
  await Promise.all([
    ...Array.from({ length: Math.min(MCP_SYNC_CONCURRENCY, queue.length) }, worker),
    (async () => {
      for (const t of oauthLane) await syncOne(t.server, t.workspacePath)
    })()
  ])
  // MCP tools/status feed /mcp slash availability — bust the 5s list cache.
  invalidateSlashCommandsCache()
}

/**
 * Connected tool definitions. With a `workspacePath`, only the sessions a run
 * in that workspace can actually invoke — stdio sessions are per workspace and
 * invoke never borrows another workspace's, so the unscoped union offered a
 * run tools (a git server connected elsewhere, say) that could only fail.
 */
export function listMcpToolDefinitions(workspacePath?: string | null): ToolDefinition[] {
  const scoped =
    typeof workspacePath === 'string'
      ? resolveTargetServerIds(undefined)
          .map((id) => resolveSessionForServer(id, workspacePath)?.session)
          .filter((session): session is McpSession => session != null)
      : [...sessions.values()]
  const seen = new Set<string>()
  const out: ToolDefinition[] = []
  for (const session of scoped) {
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
  const targetIds = resolveTargetServerIds(serverId, enabledIds)
  const out: McpResourceEntry[] = []
  for (const id of targetIds) {
    if (out.length >= MCP_LIST_ENTRY_CAP) break
    const resolved = resolveSessionForServer(id, workspacePath)
    if (!resolved) continue
    const session = resolved.session
    let listed: McpResourceSummary[]
    try {
      listed = (await listAllResources(session.client, signal)).map(resourceSummary)
    } catch (err) {
      if (signal?.aborted || isAbortError(err)) throw err
      listed = session.resources ?? []
    }
    for (const resource of listed.slice(0, MCP_LIST_ENTRY_CAP - out.length)) {
      out.push({ serverId: id, ...resource })
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
    const message = formatError(err)
    connectErrors.set(access.sessionKey, message)
    if (isMcpSessionFatalError(message)) {
      await disconnectMcpSessionByKey(access.sessionKey, { keepError: true })
    }
    return { ok: false, error: message }
  }
}

export async function listMcpPrompts(
  serverId?: string,
  enabledIds?: ReadonlySet<string>,
  signal?: AbortSignal,
  workspacePath?: string | null
): Promise<McpPromptEntry[]> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const targetIds = resolveTargetServerIds(serverId, enabledIds)
  const out: McpPromptEntry[] = []
  for (const id of targetIds) {
    if (out.length >= MCP_LIST_ENTRY_CAP) break
    const resolved = resolveSessionForServer(id, workspacePath)
    if (!resolved) continue
    const session = resolved.session
    let listed: McpPromptSummary[]
    try {
      listed = (await listAllPrompts(session.client, signal)).map(promptSummary)
    } catch (err) {
      if (signal?.aborted || isAbortError(err)) throw err
      listed = session.prompts ?? []
    }
    for (const prompt of listed.slice(0, MCP_LIST_ENTRY_CAP - out.length)) {
      out.push({ serverId: id, ...prompt })
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
    const message = formatError(err)
    connectErrors.set(access.sessionKey, message)
    if (isMcpSessionFatalError(message)) {
      await disconnectMcpSessionByKey(access.sessionKey, { keepError: true })
    }
    return { ok: false, error: message }
  }
}

export function getMcpToolDefinition(fullName: string): ToolDefinition | undefined {
  return toolsByName.get(fullName)
}

/** Most images one MCP result may attach; the request-wide cap is 8. */
const MCP_MAX_IMAGES_PER_RESULT = 4

/**
 * Text of an MCP tool result, with its image blocks stored in the run dir.
 *
 * Image blocks used to be JSON-stringified: ~100 KB of base64 that the 64 KB
 * text cap then cut mid-string, so the model got neither the image nor the
 * text after it (Playwright MCP's browser_take_screenshot, for one).
 */
export function mcpResultContent(
  blocks: Array<Record<string, unknown>> | undefined,
  runDir: string | undefined
): { text: string; images: ToolImageRef[]; notes: string[] } {
  const texts: string[] = []
  const images: ToolImageRef[] = []
  const notes: string[] = []
  for (const block of blocks ?? []) {
    if (block.type === 'text') {
      texts.push(typeof block.text === 'string' ? block.text : '')
      continue
    }
    if (block.type === 'image' && typeof block.data === 'string') {
      const mime = typeof block.mimeType === 'string' ? block.mimeType : 'image'
      if (!runDir) {
        notes.push(`[MCP returned an image (${mime}); no run directory to store it]`)
        continue
      }
      if (images.length >= MCP_MAX_IMAGES_PER_RESULT) {
        notes.push(`[MCP image dropped: more than ${MCP_MAX_IMAGES_PER_RESULT} images in one result]`)
        continue
      }
      const stored = storeToolImage(runDir, Buffer.from(block.data, 'base64'), { source: 'mcp' })
      if (!stored.ok) {
        notes.push(`[MCP image not attached: ${stored.reason}]`)
        continue
      }
      images.push(stored.image)
      const dims = stored.image.width ? `${stored.image.width}x${stored.image.height}, ` : ''
      notes.push(`[Image saved under run ${stored.image.artifact} (${dims}${stored.bytes} bytes)]`)
      continue
    }
    // Audio and embedded resources: text as text, base64 bodies as a summary.
    texts.push(formatMcpContentBlock(block as McpContentBlock))
  }
  return { text: texts.join('\n'), images, notes }
}

export async function invokeMcpTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  fullToolName?: string,
  enabledIds?: ReadonlySet<string>,
  workspacePath?: string | null,
  /** Run directory; image blocks are stored there and returned as images. */
  runDir?: string
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
    // `session.tools` is keyed by the prefixed name the model calls, while
    // `toolName` is the bare one the server knows. Comparing the two never
    // matched, so this validation had never actually run.
    const catalogName = mcpToolName(serverId, toolName)
    const toolDef = access.session.tools.find((tool) => tool.name === catalogName)
    const argsError = toolDef
      ? validateMcpToolArgs(catalogName, args, toolDef.parameters)
      : null
    if (argsError) {
      return { ok: false, summary, content: argsError }
    }
    const result = await session.client.callTool(
      { name: toolName, arguments: args },
      undefined,
      {
        signal,
        // The SDK default is 60s, which real work exceeds routinely (browser
        // automation, large tracker queries). Progress notifications extend
        // the window; `maxTotalTimeout` still bounds a server that streams
        // progress forever.
        timeout: MCP_INVOKE_TIMEOUT_MS,
        resetTimeoutOnProgress: true,
        maxTotalTimeout: MCP_INVOKE_MAX_TOTAL_TIMEOUT_MS
      }
    )
    const { text, images, notes } = mcpResultContent(
      result.content as Array<Record<string, unknown>>,
      runDir
    )
    const ok = result.isError !== true
    const prefix = ok ? '' : `[MCP ${fullToolName ?? toolName} error]\n`
    // Image notes are harness-authored, so they sit outside the untrusted fence.
    const body = text || (images.length ? '(image only)' : '(empty)')
    const content =
      prefix +
      wrapMcpPayload(capMcpText(body), `${serverId}/${toolName}`) +
      (notes.length ? `\n${notes.join('\n')}` : '')
    recordCircuitSuccess(circuitKeyMcpInvoke(access.sessionKey))
    return images.length ? { ok, summary, content, images } : { ok, summary, content }
  } catch (err) {
    if (signal.aborted || isAbortError(err)) {
      releaseCircuitProbe(circuitKeyMcpInvoke(access.sessionKey))
      throw new DOMException('Aborted', 'AbortError')
    }
    recordCircuitFailure(circuitKeyMcpInvoke(access.sessionKey))
    const message = formatError(err)
    connectErrors.set(access.sessionKey, message)
    if (!isMcpSessionFatalError(message)) {
      // The transport is fine, only this call failed. Keep the session so the
      // model can retry or reach for another tool.
      return {
        ok: false,
        summary,
        content: `MCP invoke failed on "${serverId}" (session kept for retry): ${message}`
      }
    }
    await disconnectMcpSessionByKey(access.sessionKey, { keepError: true })
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
    tools,
    server: { id: serverId, name: serverId }
  })
}
