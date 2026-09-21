import type { ToolDefinition } from '../providers/types'
import { parseMcpToolName } from '../mcp'
import { wrapPromptSection } from '../promptSections'

/**
 * How a run admits connected MCP tool schemas into the per-step wire catalog.
 *
 * `on-demand` (default): a connected server costs a name in `<mcp_servers>`
 * and nothing else until the agent asks for it. `eager`: every connected tool
 * ships in every step, which is what this harness used to do unconditionally —
 * measured at 67,020 tokens across 95 tools on a four-server install (notion
 * alone was 54,595), re-sent on every single step of every run.
 */
export type McpToolLoading = 'on-demand' | 'eager'

const EMPTY_SET: ReadonlySet<string> = new Set<string>()

export type McpCatalogSelection = {
  /** Tool defs that go on the wire this step. */
  active: ToolDefinition[]
  /** Connected, permitted defs deliberately held back (context meter reports these). */
  deferred: ToolDefinition[]
  /** Server ids with at least one active tool. */
  loadedServerIds: string[]
  /** Server ids with connected tools but nothing active. */
  deferredServerIds: string[]
}

export type McpSelectionInput = {
  /** Connected MCP defs already filtered by run-enabled servers + allow/deny policy. */
  candidates: readonly ToolDefinition[]
  loading: McpToolLoading
  /** Servers the user marked "always load" (per-server `autoLoad`). */
  autoLoadServerIds?: ReadonlySet<string>
  /** Servers this run attached via request_mcp_tools (whole-server). */
  attachedServerIds?: ReadonlySet<string>
  /** Individual full tool names this run pinned or already called. */
  pinnedToolNames?: ReadonlySet<string>
}

/**
 * Split the connected MCP tool universe into what this step sends and what it
 * holds back. Admission is per-server (autoLoad / attached) or per-tool
 * (pinned) — never "everything that happens to be connected".
 */
export function selectMcpToolDefs(input: McpSelectionInput): McpCatalogSelection {
  const { candidates, loading } = input
  const autoLoad = input.autoLoadServerIds ?? EMPTY_SET
  const attached = input.attachedServerIds ?? EMPTY_SET
  const pinned = input.pinnedToolNames ?? EMPTY_SET

  const active: ToolDefinition[] = []
  const deferred: ToolDefinition[] = []
  const loaded = new Set<string>()
  const held = new Set<string>()

  for (const def of candidates) {
    const parsed = parseMcpToolName(def.name)
    if (!parsed) continue
    const serverId = parsed.serverId
    const admit =
      loading === 'eager' ||
      autoLoad.has(serverId) ||
      attached.has(serverId) ||
      pinned.has(def.name)
    if (admit) {
      active.push(def)
      loaded.add(serverId)
    } else {
      deferred.push(def)
      held.add(serverId)
    }
  }

  return {
    active,
    deferred,
    loadedServerIds: [...loaded].sort(),
    // A server with one pinned tool is "loaded" for the directory's purposes;
    // listing it twice would tell the agent to request what it already has.
    deferredServerIds: [...held].filter((id) => !loaded.has(id)).sort()
  }
}

/** Full MCP names the composer's /mcp command and users write verbatim. */
const MCP_FULL_NAME_RE = /mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+/g

/** Most a single message may pre-load, so a long paste cannot refill the window. */
export const MCP_SEED_FROM_MESSAGE_CAP = 8

/**
 * Full MCP tool names written out in a message. The composer's `/mcp` picker
 * names the tool the user chose, so a run that starts with one should not
 * spend its first step discovering what the user already told it.
 */
export function mcpToolNamesMentionedIn(
  text: string,
  cap = MCP_SEED_FROM_MESSAGE_CAP
): string[] {
  if (!text) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(MCP_FULL_NAME_RE)) {
    const name = match[0]
    if (seen.has(name)) continue
    seen.add(name)
    out.push(name)
    if (out.length >= cap) break
  }
  return out
}

/** Per-server tool names available to this run, in catalog order. */
export function groupMcpToolNamesByServer(
  defs: readonly ToolDefinition[]
): Map<string, string[]> {
  const byServer = new Map<string, string[]>()
  for (const def of defs) {
    const parsed = parseMcpToolName(def.name)
    if (!parsed) continue
    const list = byServer.get(parsed.serverId)
    if (list) list.push(parsed.toolName)
    else byServer.set(parsed.serverId, [parsed.toolName])
  }
  return byServer
}

/** Names listed per deferred server before the "+N more" tail. */
export const MCP_DIRECTORY_NAMES_PER_SERVER = 40
/** Whole-section character ceiling (a 500-tool install must not refill the window). */
export const MCP_DIRECTORY_MAX_CHARS = 6_000

export type McpDirectoryInput = {
  /** Every connected, permitted def — active and deferred alike. */
  candidates: readonly ToolDefinition[]
  loadedServerIds: readonly string[]
  deferredServerIds: readonly string[]
  namesPerServer?: number
  maxChars?: number
}

/**
 * The `<mcp_servers>` prompt directory: what is connected, what is already in
 * the catalog, and the bare names of everything that is one request away.
 *
 * Names only — no schemas. The four-server install that cost 67k tokens of
 * wire schemas lists here in a few hundred, which is what makes deferral safe:
 * the agent can still see every tool it could ask for.
 */
export function buildMcpServersSection(input: McpDirectoryInput): string {
  const { candidates, loadedServerIds, deferredServerIds } = input
  if (candidates.length === 0) return ''
  const namesPerServer = input.namesPerServer ?? MCP_DIRECTORY_NAMES_PER_SERVER
  const maxChars = input.maxChars ?? MCP_DIRECTORY_MAX_CHARS
  const byServer = groupMcpToolNamesByServer(candidates)

  const lines: string[] = []
  if (loadedServerIds.length > 0) {
    lines.push(
      `Loaded in this step's tool catalog: ${loadedServerIds.join(', ')}. Call those tools directly.`
    )
  }
  if (deferredServerIds.length > 0) {
    lines.push(
      'Connected but NOT in the catalog — their schemas are held back to keep the window free.',
      'Load one with `request_mcp_tools` (`serverId` for the whole server, or `tools: ["mcp__<serverId>__<toolName>"]` for single tools); it lands in the next step. Calling a listed tool directly also loads it, at the cost of one step. `release_mcp_tools` hands the window back when you are done.'
    )
    let used = lines.join('\n').length
    let truncated = false
    for (const serverId of deferredServerIds) {
      const names = byServer.get(serverId) ?? []
      const shown = names.slice(0, namesPerServer)
      const more = names.length - shown.length
      const line = `- ${serverId} (${names.length}): ${shown.join(', ')}${
        more > 0 ? `, +${more} more — \`mcp_list_tools\` with serverId="${serverId}"` : ''
      }`
      if (used + line.length + 1 > maxChars) {
        truncated = true
        break
      }
      lines.push(line)
      used += line.length + 1
    }
    if (truncated) {
      lines.push('- (more servers omitted for context budget — `mcp_list_tools` lists them all)')
    }
  }
  if (lines.length === 0) return ''
  return wrapPromptSection('mcp_servers', lines.join('\n'))
}
