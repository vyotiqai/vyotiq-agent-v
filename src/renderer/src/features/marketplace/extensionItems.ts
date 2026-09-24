import type {
  LocalSkillItem,
  MarketplaceCatalogEntry,
  MarketplaceInstallSource,
  MarketplaceInstalledItem,
  MarketplaceKind,
  MarketplaceOverrides,
  McpServer,
  McpServerStatus,
  UserRule
} from '@shared/ipc'
import {
  workspaceOverrideForId,
  type MarketplaceOverrideKind
} from '@shared/domain/marketplaceEnablement'

/**
 * Everything Extensions lists, as one kind of row: catalog packages, what is
 * installed from anywhere, MCP servers added by hand, local skill files and
 * rules. Pure, so the grouping and the state each row claims can be tested
 * without rendering anything.
 */

export type ExtensionTab = 'all' | 'mcp' | 'skills' | 'rules' | 'packages'
export type ExtensionKind = 'mcp' | 'skill' | 'rule' | 'package'
export type ExtensionGroup = 'needs' | 'installed' | 'discover'
export type RuleApplies = 'always' | 'matching' | 'request'

export type ProjectRuleItem = {
  path: string
  description?: string
  alwaysApply: boolean
  /** Absent from a main that predates it; `alwaysApply` is the fallback. */
  applies?: RuleApplies
}

export type ExtensionState =
  | { kind: 'signin' }
  | { kind: 'binary'; binary: string }
  | { kind: 'failed' }
  | { kind: 'not-connected' }
  | { kind: 'connecting' }
  | { kind: 'connected'; tools: number }
  /** Off in every workspace. */
  | { kind: 'off' }
  /** On elsewhere, forced off in this workspace. */
  | { kind: 'off-here' }
  /** Off elsewhere, forced on in this workspace. */
  | { kind: 'only-here' }
  | { kind: 'installed' }
  /** A skill file on disk rather than a package. */
  | { kind: 'local' }
  | { kind: 'rule'; applies: RuleApplies | 'empty' }
  | { kind: 'available' }
  | { kind: 'soon' }

/** Workspace Force on/off for one item, and the global flag it overrides. */
export type ExtensionScope = {
  overrideKind: MarketplaceOverrideKind
  overrideId: string
  globalEnabled: boolean
  /** Undefined when this workspace follows the global flag. */
  override: boolean | undefined
}

export type ExtensionItem = {
  /** Unique across every source: `mcp:github`, `server:mcp-fetch`, `local:<path>`… */
  key: string
  kind: ExtensionKind
  id: string
  name: string
  /** Who made it, or where it came from when nobody says. */
  by: string
  line: string
  group: ExtensionGroup
  state: ExtensionState
  entry?: MarketplaceCatalogEntry
  installed?: MarketplaceInstalledItem
  server?: McpServer
  status?: McpServerStatus
  /** The installed package an MCP server ships inside. */
  plugin?: MarketplaceInstalledItem
  localSkill?: LocalSkillItem
  userRule?: UserRule
  projectRule?: ProjectRuleItem
  scope?: ExtensionScope
}

export type ExtensionInputs = {
  catalog: readonly MarketplaceCatalogEntry[]
  installed: readonly MarketplaceInstalledItem[]
  /** `settings.mcpServers` — marketplace servers are mirrored there by main. */
  servers: readonly McpServer[]
  statusById: ReadonlyMap<string, McpServerStatus>
  localSkills: readonly LocalSkillItem[]
  userRules: readonly UserRule[]
  projectRules: readonly ProjectRuleItem[]
  /** The active workspace's Force on/off map. */
  overrides?: MarketplaceOverrides | null
  /** Shown as the maker of project skills and rules. */
  workspaceName?: string | null
}

const KIND_OF: Record<MarketplaceKind, ExtensionKind> = {
  mcp: 'mcp',
  skill: 'skill',
  plugin: 'package'
}

const OVERRIDE_KIND: Record<MarketplaceKind, MarketplaceOverrideKind> = {
  mcp: 'mcp',
  skill: 'skills',
  plugin: 'plugins'
}

/** A package with no catalog entry says where it came from instead of who made it. */
const SOURCE_BY: Record<MarketplaceInstallSource, string> = {
  registry: 'Registry',
  path: 'Folder',
  zip: 'Zip',
  git: 'Git',
  npm: 'npm',
  bundled: 'Bundled',
  remote: 'URL'
}

