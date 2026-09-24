import { describe, expect, it } from 'vitest'
import type {
  LocalSkillItem,
  MarketplaceCatalogEntry,
  MarketplaceInstalledItem,
  McpServer,
  McpServerStatus,
  UserRule
} from '@shared/ipc'
import {
  buildExtensionItems,
  extensionInTab,
  extensionMatchesQuery,
  extensionSections,
  extensionStateLabel,
  extensionTabCounts,
  isNeedsState,
  mcpLaunchLine,
  whereValue,
  wherePlan,
  type ExtensionInputs,
  type ExtensionItem
} from '@renderer/features/marketplace/extensionItems'

const entry = (
  partial: Partial<MarketplaceCatalogEntry> & Pick<MarketplaceCatalogEntry, 'id' | 'kind'>
): MarketplaceCatalogEntry => ({
  name: partial.name ?? partial.id,
  version: '1.0.0',
  description: '',
  source: 'bundled',
  installable: true,
  ...partial
})

const installed = (
  partial: Partial<MarketplaceInstalledItem> & Pick<MarketplaceInstalledItem, 'id'>
): MarketplaceInstalledItem => ({
  kind: 'mcp',
  name: partial.name ?? partial.id,
  version: '1.0.0',
  description: '',
  enabled: true,
  installSource: 'bundled',
  installedAt: '2026-09-24T00:00:00.000Z',
  packagePath: `${partial.id}/1.0.0`,
  ...partial
})

const status = (partial: Partial<McpServerStatus> & Pick<McpServerStatus, 'id'>): McpServerStatus => ({
  name: partial.id,
  enabled: true,
  connected: false,
  toolCount: 0,
  ...partial
})

const server = (partial: Partial<McpServer> & Pick<McpServer, 'id'>): McpServer => ({
  name: partial.id,
  transport: 'stdio',
  command: 'npx',
  enabled: true,
  ...partial
})

const statuses = (...rows: McpServerStatus[]): Map<string, McpServerStatus> =>
  new Map(rows.map((row) => [row.id, row]))

function build(input: Partial<ExtensionInputs>): ExtensionItem[] {
  return buildExtensionItems({
    catalog: [],
    installed: [],
    servers: [],
    statusById: new Map(),
    localSkills: [],
    userRules: [],
    projectRules: [],
    ...input
  })
}

function only(items: ExtensionItem[], key: string): ExtensionItem {
  const found = items.filter((item) => item.key === key)
  expect(found).toHaveLength(1)
  return found[0]!
}

/** One installed catalog MCP, mirrored into settings the way main does it. */
function installedMcp(opts: {
  status?: Partial<McpServerStatus>
  auth?: McpServer['auth']
  enabled?: boolean
  overrides?: ExtensionInputs['overrides']
  mirrored?: boolean
}): ExtensionItem {
  const items = build({
    catalog: [entry({ id: 'srv', kind: 'mcp', ...(opts.auth ? { auth: opts.auth } : {}) })],
    installed: [installed({ id: 'srv', enabled: opts.enabled ?? true })],
    servers:
      opts.mirrored === false
        ? []
        : [
            server({
              id: 'srv',
              source: 'marketplace',
              packageId: 'srv',
              enabled: opts.enabled ?? true,
              ...(opts.auth ? { auth: opts.auth } : {})
            })
          ],
    statusById: opts.status ? statuses(status({ id: 'srv', ...opts.status })) : new Map(),
    overrides: opts.overrides ?? null
  })
  return only(items, 'mcp:srv')
}

