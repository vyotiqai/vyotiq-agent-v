import { BrowserWindow } from 'electron'
import { IPC } from '../../shared/channels'
import type { McpServer, ToolCatalogEntry, ToolCatalogResult } from '../../shared/ipc'
import { resolveEffectiveMcpServers } from '../marketplace/resolve'
import { mcpAuthAllowedForWorkspace } from '../../shared/mcpApps'
import { isMcpToolPermitted } from '../../shared/utils/mcpToolPolicy'
import { getSettings } from '../settings/settings'
import { findWorkspaceSettingsOverride, getWorkspaces } from '../workspace/workspaces'
import { listMcpToolDefinitions, parseMcpToolName } from './mcp'
import { BUILTIN_TOOL_NAMES, TOOL_REGISTRY } from './schemas/tools'
import { filterToolDefsForCodeIndex, isBuiltinAllowedInMode } from './tools/modePolicy'

const ALL_MODES = ['ask', 'plan', 'agent'] as const
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
}): ToolCatalogResult {
  const { autoModeSwitch, codeIndexEnabled, mcpToolDefs, servers, authAllowedServerIds } = inputs
  const serverById = new Map(servers.map((s) => [s.id, s]))
  const entries: ToolCatalogEntry[] = []

  for (const name of BUILTIN_TOOL_NAMES) {
    const registry = TOOL_REGISTRY[name]
    const modes = ALL_MODES.filter((mode) => isBuiltinAllowedInMode(mode, name, { autoModeSwitch })) as CatalogMode[]
    const active = isBuiltinAllowedInMode('agent', name, { autoModeSwitch }) && (codeIndexEnabled || name !== 'codebase_search')
    entries.push({
      name,
      description: registry?.description ?? '',
      source: 'builtin',
      modes,
      active,
      reason: active
        ? undefined
        : name === 'codebase_search'
          ? 'code-index-off'
          : 'auto-mode-switch-off'
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
    servers: servers.map((s) => ({ id: s.id, name: s.name, enabled: s.enabled, connected: false })).map((s, i) => ({
      ...s,
      connected: mcpToolDefs.some((def) => parseMcpToolName(def.name)?.serverId === servers[i]?.id)
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
export function computeToolCatalog(workspacePath?: string | null): ToolCatalogResult {
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
    authAllowedServerIds
  })
}

/** Push the live catalog to every renderer window (same pattern as skills:changed). */
export function notifyToolCatalogChanged(): void {
  const payload = computeToolCatalog()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.toolsCatalogChanged, payload)
    }
  }
}