const TAB_OF: Record<ExtensionKind, Exclude<ExtensionTab, 'all'>> = {
  mcp: 'mcp',
  skill: 'skills',
  rule: 'rules',
  package: 'packages'
}

const KIND_ORDER: Record<ExtensionKind, number> = { mcp: 0, skill: 1, rule: 2, package: 3 }

/** Auth kinds that leave a server unusable until something is stored for it. */
const CREDENTIAL_AUTH = new Set(['oauth', 'oauth-client', 'token'])

export function isNeedsState(state: ExtensionState): boolean {
  return (
    state.kind === 'signin' ||
    state.kind === 'binary' ||
    state.kind === 'failed' ||
    state.kind === 'not-connected'
  )
}

function enablementState(globalEnabled: boolean, override: boolean | undefined): ExtensionState {
  if (override === true && !globalEnabled) return { kind: 'only-here' }
  if (override === false && globalEnabled) return { kind: 'off-here' }
  return (override ?? globalEnabled) ? { kind: 'installed' } : { kind: 'off' }
}

/**
 * What an enabled server's status row says. Before main has reported one the
 * server is only known to be installed — a guess at "connecting" would be a
 * claim nobody made.
 */
export function mcpConnectionState(
  server: Pick<McpServer, 'auth'> | undefined,
  status: McpServerStatus | undefined
): ExtensionState {
  if (!status) return { kind: 'installed' }
  if (status.connected) return { kind: 'connected', tools: status.toolCount }
  if (status.connecting) return { kind: 'connecting' }
  if (status.errorKind === 'sign-in') return { kind: 'signin' }
  if (status.missingBinary) return { kind: 'binary', binary: status.missingBinary }
  if (status.error) return { kind: 'failed' }
  if (server?.auth && CREDENTIAL_AUTH.has(server.auth) && !status.hasAuthToken) {
    return { kind: 'signin' }
  }
  return { kind: 'not-connected' }
}

/**
 * Main's status row carries the workspace-effective flag, so when there is one
 * it outranks this view's copy of the overrides — and a session still open
 * after a switch-off never reads as connected.
 */
function mcpScopedState(
  scope: ExtensionScope,
  server: Pick<McpServer, 'auth'> | undefined,
  status: McpServerStatus | undefined
): ExtensionState {
  const on = status ? status.enabled : (scope.override ?? scope.globalEnabled)
  if (!on) return scope.globalEnabled ? { kind: 'off-here' } : { kind: 'off' }
  return mcpConnectionState(server, status)
}

/** How a server starts — a settings entry, or a package manifest's, which may omit the transport. */
export type McpLaunch = Partial<Pick<McpServer, 'transport' | 'command' | 'args' | 'url'>>

/** The command line a stdio server runs, or the endpoint a remote one calls. */
export function mcpLaunchLine(server: McpLaunch): string {
  if ((server.transport ?? 'stdio') === 'stdio') {
    return [server.command ?? '', ...(server.args ?? [])].join(' ').trim()
  }
  return (server.url ?? '').trim()
}

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((l) => l.replace(/^#+\s*/, '').trim())
      .find(Boolean) ?? ''
  )
}