describe('an MCP package from the catalog', () => {
  it('is Coming soon when the catalog says it cannot be installed', () => {
    const item = only(build({ catalog: [entry({ id: 'x', kind: 'mcp', installable: false })] }), 'mcp:x')
    expect(item.state).toEqual({ kind: 'soon' })
    expect(item.group).toBe('discover')
  })

  it('offers Add, never Connected, while it is not installed — whatever a status row says', () => {
    const item = only(
      build({
        catalog: [entry({ id: 'filesystem', kind: 'mcp' })],
        statusById: statuses(status({ id: 'filesystem', connected: true, toolCount: 8 }))
      }),
      'mcp:filesystem'
    )
    expect(item.state).toEqual({ kind: 'available' })
    expect(item.group).toBe('discover')
    expect(extensionStateLabel(item.state)).toBe('Add')
  })

  it('reports a live connection with its tool count', () => {
    const item = installedMcp({ status: { connected: true, toolCount: 3 } })
    expect(item.state).toEqual({ kind: 'connected', tools: 3 })
    expect(item.group).toBe('installed')
    expect(extensionStateLabel(item.state)).toBe('3 tools')
    expect(extensionStateLabel({ kind: 'connected', tools: 1 })).toBe('1 tool')
  })

  it('claims nothing before main has reported a status row', () => {
    // A missing row is not "off" and not "connecting" — nobody said either.
    const item = installedMcp({})
    expect(item.state).toEqual({ kind: 'installed' })
    expect(item.group).toBe('installed')
  })

  it('asks for a sign-in instead of reporting a failure', () => {
    const item = installedMcp({ status: { error: 'Sign in required', errorKind: 'sign-in' }, auth: 'oauth-client' })
    expect(item.state).toEqual({ kind: 'signin' })
    expect(item.group).toBe('needs')
    expect(extensionStateLabel(item.state)).toBe('Needs sign-in')
  })

  it('asks for a sign-in before the first connect has even been tried', () => {
    // Freshly installed: no session, no error yet, no stored credential.
    expect(installedMcp({ status: {}, auth: 'oauth' }).state).toEqual({ kind: 'signin' })
  })

  it('reads how it signs in from the catalog until settings catch up with the install', () => {
    expect(installedMcp({ status: {}, auth: 'token', mirrored: false }).state).toEqual({ kind: 'signin' })
  })

  it('stops asking once a credential is stored', () => {
    const item = installedMcp({ status: { hasAuthToken: true }, auth: 'oauth' })
    expect(item.state).toEqual({ kind: 'not-connected' })
    expect(item.group).toBe('needs')
  })

  it('reports a network failure as a failure', () => {
    const item = installedMcp({
      status: { error: 'Timed out reaching mcp.deepwiki.com', errorKind: 'network' }
    })
    expect(item.state).toEqual({ kind: 'failed' })
    expect(item.group).toBe('needs')
  })

  it('names the missing binary rather than a generic failure', () => {
    const item = installedMcp({
      status: { error: 'uvx was not found on PATH', errorKind: 'binary', missingBinary: 'uvx' }
    })
    expect(item.state).toEqual({ kind: 'binary', binary: 'uvx' })
    expect(item.group).toBe('needs')
    expect(extensionStateLabel(item.state)).toBe('Needs uvx')
  })

  it('says it is dialling rather than calling for attention', () => {
    // Every enabled server is unconnected for the first seconds of a launch.
    const item = installedMcp({ status: { connecting: true, error: 'the last attempt' } })
    expect(item.state).toEqual({ kind: 'connecting' })
    expect(item.group).toBe('installed')
  })

  it('is Off when switched off everywhere, even with a session left over', () => {
    const item = installedMcp({ enabled: false, status: { enabled: false, connected: true, toolCount: 2 } })
    expect(item.state).toEqual({ kind: 'off' })
    expect(item.group).toBe('installed')
  })

  it('believes main when it says the server is off in this workspace', () => {
    // The package is on and this view knows of no override, but main's status
    // is the workspace-effective one.
    const item = installedMcp({ status: { enabled: false, connected: true, toolCount: 2 } })
    expect(item.state).toEqual({ kind: 'off-here' })
  })

  it('is Off here when this workspace switches off a package that is on elsewhere', () => {
    const item = installedMcp({ overrides: { mcp: { srv: false } } })
    expect(item.state).toEqual({ kind: 'off-here' })
    expect(item.scope).toEqual({ overrideKind: 'mcp', overrideId: 'srv', globalEnabled: true, override: false })
    expect(whereValue(item.scope!)).toBe('off')
  })

  it('connects in the one workspace that switched on a package that is off elsewhere', () => {
    const item = installedMcp({
      enabled: false,
      overrides: { mcp: { srv: true } },
      status: { enabled: true, connected: true, toolCount: 4 }
    })
    expect(item.state).toEqual({ kind: 'connected', tools: 4 })
    expect(whereValue(item.scope!)).toBe('this')
  })
})

