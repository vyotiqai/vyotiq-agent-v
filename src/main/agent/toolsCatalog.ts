import { BrowserWindow } from 'electron'
import { IPC } from '../../shared/channels'
import type { McpServer, ToolCatalogEntry, ToolCatalogResult } from '../../shared/ipc'
import { resolveEffectiveMcpServers } from '../marketplace/resolve'
import { mcpAuthAllowedForWorkspace } from '../../shared/mcpApps'
import { isMcpToolPermitted } from '../../shared/utils/mcpToolPolicy'
import { getSettings } from '../settings/settings'
import { findWorkspaceSettingsOverride, getWorkspaces } from '../workspace/workspaces'
import { listMcpToolDefinitions, parseMcpToolName } from './mcp'
import type { McpToolLoading } from './context/mcpToolLoading'
import { BUILTIN_TOOL_NAMES, TOOL_REGISTRY } from './schemas/tools'
import { agentBuiltToolDefinitions } from './agentTools/loader'
import { filterToolDefsForCodeIndex, isBuiltinAllowedInMode } from './tools/modePolicy'
import { AGENT_INTERACTION_MODES } from '../../shared/ipc'

const ALL_MODES = AGENT_INTERACTION_MODES
type CatalogMode = (typeof ALL_MODES)[number]

/** Minimal shape we need from the registry + MCP defs (structural; keeps this module light). */
type CatalogToolDef = { name: string; description?: string }

function fingerprintOf(entries: readonly ToolCatalogEntry[], codeIndexEnabled: boolean, autoModeSwitch: boolean): string {
  const basis = `${codeIndexEnabled ? 1 : 0}|${autoModeSwitch ? 1 : 0}|${entries
    .map((e) => `${e.name}=${e.active ? 1 : 0}${e.reason ? `!${e.reason}` : ''}`)
    .join(',')}`
  let hash = 5381
  for (let i = 0; i < basis.length; i++) {
    hash = ((hash << 5) + hash + basis.charCodeAt(i)) | 0
  }
  return `tc${(hash >>> 0).toString(36)}`
}

/**
 * Pure catalog builder. Mirrors the loop's per-step assembly
 * (filterToolDefsForCodeIndex(filterToolDefsForMode(agentMode, [...AGENT_TOOLS, ...mcpToolDefs], …)))
 * and reports every tool with its live active state + reason when inactive.
 */
export function buildToolCatalog(inputs: {
  autoModeSwitch: boolean
  codeIndexEnabled: boolean
  mcpToolDefs: readonly CatalogToolDef[]
  servers: readonly McpServer[]
  authAllowedServerIds: ReadonlySet<string>
  /** Tools written by `build_tool`; omitted in tests that only cover builtins/MCP. */
  agentToolDefs?: readonly CatalogToolDef[]
  /** Settings default; a server's own `autoLoad` overrides it. */
  mcpToolLoading?: McpToolLoading
}): ToolCatalogResult {
  const { autoModeSwitch, codeIndexEnabled, mcpToolDefs, servers, authAllowedServerIds } = inputs
  const eagerMcp = inputs.mcpToolLoading === 'eager'
  const serverById = new Map(servers.map((s) => [s.id, s]))
  const entries: ToolCatalogEntry[] = []

  for (const name of BUILTIN_TOOL_NAMES) {
    const registry = TOOL_REGISTRY[name]
    const modes = ALL_MODES.filter((mode) => isBuiltinAllowedInMode(mode, name, { autoModeSwitch })) as CatalogMode[]
    const active =
      isBuiltinAllowedInMode('agent', name, { autoModeSwitch }) &&
      (codeIndexEnabled || (name !== 'codebase_search' && name !== 'concept_search'))
    entries.push({
      name,
      description: registry?.description ?? '',
      source: 'builtin',
      modes,
      active,
      reason: active
        ? undefined
        : name === 'codebase_search' || name === 'concept_search'
          ? 'code-index-off'
          : 'auto-mode-switch-off'
    })
  }

  // Tools a run wrote for itself. Always active in Agent mode — nothing defers
  // them and no server can disable them — but never offered to Ask or Plan,
  // which is what isBuiltinAllowedInMode already says for an unknown name.
  for (const def of inputs.agentToolDefs ?? []) {
    entries.push({
      name: def.name,
      description: def.description ?? '',
      source: 'agent',
      modes: ['agent'],
      active: true
    })
  }

  for (const def of mcpToolDefs) {
    const parsed = parseMcpToolName(def.name)
    if (!parsed) continue
    const server = serverById.get(parsed.serverId)
    if (!server) continue
    const authOk = authAllowedServerIds.has(server.id)
    const permitted = isMcpToolPermitted(parsed.toolName, {
      allowedTools: server.allowedTools,
      deniedTools: server.deniedTools
    })
    const active = server.enabled && authOk && permitted
    entries.push({
      name: def.name,
      description: def.description ?? '',
      source: 'mcp',
      serverId: server.id,
      serverName: server.name,
      modes: ['agent'],
      active,
      reason: active
        ? undefined
        : !server.enabled
          ? 'server-disabled'
          : !authOk
            ? 'auth-not-allowed'
            : 'denied-by-policy'
    })
  }

  return {
    entries,
    servers: servers.map((s) => ({
      id: s.id,
      name: s.name,
      enabled: s.enabled,
      connected: mcpToolDefs.some((def) => parseMcpToolName(def.name)?.serverId === s.id),
      loading: eagerMcp || s.autoLoad === true ? ('every-step' as const) : ('on-demand' as const)
    })),
    codeIndexEnabled,
    autoModeSwitch,
    fingerprint: fingerprintOf(entries, codeIndexEnabled, autoModeSwitch)
  }
}

/**
 * Live snapshot scoped to a workspace (null = active workspace), computed from the
 * same sources the agent loop reads: effective MCP servers, connected sessions,
 * settings (autoModeSwitch, codeIndex) and the builtin registry.
 */
export async function computeToolCatalog(
  workspacePath?: string | null
): Promise<ToolCatalogResult> {
  const settings = getSettings()
  const workspaces = getWorkspaces()
  const workspace = workspacePath === undefined ? workspaces.activePath : workspacePath
  const overrides = workspace
    ? findWorkspaceSettingsOverride(workspaces, workspace)?.marketplaceOverrides ?? null
    : null
  const servers = resolveEffectiveMcpServers(overrides)
  const authAllowedServerIds = new Set(
    servers.filter((s) => s.enabled && mcpAuthAllowedForWorkspace(s, workspace)).map((s) => s.id)
  )
  return buildToolCatalog({
    autoModeSwitch: settings.autoModeSwitch === true,
    codeIndexEnabled: settings.codeIndex?.enabled !== false,
    mcpToolDefs: listMcpToolDefinitions(),
    servers,
    authAllowedServerIds,
    mcpToolLoading: settings.mcpToolLoading ?? 'on-demand',
    agentToolDefs: await agentBuiltToolDefinitions()
  })
}

/** Push the live catalog to every renderer window (same pattern as skills:changed). */
export function notifyToolCatalogChanged(): void {
  // Stays sync at the call site — there are fourteen of them and every one is
  // fire-and-forget. The scan it now awaits is a cached mtime sweep.
  void computeToolCatalog()
    .then((payload) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC.toolsCatalogChanged, payload)
        }
      }
    })
    .catch(() => {
      /* a catalog push that cannot be computed is not worth failing a mutation over */
    })
}