export function buildExtensionItems(input: ExtensionInputs): ExtensionItem[] {
  const { catalog, installed, servers, statusById, overrides } = input
  const workspaceName = input.workspaceName?.trim() || 'This workspace'
  const out: ExtensionItem[] = []
  const catalogIds = new Set(catalog.map((e) => e.id))
  const installedById = new Map(installed.map((i) => [i.id, i]))
  const pluginsById = new Map(installed.filter((i) => i.kind === 'plugin').map((i) => [i.id, i]))
  const linkedServerIds = new Set<string>()

  const fromPackage = (
    entry: MarketplaceCatalogEntry | undefined,
    item: MarketplaceInstalledItem | undefined
  ): ExtensionItem | null => {
    const source = entry ?? item
    if (!source) return null
    const base = {
      key: `${source.kind}:${source.id}`,
      kind: KIND_OF[source.kind],
      id: source.id,
      name: entry?.name ?? item?.name ?? source.id,
      by: entry?.publisher ?? (item ? SOURCE_BY[item.installSource] : 'Registry'),
      line: entry?.description || item?.description || '',
      entry,
      installed: item
    }
    if (!item) {
      return {
        ...base,
        group: 'discover',
        state: entry?.installable === false ? { kind: 'soon' } : { kind: 'available' }
      }
    }
    const overrideKind = OVERRIDE_KIND[item.kind]
    const scope: ExtensionScope = {
      overrideKind,
      overrideId: item.id,
      globalEnabled: item.enabled,
      override: workspaceOverrideForId(overrides, overrideKind, item.id)
    }
    if (item.kind !== 'mcp') {
      return {
        ...base,
        group: 'installed',
        state: enablementState(scope.globalEnabled, scope.override),
        scope
      }
    }
    // Main mirrors every installed server into settings, keyed by the
    // manifest id — which need not be the package id.
    const server = servers.find(
      (s) => s.source === 'marketplace' && (s.packageId === item.id || s.id === item.id)
    )
    if (server) linkedServerIds.add(server.id)
    const status = statusById.get(server?.id ?? item.id)
    // Until settings catch up with an install, the catalog says how it signs in.
    const state = mcpScopedState(scope, { auth: server?.auth ?? entry?.auth }, status)
    return {
      ...base,
      group: isNeedsState(state) ? 'needs' : 'installed',
      state,
      scope,
      ...(server ? { server } : {}),
      ...(status ? { status } : {})
    }
  }

  for (const entry of catalog) {
    const item = fromPackage(entry, installedById.get(entry.id))
    if (item) out.push(item)
  }
  for (const installedItem of installed) {
    if (catalogIds.has(installedItem.id)) continue
    const item = fromPackage(undefined, installedItem)
    if (item) out.push(item)
  }

  for (const server of servers) {
    if (linkedServerIds.has(server.id)) continue
    const status = statusById.get(server.id)
    if (server.source === 'marketplace') {
      // A server shipped inside a package. Main drops any other marketplace
      // entry when it resolves servers, so listing it would show a server the
      // agent cannot use.
      const plugin = server.packageId ? pluginsById.get(server.packageId) : undefined
      if (!plugin) continue
      const pluginOn = workspaceOverrideForId(overrides, 'plugins', plugin.id) ?? plugin.enabled
      const serverOverride = workspaceOverrideForId(overrides, 'mcp', server.id)
      const on = status ? status.enabled : pluginOn && serverOverride !== false
      // Off everywhere only when its package is; anything else switched it off here.
      const state: ExtensionState = on
        ? mcpConnectionState(server, status)
        : !pluginOn && !plugin.enabled
          ? { kind: 'off' }
          : { kind: 'off-here' }
      out.push({
        key: `server:${server.id}`,
        kind: 'mcp',
        id: server.id,
        name: server.name,
        by: plugin.name,
        line: mcpLaunchLine(server),
        group: isNeedsState(state) ? 'needs' : 'installed',
        state,
        server,
        plugin,
        ...(status ? { status } : {})
      })
      continue
    }
    const scope: ExtensionScope = {
      overrideKind: 'mcp',
      overrideId: server.id,
      globalEnabled: server.enabled,
      override: workspaceOverrideForId(overrides, 'mcp', server.id)
    }
    const state = mcpScopedState(scope, server, status)
    out.push({
      key: `server:${server.id}`,
      kind: 'mcp',
      id: server.id,
      name: server.name,
      by: 'You',
      line: mcpLaunchLine(server),
      group: isNeedsState(state) ? 'needs' : 'installed',
      state,
      server,
      scope,
      ...(status ? { status } : {})
    })
  }

  for (const skill of input.localSkills) {
    out.push({
      key: `local:${skill.skillPath}`,
      kind: 'skill',
      id: skill.id,
      name: skill.name,
      by: skill.source === 'personal' ? 'You' : workspaceName,
      line: skill.description || skill.relativePath,
      group: 'installed',
      state: { kind: 'local' },
      localSkill: skill
    })
  }

  for (const rule of input.userRules) {
    const text = rule.body.trim()
    out.push({
      key: `user-rule:${rule.id}`,
      kind: 'rule',
      id: rule.id,
      name: rule.name,
      by: 'You',
      line: firstLine(text) || 'No text yet',
      group: 'installed',
      // An enabled rule with no text is skipped when the prompt is built.
      state: !rule.enabled
        ? { kind: 'off' }
        : { kind: 'rule', applies: text ? 'always' : 'empty' },
      userRule: rule
    })
  }

  for (const rule of input.projectRules) {
    out.push({
      key: `rule:${rule.path}`,
      kind: 'rule',
      id: rule.path,
      name: rule.path.split('/').pop() || rule.path,
      by: workspaceName,
      line: rule.description || rule.path,
      group: 'installed',
      state: { kind: 'rule', applies: rule.applies ?? (rule.alwaysApply ? 'always' : 'request') },
      projectRule: rule
    })
  }

  return out
}