describe('servers beside the catalog', () => {
  it('links the settings mirror to its package, even under another id', () => {
    const items = build({
      catalog: [entry({ id: 'memory', kind: 'mcp' })],
      installed: [installed({ id: 'memory' })],
      servers: [server({ id: 'memory-settings', source: 'marketplace', packageId: 'memory' })],
      statusById: statuses(status({ id: 'memory-settings', connected: true, toolCount: 2 }))
    })
    expect(items.map((i) => i.key)).toEqual(['mcp:memory'])
    expect(items[0]!.server?.id).toBe('memory-settings')
    expect(items[0]!.state).toEqual({ kind: 'connected', tools: 2 })
  })

  it('lists a server added by hand as yours, with the line it runs', () => {
    const item = only(
      build({
        servers: [
          server({ id: 'mcp-fetch', name: 'fetch', command: 'uvx', args: ['mcp-server-fetch'], source: 'manual' })
        ]
      }),
      'server:mcp-fetch'
    )
    expect(item.by).toBe('You')
    expect(item.line).toBe('uvx mcp-server-fetch')
    expect(item.scope).toEqual({ overrideKind: 'mcp', overrideId: 'mcp-fetch', globalEnabled: true, override: undefined })
  })

  it('gives each server inside a package a row of its own, where its sign-in shows', () => {
    const items = build({
      installed: [installed({ id: 'devtools', kind: 'plugin', name: 'Devtools' })],
      servers: [
        server({
          id: 'plugin-devtools-a',
          name: 'A',
          transport: 'http',
          url: 'https://a.example.com/mcp',
          source: 'marketplace',
          packageId: 'devtools'
        }),
        server({ id: 'plugin-devtools-b', name: 'B', source: 'marketplace', packageId: 'devtools' })
      ],
      statusById: statuses(
        status({ id: 'plugin-devtools-a', error: 'Sign in required', errorKind: 'sign-in' }),
        status({ id: 'plugin-devtools-b', connected: true, toolCount: 1 })
      )
    })
    const a = only(items, 'server:plugin-devtools-a')
    expect(a.state).toEqual({ kind: 'signin' })
    expect(a.group).toBe('needs')
    expect(a.by).toBe('Devtools')
    expect(a.plugin?.id).toBe('devtools')
    // It follows its package, so it has no scope of its own to set.
    expect(a.scope).toBeUndefined()
    expect(a.line).toBe('https://a.example.com/mcp')
    expect(only(items, 'server:plugin-devtools-b').state).toEqual({ kind: 'connected', tools: 1 })
    // The package row itself stays a package; its servers carry their own state.
    expect(only(items, 'plugin:devtools').state).toEqual({ kind: 'installed' })
  })

  it('switches a package server off with its package, and says where', () => {
    const nested = (plugin: Partial<MarketplaceInstalledItem>, overrides: ExtensionInputs['overrides']) =>
      only(
        build({
          installed: [installed({ id: 'devtools', kind: 'plugin', ...plugin })],
          servers: [server({ id: 'plugin-devtools-a', source: 'marketplace', packageId: 'devtools' })],
          overrides
        }),
        'server:plugin-devtools-a'
      ).state
    expect(nested({ enabled: false }, null)).toEqual({ kind: 'off' })
    expect(nested({ enabled: true }, { plugins: { devtools: false } })).toEqual({ kind: 'off-here' })
    expect(nested({ enabled: true }, { mcp: { 'plugin-devtools-a': false } })).toEqual({ kind: 'off-here' })
    expect(nested({ enabled: true }, null)).toEqual({ kind: 'installed' })
  })

  it('leaves out a marketplace server whose package is gone — main drops it too', () => {
    const items = build({
      servers: [server({ id: 'plugin-gone-a', source: 'marketplace', packageId: 'gone' })]
    })
    expect(items).toEqual([])
  })

  it('says where an installed package came from when the catalog does not know it', () => {
    const item = only(build({ installed: [installed({ id: 'house', kind: 'skill', installSource: 'git' })] }), 'skill:house')
    expect(item.by).toBe('Git')
    expect(item.group).toBe('installed')
    expect(item.state).toEqual({ kind: 'installed' })
  })

  it('shows a disabled skill package as Off', () => {
    const item = only(build({ installed: [installed({ id: 'docs', kind: 'skill', enabled: false })] }), 'skill:docs')
    expect(item.state).toEqual({ kind: 'off' })
  })
})

describe('skills and rules on disk', () => {
  const skill = (partial: Partial<LocalSkillItem>): LocalSkillItem => ({
    id: 'skill:local:project:ship-notes',
    name: 'ship-notes',
    description: '',
    source: 'project',
    skillPath: 'C:/ws/.vyotiq/skills/ship-notes/SKILL.md',
    relativePath: '.vyotiq/skills/ship-notes/SKILL.md',
    ...partial
  })

  it('credits a project skill to the workspace and a personal one to you', () => {
    const items = build({
      workspaceName: 'agent-v',
      localSkills: [
        skill({}),
        skill({
          id: 'skill:local:personal:house',
          name: 'house',
          source: 'personal',
          description: 'House style',
          skillPath: 'C:/u/.vyotiq/skills/house/SKILL.md'
        })
      ]
    })
    const project = only(items, 'local:C:/ws/.vyotiq/skills/ship-notes/SKILL.md')
    expect(project.by).toBe('agent-v')
    // No description: the row says where the file is instead of nothing.
    expect(project.line).toBe('.vyotiq/skills/ship-notes/SKILL.md')
    expect(project.state).toEqual({ kind: 'local' })
    expect(only(items, 'local:C:/u/.vyotiq/skills/house/SKILL.md').by).toBe('You')
  })

  it('does not call an empty user rule applied — the prompt skips it', () => {
    const rule = (partial: Partial<UserRule>): UserRule => ({ id: 'r1', name: 'House style', body: '', enabled: true, ...partial })
    const state = (r: UserRule) => only(build({ userRules: [r] }), `user-rule:${r.id}`)
    expect(state(rule({ body: '# Prefer\nnamed exports' })).state).toEqual({ kind: 'rule', applies: 'always' })
    expect(state(rule({ body: '# Prefer\nnamed exports' })).line).toBe('Prefer')
    expect(state(rule({ body: '   ' })).state).toEqual({ kind: 'rule', applies: 'empty' })
    expect(state(rule({ body: '   ' })).line).toBe('No text yet')
    expect(extensionStateLabel({ kind: 'rule', applies: 'empty' })).toBe('Not applied')
    expect(state(rule({ body: 'x', enabled: false })).state).toEqual({ kind: 'off' })
  })

  it('takes when a project rule applies from main, and falls back to alwaysApply', () => {
    const items = build({
      projectRules: [
        { path: '.cursor/rules/typescript.mdc', description: 'TypeScript modules', alwaysApply: false, applies: 'matching' },
        { path: '.vyotiq/rules/ops.md', alwaysApply: false }
      ]
    })
    const ts = only(items, 'rule:.cursor/rules/typescript.mdc')
    expect(ts.name).toBe('typescript.mdc')
    expect(ts.by).toBe('This workspace')
    expect(ts.state).toEqual({ kind: 'rule', applies: 'matching' })
    expect(extensionStateLabel(ts.state)).toBe('Matching files')
    const ops = only(items, 'rule:.vyotiq/rules/ops.md')
    expect(ops.state).toEqual({ kind: 'rule', applies: 'request' })
    expect(ops.line).toBe('.vyotiq/rules/ops.md')
  })
})