export function extensionMatchesQuery(item: ExtensionItem, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [item.name, item.id, item.by, item.line].some((text) => text.toLowerCase().includes(q))
}

export function extensionTabCounts(items: readonly ExtensionItem[]): Record<ExtensionTab, number> {
  const counts: Record<ExtensionTab, number> = { all: items.length, mcp: 0, skills: 0, rules: 0, packages: 0 }
  for (const item of items) counts[TAB_OF[item.kind]] += 1
  return counts
}

export function extensionInTab(item: ExtensionItem, tab: ExtensionTab): boolean {
  return tab === 'all' || TAB_OF[item.kind] === tab
}

export type ExtensionSection = { group: ExtensionGroup; label: string; items: ExtensionItem[] }

const byName = (a: ExtensionItem, b: ExtensionItem): number =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })

const rank = (item: ExtensionItem): number => item.entry?.featuredRank ?? Number.MAX_SAFE_INTEGER

/**
 * Needs you, Installed, Discover — empty sections dropped. Installed runs MCP,
 * skills, rules, packages; Discover keeps the catalog's featured order.
 */
export function extensionSections(items: readonly ExtensionItem[]): ExtensionSection[] {
  const needs = items.filter((i) => i.group === 'needs').sort(byName)
  const installed = items
    .filter((i) => i.group === 'installed')
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || byName(a, b))
  const discover = items
    .filter((i) => i.group === 'discover')
    .sort((a, b) => rank(a) - rank(b) || byName(a, b))
  const sections: ExtensionSection[] = [
    { group: 'needs', label: 'Needs you', items: needs },
    { group: 'installed', label: 'Installed', items: installed },
    { group: 'discover', label: 'Discover', items: discover }
  ]
  return sections.filter((s) => s.items.length > 0)
}

export function extensionKindLabel(kind: ExtensionKind, long = false): string {
  switch (kind) {
    case 'mcp':
      return long ? 'MCP server' : 'MCP'
    case 'skill':
      return 'Skill'
    case 'rule':
      return 'Rule'
    case 'package':
      return 'Package'
  }
}

export function extensionStateLabel(state: ExtensionState): string {
  switch (state.kind) {
    case 'signin':
      return 'Needs sign-in'
    case 'binary':
      return `Needs ${state.binary}`
    case 'failed':
      return 'Connection failed'
    case 'not-connected':
      return 'Not connected'
    case 'connecting':
      return 'Connecting…'
    case 'connected':
      return `${state.tools} tool${state.tools === 1 ? '' : 's'}`
    case 'off':
      return 'Off'
    case 'off-here':
      return 'Off here'
    case 'only-here':
      return 'Only here'
    case 'installed':
      return 'Installed'
    case 'local':
      return 'Local'
    case 'rule':
      return state.applies === 'always'
        ? 'Always applied'
        : state.applies === 'matching'
          ? 'Matching files'
          : state.applies === 'request'
            ? 'On request'
            : 'Not applied'
    case 'available':
      return 'Add'
    case 'soon':
      return 'Coming soon'
  }
}

/* ─── Where it can run ─────────────────────────────────────────────────── */

export type WhereValue = 'all' | 'this' | 'off'

export function whereValue(scope: Pick<ExtensionScope, 'globalEnabled' | 'override'>): WhereValue {
  if (scope.override === false) return 'off'
  if (scope.override === true) return scope.globalEnabled ? 'all' : 'this'
  return scope.globalEnabled ? 'all' : 'off'
}

/**
 * The writes that make `next` true, applied in order: the global flag, then
 * this workspace's override (`null` clears it). Empty when nothing changes.
 */
export function wherePlan(
  scope: Pick<ExtensionScope, 'globalEnabled' | 'override'>,
  next: WhereValue,
  hasWorkspace: boolean
): { global?: boolean; override?: boolean | null } {
  if (!hasWorkspace) {
    const on = next !== 'off'
    return on === scope.globalEnabled ? {} : { global: on }
  }
  switch (next) {
    case 'all':
      return {
        ...(scope.globalEnabled ? {} : { global: true }),
        ...(scope.override === undefined ? {} : { override: null })
      }
    case 'this':
      return {
        ...(scope.globalEnabled ? { global: false } : {}),
        ...(scope.override === true ? {} : { override: true })
      }
    case 'off':
      // Off everywhere already means off here; only an item that is on
      // elsewhere needs this workspace to say otherwise.
      if (scope.globalEnabled) return scope.override === false ? {} : { override: false }
      return scope.override === undefined ? {} : { override: null }
  }
}