describe('sections, tabs and search', () => {
  const items = build({
    catalog: [
      entry({ id: 'gmail', kind: 'mcp', name: 'Gmail', featuredRank: 2 }),
      entry({ id: 'github', kind: 'mcp', name: 'GitHub', featuredRank: 1 }),
      entry({ id: 'fetch', kind: 'mcp', name: 'Fetch' }),
      entry({ id: 'grill-me', kind: 'skill', name: 'Grill me', publisher: 'Matt Pocock' }),
      entry({ id: 'memory', kind: 'mcp', name: 'Memory' }),
      entry({ id: 'linear', kind: 'mcp', name: 'Linear', auth: 'oauth' })
    ],
    installed: [
      installed({ id: 'memory', name: 'Memory' }),
      installed({ id: 'linear', name: 'Linear' }),
      installed({ id: 'docs', kind: 'skill', name: 'Docs' })
    ],
    servers: [
      server({ id: 'memory', source: 'marketplace', packageId: 'memory' }),
      server({ id: 'linear', source: 'marketplace', packageId: 'linear', auth: 'oauth' })
    ],
    statusById: statuses(status({ id: 'memory', connected: true, toolCount: 9 }), status({ id: 'linear' })),
    userRules: [{ id: 'r1', name: 'Answer tersely', body: 'Be brief.', enabled: true }]
  })

  it('puts what needs you first, then what is installed, then the catalog', () => {
    const sections = extensionSections(items)
    expect(sections.map((s) => s.label)).toEqual(['Needs you', 'Installed', 'Discover'])
    expect(sections[0]!.items.map((i) => i.name)).toEqual(['Linear'])
    // Installed runs MCP, skills, rules, packages.
    expect(sections[1]!.items.map((i) => i.name)).toEqual(['Memory', 'Docs', 'Answer tersely'])
    // Discover keeps the catalog's featured order, then the rest by name.
    expect(sections[2]!.items.map((i) => i.name)).toEqual(['GitHub', 'Gmail', 'Fetch', 'Grill me'])
  })

  it('lists each package once', () => {
    const keys = items.map((i) => i.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('drops a section with nothing in it', () => {
    expect(extensionSections(items.filter((i) => i.group !== 'needs')).map((s) => s.group)).toEqual([
      'installed',
      'discover'
    ])
  })

  it('counts every kind for its tab and All', () => {
    expect(extensionTabCounts(items)).toEqual({ all: 8, mcp: 5, skills: 2, rules: 1, packages: 0 })
    const skills = items.filter((i) => extensionInTab(i, 'skills')).map((i) => i.name)
    expect(skills.sort()).toEqual(['Docs', 'Grill me'])
    expect(items.every((i) => extensionInTab(i, 'all'))).toBe(true)
  })

  it('searches the name, id, maker and line, ignoring case', () => {
    const grill = items.find((i) => i.id === 'grill-me')!
    expect(extensionMatchesQuery(grill, 'GRILL')).toBe(true)
    expect(extensionMatchesQuery(grill, 'grill-me')).toBe(true)
    expect(extensionMatchesQuery(grill, 'pocock')).toBe(true)
    expect(extensionMatchesQuery(grill, 'nothing-like-it')).toBe(false)
    expect(extensionMatchesQuery(grill, '   ')).toBe(true)
  })

  it('treats only the states with a way forward as needing you', () => {
    expect(isNeedsState({ kind: 'signin' })).toBe(true)
    expect(isNeedsState({ kind: 'binary', binary: 'uvx' })).toBe(true)
    expect(isNeedsState({ kind: 'failed' })).toBe(true)
    expect(isNeedsState({ kind: 'not-connected' })).toBe(true)
    expect(isNeedsState({ kind: 'connecting' })).toBe(false)
    expect(isNeedsState({ kind: 'off' })).toBe(false)
    expect(isNeedsState({ kind: 'available' })).toBe(false)
  })
})

describe('where it can run', () => {
  it('reads the three places from the global flag and this workspace’s override', () => {
    expect(whereValue({ globalEnabled: true, override: undefined })).toBe('all')
    expect(whereValue({ globalEnabled: true, override: true })).toBe('all')
    expect(whereValue({ globalEnabled: false, override: true })).toBe('this')
    expect(whereValue({ globalEnabled: true, override: false })).toBe('off')
    expect(whereValue({ globalEnabled: false, override: undefined })).toBe('off')
  })

  it('writes the global flag, then the override, and nothing that is already true', () => {
    const on = { globalEnabled: true, override: undefined }
    const onlyHere = { globalEnabled: false, override: true }
    const offHere = { globalEnabled: true, override: false }
    const offEverywhere = { globalEnabled: false, override: undefined }

    expect(wherePlan(on, 'all', true)).toEqual({})
    expect(wherePlan(on, 'this', true)).toEqual({ global: false, override: true })
    expect(wherePlan(on, 'off', true)).toEqual({ override: false })
    expect(wherePlan(onlyHere, 'all', true)).toEqual({ global: true, override: null })
    expect(wherePlan(offHere, 'all', true)).toEqual({ override: null })
    expect(wherePlan(offHere, 'off', true)).toEqual({})
    expect(wherePlan(offEverywhere, 'this', true)).toEqual({ override: true })
    expect(wherePlan(offEverywhere, 'off', true)).toEqual({})
    expect(wherePlan(onlyHere, 'off', true)).toEqual({ override: null })
  })

  it('only flips the global flag when there is no workspace to scope to', () => {
    expect(wherePlan({ globalEnabled: true, override: undefined }, 'off', false)).toEqual({ global: false })
    expect(wherePlan({ globalEnabled: false, override: undefined }, 'all', false)).toEqual({ global: true })
    expect(wherePlan({ globalEnabled: true, override: undefined }, 'all', false)).toEqual({})
  })
})

describe('mcpLaunchLine', () => {
  it('shows the command line of a local server and the endpoint of a remote one', () => {
    expect(mcpLaunchLine({ transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] })).toBe(
      'npx -y @modelcontextprotocol/server-memory'
    )
    expect(mcpLaunchLine({ transport: 'http', url: ' https://mcp.linear.app/mcp ' })).toBe('https://mcp.linear.app/mcp')
    // A package manifest may leave the transport out; stdio is the default.
    expect(mcpLaunchLine({ command: 'uvx', args: ['mcp-server-git'] })).toBe('uvx mcp-server-git')
  })
})
