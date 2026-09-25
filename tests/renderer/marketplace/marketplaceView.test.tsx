/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MarketplaceView } from '@renderer/features/marketplace'
import type {
  MarketplaceCatalogEntry,
  MarketplaceInstalledItem,
  McpServerStatus,
  PackageContents,
  Settings,
  ToolCatalogResult
} from '@shared/ipc'
import { DEFAULT_SETTINGS } from '@shared/ipc'

const baseSettings: Settings = {
  ...DEFAULT_SETTINGS,
  marketplace: { registryUrl: '', remoteInstallAcked: true },
  mcpServers: []
}

const entry = (
  partial: Partial<MarketplaceCatalogEntry> & Pick<MarketplaceCatalogEntry, 'id' | 'name' | 'kind'>
): MarketplaceCatalogEntry => ({
  version: '1.0.0',
  description: '',
  source: 'bundled',
  installable: true,
  bundledPath: partial.id,
  ...partial
})

const catalog: MarketplaceCatalogEntry[] = [
  entry({
    id: 'filesystem',
    name: 'Filesystem',
    kind: 'mcp',
    description: 'MCP filesystem',
    featuredRank: 1,
    verified: true,
    publisher: 'Model Context Protocol'
  }),
  entry({
    id: 'memory',
    name: 'Memory',
    kind: 'mcp',
    description: 'MCP memory',
    featuredRank: 2,
    publisher: 'Model Context Protocol'
  }),
  entry({ id: 'fetch', name: 'Fetch', kind: 'mcp', description: 'Fetch MCP', publisher: 'Model Context Protocol' }),
  entry({ id: 'implement-feature', name: 'Implement feature', kind: 'skill', publisher: 'Agent V' }),
  entry({ id: 'create-skill', name: 'Create skill', kind: 'skill', publisher: 'Agent V' }),
  entry({
    id: 'grill-me',
    name: 'Grill me',
    kind: 'skill',
    description: 'A relentless interview',
    publisher: 'Matt Pocock',
    // Hands off to a skill that ships as its own card, so Add pulls it in too.
    dependsOn: ['grilling', 'memory']
  }),
  entry({ id: 'devtools', name: 'Devtools', kind: 'plugin', publisher: 'Agent V' })
]

const installedItem = (
  partial: Partial<MarketplaceInstalledItem> & Pick<MarketplaceInstalledItem, 'id' | 'name'>
): MarketplaceInstalledItem => ({
  kind: 'mcp',
  version: '1.0.0',
  description: '',
  enabled: true,
  installSource: 'bundled',
  installedAt: '2026-09-24T00:00:00.000Z',
  packagePath: `${partial.id}/1.0.0`,
  ...partial
})

const memoryConnected: McpServerStatus = { id: 'memory', name: 'Memory', enabled: true, connected: true, toolCount: 2 }

const contentsById: Record<string, PackageContents> = {
  filesystem: {
    id: 'filesystem',
    kind: 'mcp',
    mcp: [
      {
        id: 'filesystem',
        name: 'Filesystem',
        path: 'vyotiq.mcp.json',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem']
      }
    ],
    skills: [],
    rules: []
  },
  devtools: {
    id: 'devtools',
    kind: 'plugin',
    mcp: [{ id: 'browser', name: 'Browser', path: 'mcp/browser.json' }],
    skills: [{ name: 'triage', description: 'Triage a failing build', path: 'skills/triage/SKILL.md' }],
    rules: [{ path: 'rules/style.md' }]
  }
}

const toolCatalog: ToolCatalogResult = {
  entries: [
    {
      name: 'mcp__memory__read_graph',
      description: 'Read the whole graph',
      source: 'mcp',
      serverId: 'memory',
      readOnlyHint: true,
      modes: ['ask', 'agent'],
      active: true
    },
    {
      name: 'mcp__memory__create_entities',
      description: 'Add entities',
      source: 'mcp',
      serverId: 'memory',
      readOnlyHint: false,
      modes: ['agent'],
      active: true
    }
  ],
  servers: [],
  codeIndexEnabled: false,
  autoModeSwitch: false,
  fingerprint: 'test'
}

type Bridge = Record<string, (...args: never[]) => unknown>
let bridge: Bridge

function ok<T>(data: T) {
  return { ok: true as const, data }
}

function installBridge(overrides: Bridge = {}): void {
  bridge = {
    marketplaceBrowse: vi.fn(async () => ok({ packages: catalog })),
    marketplaceListInstalled: vi.fn(async () =>
      ok({ schemaVersion: 1 as const, items: [installedItem({ id: 'memory', name: 'Memory' })] })
    ),
    marketplaceGetContents: vi.fn(async (id: string) =>
      contentsById[id] ? ok(contentsById[id]) : { ok: false as const, error: 'no contents' }
    ),
    marketplaceInstall: vi.fn(async () =>
      ok({ item: installedItem({ id: 'filesystem', name: 'Filesystem' }) })
    ),
    marketplaceRefreshCatalog: vi.fn(async () => ok({ schemaVersion: 1 as const, packages: catalog })),
    marketplaceAckRemoteInstall: vi.fn(async () => ok(baseSettings)),
    mcpStatus: vi.fn(async () => ok({ servers: [memoryConnected] })),
    mcpRefresh: vi.fn(async () => ok({ servers: [memoryConnected] })),
    marketplaceDetectMcp: vi.fn(async () =>
      ok({
        kind: 'stdio' as const,
        confidence: 'high' as const,
        server: {
          id: 'mcp-fetch',
          name: 'fetch',
          transport: 'stdio' as const,
          command: 'uvx',
          args: ['mcp-server-fetch'],
          enabled: true,
          source: 'manual' as const
        },
        warnings: [],
        duplicate: false
      })
    ),
    marketplaceApplyDetectedMcp: vi.fn(async () => ok({ applied: 'manual' as const, serverId: 'mcp-fetch' })),
    marketplaceScanExternalMcp: vi.fn(async () =>
      ok({ preview: [], applied: 0, skipped: 0, warnings: [], scannedPaths: [] })
    ),
    marketplaceImportExternalMcp: vi.fn(async () =>
      ok({ preview: [], applied: 0, skipped: 0, warnings: [], scannedPaths: [] })
    ),
    marketplacePickLocal: vi.fn(async () => ok(null)),
    skillsListLocal: vi.fn(async () =>
      ok({
        skills: [
          {
            id: 'skill:local:project:ship-notes',
            name: 'ship-notes',
            description: 'Project skill for shipping notes from the current workspace.',
            source: 'project' as const,
            origin: 'vyotiq' as const,
            skillPath: 'C:/tmp/.vyotiq/skills/ship-notes/SKILL.md',
            relativePath: '.vyotiq/skills/ship-notes/SKILL.md'
          }
        ]
      })
    ),
    workspaceListRules: vi.fn(async () => ok({ rules: [] })),
    toolsCatalogGet: vi.fn(async () => ok(toolCatalog)),
    getSettings: vi.fn(async () => ok(baseSettings)),
    shellOpenExternal: vi.fn(async () => ok(true as const)),
    onSkillsChanged: vi.fn(() => () => {}),
    onToolsCatalogChanged: vi.fn(() => () => {}),
    ...overrides
  }
  window.vyotiq = bridge as unknown as typeof window.vyotiq
}

const noUpdate = vi.fn(async () => ({ ok: true as const }))

function renderView(props: Partial<Parameters<typeof MarketplaceView>[0]> = {}) {
  return render(<MarketplaceView settings={baseSettings} onUpdate={noUpdate} {...props} />)
}

/** The row for one list key — keys carry paths, so compare the attribute. */
function row(key: string): HTMLElement {
  const el = Array.from(document.querySelectorAll<HTMLElement>('[data-extension-key]')).find(
    (li) => li.dataset.extensionKey === key
  )
  if (!el) throw new Error(`no row ${key}`)
  return el
}

function section(label: RegExp): HTMLElement {
  const heading = screen.getByRole('heading', { level: 2, name: label })
  const el = heading.closest('section')
  if (!el) throw new Error(`no section for ${label}`)
  return el
}

const detail = (name: string) => screen.getByRole('complementary', { name: `${name} details` })

let scrollIntoView: ReturnType<typeof vi.fn>

beforeEach(() => {
  installBridge()
  // jsdom has no layout, so it has no scrollIntoView either.
  scrollIntoView = vi.fn()
  Element.prototype.scrollIntoView = scrollIntoView as unknown as Element['scrollIntoView']
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Extensions list', () => {
  it('lists what is installed above the catalog, each package once', async () => {
    renderView()
    await screen.findByRole('heading', { level: 2, name: /^Installed/ })
    const list = screen.getByRole('tabpanel', { name: 'All' })
    // Nothing needs attention in this fixture, so there is no such section.
    expect(within(list).queryByRole('heading', { name: /^Needs you/ })).toBeNull()
    expect(within(list).getAllByRole('heading', { level: 2 }).map((h) => h.id)).toEqual([
      'extensions-installed',
      'extensions-discover'
    ])
    for (const name of ['Filesystem', 'Memory', 'Fetch', 'Grill me', 'Devtools', 'ship-notes']) {
      expect(within(list).getAllByText(name)).toHaveLength(1)
    }
    const installed = section(/^Installed/)
    expect(within(installed).getByText('Memory')).toBeTruthy()
    expect(within(installed).getByText('ship-notes')).toBeTruthy()
    const discover = section(/^Discover/)
    expect(within(discover).queryByText('Memory')).toBeNull()
    // Featured order first, then by name.
    const names = Array.from(discover.querySelectorAll('li')).map((li) => li.dataset.extensionKey)
    expect(names).toEqual([
      'mcp:filesystem',
      'skill:create-skill',
      'plugin:devtools',
      'mcp:fetch',
      'skill:grill-me',
      'skill:implement-feature'
    ])
  })

  it('puts a server waiting on a sign-in first, under Needs you', async () => {
    installBridge({
      marketplaceBrowse: vi.fn(async () =>
        ok({ packages: [...catalog, entry({ id: 'linear', name: 'Linear', kind: 'mcp', auth: 'oauth' })] })
      ),
      marketplaceListInstalled: vi.fn(async () =>
        ok({
          schemaVersion: 1 as const,
          items: [installedItem({ id: 'memory', name: 'Memory' }), installedItem({ id: 'linear', name: 'Linear' })]
        })
      ),
      mcpStatus: vi.fn(async () =>
        ok({
          servers: [memoryConnected, { id: 'linear', name: 'Linear', enabled: true, connected: false, toolCount: 0 }]
        })
      )
    })
    renderView()
    const needs = await screen.findByRole('heading', { level: 2, name: /^Needs you/ })
    expect(within(needs.closest('section')!).getByText('Needs sign-in')).toBeTruthy()
    const headings = within(screen.getByRole('tabpanel', { name: 'All' })).getAllByRole('heading', { level: 2 })
    expect(headings[0]).toBe(needs)
    // The first row is the one shown beside the list.
    expect(within(row('mcp:linear')).getByRole('button', { current: true })).toBeTruthy()
    expect(within(detail('Linear')).getByRole('button', { name: 'Sign in' })).toBeTruthy()
    expect(within(detail('Linear')).getByText('Installed, not connected — sign in to use its tools.')).toBeTruthy()
  })

  it('shows a row’s Add as pending only on the row being added', async () => {
    let finish: ((value: unknown) => void) | undefined
    installBridge({
      marketplaceListInstalled: vi.fn(async () => ok({ schemaVersion: 1 as const, items: [] })),
      marketplaceInstall: vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
    })
    renderView()
    const add = await screen.findByRole('button', { name: 'Add Filesystem' })
    fireEvent.click(add)

    await waitFor(() => expect(add.getAttribute('aria-busy')).toBe('true'))
    const others = screen.getAllByRole('button', { name: /^Add (?!Filesystem)/ })
    expect(others.length).toBeGreaterThan(2)
    for (const other of others) expect(other.getAttribute('aria-busy')).toBeNull()
    // Adding selects the row, and the detail agrees about what is being added.
    expect(within(row('mcp:filesystem')).getByRole('button', { current: true })).toBeTruthy()
    expect(within(detail('Filesystem')).getByRole('button', { name: 'Add' }).getAttribute('aria-busy')).toBe('true')

    finish?.(ok({ item: installedItem({ id: 'filesystem', name: 'Filesystem' }) }))
    await waitFor(() => expect(document.querySelectorAll('[aria-busy="true"]')).toHaveLength(0))
    expect(bridge.marketplaceInstall).toHaveBeenCalledWith({ source: 'bundled', target: 'filesystem', kind: 'mcp' })
  })

  it('shows a detail’s Add as pending only for the item being added', async () => {
    installBridge({
      marketplaceInstall: vi.fn(() => new Promise(() => {}))
    })
    renderView()
    fireEvent.click(await screen.findByText('Filesystem'))
    fireEvent.click(within(detail('Filesystem')).getByRole('button', { name: 'Add' }))
    await waitFor(() =>
      expect(within(detail('Filesystem')).getByRole('button', { name: 'Add' }).getAttribute('aria-busy')).toBe('true')
    )

    fireEvent.click(screen.getByText('Fetch'))
    const fetchAdd = within(detail('Fetch')).getByRole('button', { name: 'Add' })
    expect(fetchAdd.getAttribute('aria-busy')).toBeNull()
    // Everything waits for the one install, but only that one says so.
    expect((fetchAdd as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Add Filesystem' }).getAttribute('aria-busy')).toBe('true')
  })

  it('agrees about a live connection in the row and the detail', async () => {
    const settings: Settings = {
      ...baseSettings,
      mcpServers: [
        {
          id: 'memory-settings',
          name: 'Memory',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-memory'],
          enabled: true,
          source: 'marketplace',
          packageId: 'memory'
        }
      ]
    }
    installBridge({
      toolsCatalogGet: vi.fn(async () =>
        ok({ ...toolCatalog, entries: toolCatalog.entries.map((e) => ({ ...e, serverId: 'memory-settings' })) })
      )
    })
    renderView({ settings })
    await screen.findByRole('heading', { level: 2, name: /^Installed/ })
    expect(within(row('mcp:memory')).getByText('2 tools')).toBeTruthy()

    fireEvent.click(within(row('mcp:memory')).getByRole('button'))
    const aside = detail('Memory')
    expect(within(aside).getByText('Connected — 2 tools.')).toBeTruthy()
    // The tools the server lists, with what each declares about writing.
    expect(await within(aside).findByText('read_graph')).toBeTruthy()
    expect(within(aside).getByText('reads')).toBeTruthy()
    expect(within(aside).getByText('create_entities')).toBeTruthy()
    expect(within(aside).getByText('may write')).toBeTruthy()
    // What a local server runs, from its settings entry.
    expect(within(aside).getByText('npx -y @modelcontextprotocol/server-memory')).toBeTruthy()
    // A stdio server has nothing to sign in to.
    expect(within(aside).queryByRole('button', { name: 'Reconnect' })).toBeNull()
  })

  it('shows a server switched off as Off, even with a session still open', async () => {
    installBridge({
      marketplaceListInstalled: vi.fn(async () =>
        ok({ schemaVersion: 1 as const, items: [installedItem({ id: 'memory', name: 'Memory', enabled: false })] })
      ),
      mcpStatus: vi.fn(async () => ok({ servers: [{ ...memoryConnected, enabled: false }] }))
    })
    const settings: Settings = {
      ...baseSettings,
      mcpServers: [
        {
          id: 'memory',
          name: 'Memory',
          transport: 'stdio',
          command: 'npx',
          enabled: false,
          source: 'marketplace',
          packageId: 'memory'
        }
      ]
    }
    renderView({ settings })
    await screen.findByRole('heading', { level: 2, name: /^Installed/ })
    expect(within(row('mcp:memory')).getByText('Off')).toBeTruthy()
    expect(screen.queryByText(/2 tools/)).toBeNull()

    fireEvent.click(within(row('mcp:memory')).getByRole('button'))
    const aside = detail('Memory')
    expect(within(aside).getByText('Off in every workspace.')).toBeTruthy()
    expect(within(aside).queryByText(/Connected/)).toBeNull()
    const where = within(aside).getByRole('radiogroup', { name: 'Where it can run' })
    expect(within(where).getByRole('radio', { name: 'Off' }).getAttribute('aria-checked')).toBe('true')
  })

  it('never calls a catalog server connected before it is added', async () => {
    installBridge({
      mcpStatus: vi.fn(async () =>
        ok({
          servers: [{ id: 'filesystem', name: 'Filesystem', enabled: true, connected: true, toolCount: 6 }, memoryConnected]
        })
      )
    })
    renderView()
    await screen.findByRole('heading', { level: 2, name: /^Discover/ })
    const discover = section(/^Discover/)
    expect(discover.textContent).toContain('Filesystem')
    expect(discover.textContent).not.toMatch(/6 tools|Connected/)
    expect(within(row('mcp:filesystem')).getByRole('button', { name: 'Add Filesystem' })).toBeTruthy()

    fireEvent.click(screen.getByText('Filesystem'))
    const aside = detail('Filesystem')
    expect(within(aside).getByText('Connects on its own once added.')).toBeTruthy()
    // Before it is added the package manifest says what it would run.
    expect(await within(aside).findByText('npx -y @modelcontextprotocol/server-filesystem')).toBeTruthy()
    expect(within(aside).queryByText(/Connected/)).toBeNull()
  })

  it('marks the row whose detail is showing', async () => {
    renderView()
    await screen.findByRole('heading', { level: 2, name: /^Discover/ })
    fireEvent.click(screen.getByText('Filesystem'))
    const current = screen.getAllByRole('button', { current: true })
    expect(current).toHaveLength(1)
    expect(row('mcp:filesystem').contains(current[0]!)).toBe(true)
    expect(within(detail('Filesystem')).getByRole('heading', { name: 'Filesystem' })).toBeTruthy()
    expect(within(detail('Filesystem')).getByRole('img', { name: 'Verified' })).toBeTruthy()
  })

  it('lists what a package contains', async () => {
    renderView()
    await screen.findByRole('heading', { level: 2, name: /^Discover/ })
    fireEvent.click(screen.getByText('Devtools'))
    const aside = detail('Devtools')
    const contains = await within(aside).findByRole('heading', { name: 'Contains' })
    const list = contains.closest('section')!
    expect(list.textContent).toContain('3')
    expect(within(list).getByText('Browser')).toBeTruthy()
    expect(within(list).getByText('triage')).toBeTruthy()
    expect(within(list).getByText('rules/style.md')).toBeTruthy()
  })

  /**
   * Add on an interlinked skill installs more than the card names. Say so
   * before the click, and only for the part the user does not already have —
   * `memory` is installed in this fixture, so it must not be listed.
   */
  it('names only the missing packages an Add pulls in with it', async () => {
    renderView()
    await screen.findByRole('heading', { level: 2, name: /^Discover/ })
    fireEvent.click(screen.getByText('Grill me'))
    const note = within(detail('Grill me')).getByText(/^Also adds/)
    expect(note.textContent).toBe('Also adds grilling — it hands work to them.')
  })

  it('gives every row its full name and every tab its panel', async () => {
    renderView()
    await screen.findByRole('heading', { level: 2, name: /^Discover/ })
    expect(within(row('mcp:filesystem')).getByTitle('Filesystem')).toBeTruthy()
    expect(within(row('mcp:filesystem')).getByTitle('MCP filesystem')).toBeTruthy()

    const tablist = screen.getByRole('tablist', { name: 'Extension kinds' })
    const tabs = within(tablist).getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['All8', 'MCP servers3', 'Skills4', 'Rules0', 'Packages1'])
    const all = tabs[0]!
    expect(all.getAttribute('aria-selected')).toBe('true')
    expect(all.getAttribute('tabindex')).toBe('0')
    expect(tabs[1]!.getAttribute('tabindex')).toBe('-1')
    expect(all.getAttribute('aria-controls')).toBe('extensions-panel-all')
    expect(document.getElementById('extensions-panel-all')?.getAttribute('role')).toBe('tabpanel')

    fireEvent.keyDown(all, { key: 'ArrowRight' })
    const mcp = screen.getByRole('tab', { name: /^MCP servers/ })
    expect(mcp.getAttribute('aria-selected')).toBe('true')
    expect(mcp.getAttribute('tabindex')).toBe('0')
    const panel = screen.getByRole('tabpanel', { name: 'MCP servers' })
    expect(panel.id).toBe('extensions-panel-mcp')
    expect(within(panel).queryByText('Grill me')).toBeNull()
    expect(within(panel).getByText('Filesystem')).toBeTruthy()
  })

  it('changes the add button with the tab', async () => {
    renderView()
    await screen.findByRole('heading', { level: 2, name: /^Discover/ })
    expect(screen.getByRole('button', { name: 'Add MCP server' })).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: /^Skills/ }))
    expect(screen.getByRole('button', { name: 'New skill' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add MCP server' })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: /^Rules/ }))
    expect(screen.getByRole('button', { name: 'New rule' })).toBeTruthy()
    expect(screen.getByRole('tabpanel', { name: 'Rules' }).textContent).toContain('No rules yet.')
  })

  it('offers to clear a search that matches nothing', async () => {
    renderView()
    await screen.findByRole('heading', { level: 2, name: /^Discover/ })
    fireEvent.change(screen.getByRole('textbox', { name: 'Search extensions' }), {
      target: { value: 'not-in-catalog-xyz' }
    })
    const panel = screen.getByRole('tabpanel', { name: 'All' })
    expect(within(panel).getByText('Nothing matches “not-in-catalog-xyz”.')).toBeTruthy()
    // Counts follow the search, so no tab promises rows it will not show.
    expect(screen.getByRole('tab', { name: /^All/ }).textContent).toBe('All0')
    fireEvent.click(within(panel).getByRole('button', { name: 'Clear search' }))
    expect(await within(panel).findByText('Filesystem')).toBeTruthy()
  })

  it('focuses search on mount', async () => {
    renderView({ onClose: vi.fn() })
    const search = await screen.findByRole('textbox', { name: 'Search extensions' })
    await waitFor(() => expect(document.activeElement).toBe(search))
  })

  it('clears the search on Escape, then closes', async () => {
    const onClose = vi.fn()
    renderView({ onClose })
    const search = await screen.findByRole('textbox', { name: 'Search extensions' })
    fireEvent.change(search, { target: { value: 'filesystem' } })
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect((search as HTMLInputElement).value).toBe('')
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('Extensions opened from elsewhere', () => {
  it('selects a server named by another surface once its row exists', async () => {
    const consumed = vi.fn()
    renderView({ focusServerId: 'memory', onFocusServerConsumed: consumed })
    await waitFor(() => expect(within(row('mcp:memory')).getByRole('button', { current: true })).toBeTruthy())
    expect(consumed).toHaveBeenCalledTimes(1)
    expect(detail('Memory')).toBeTruthy()
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())
  })

  it('opens on the kind Settings asked for', async () => {
    const consumed = vi.fn()
    renderView({ focusManageTab: 'skills', onFocusManageTabConsumed: consumed })
    expect(screen.getByRole('tab', { name: /^Skills/ }).getAttribute('aria-selected')).toBe('true')
    expect(consumed).toHaveBeenCalledTimes(1)
    const panel = screen.getByRole('tabpanel', { name: 'Skills' })
    expect(await within(panel).findByText('Grill me')).toBeTruthy()
    expect(within(panel).queryByText('Filesystem')).toBeNull()
  })
})

describe('Registry and trust', () => {
  it('holds the registry, the acknowledgement and the MCP documentation link', async () => {
    renderView()
    fireEvent.click(await screen.findByRole('button', { name: 'Registry and trust' }))
    const dialog = screen.getByRole('dialog', { name: 'Registry and trust' })
    expect(within(dialog).getByRole('region', { name: 'Package registry' })).toBeTruthy()
    expect(within(dialog).getByLabelText('Registry URL')).toBeTruthy()
    expect(within(dialog).getByRole('checkbox', { name: 'Acknowledge marketplace install risk' })).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'MCP documentation' }))
    await waitFor(() => expect(bridge.shellOpenExternal).toHaveBeenCalledWith('https://modelcontextprotocol.io/'))
  })

  it('saves a new registry URL on blur and lists its packages', async () => {
    const onUpdate = vi.fn(async () => ({ ok: true as const }))
    renderView({ onUpdate })
    fireEvent.click(await screen.findByRole('button', { name: 'Registry and trust' }))
    const input = screen.getByLabelText('Registry URL')
    fireEvent.change(input, { target: { value: 'https://registry.example.com' } })
    fireEvent.blur(input)
    await waitFor(() => expect(bridge.marketplaceRefreshCatalog).toHaveBeenCalledTimes(1))
    expect(onUpdate).toHaveBeenCalledWith({
      marketplace: { registryUrl: 'https://registry.example.com', remoteInstallAcked: true }
    })
    // The refresh is announced, and the list asks main for the catalog again.
    await waitFor(() => expect(bridge.marketplaceBrowse).toHaveBeenCalledTimes(2))
  })

  it('does not save a URL that is not http(s)', async () => {
    const onUpdate = vi.fn(async () => ({ ok: true as const }))
    renderView({ onUpdate })
    fireEvent.click(await screen.findByRole('button', { name: 'Registry and trust' }))
    const input = screen.getByLabelText('Registry URL')
    fireEvent.change(input, { target: { value: 'ftp://registry.example.com' } })
    fireEvent.blur(input)
    expect((await screen.findByRole('alert')).textContent).toBe('Enter a valid http(s) URL — not saved.')
    expect(onUpdate).not.toHaveBeenCalled()
    expect(bridge.marketplaceRefreshCatalog).not.toHaveBeenCalled()
  })
})

describe('Add MCP server', () => {
  it('detects a pasted command and adds it', async () => {
    renderView()
    fireEvent.click(await screen.findByRole('button', { name: 'Add MCP server' }))
    const dialog = screen.getByRole('dialog', { name: 'Add an MCP server' })
    fireEvent.change(within(dialog).getByLabelText('Paste a URL, npm package, npx command or JSON'), {
      target: { value: 'uvx mcp-server-fetch' }
    })
    expect(await within(dialog).findByText('Detected a stdio server')).toBeTruthy()
    expect((within(dialog).getByRole('textbox', { name: 'Server command' }) as HTMLInputElement).value).toBe('uvx')
    expect((within(dialog).getByRole('textbox', { name: 'Server arguments' }) as HTMLInputElement).value).toBe(
      'mcp-server-fetch'
    )
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add and connect' }))
    await waitFor(() =>
      expect(bridge.marketplaceApplyDetectedMcp).toHaveBeenCalledWith({
        server: expect.objectContaining({ id: 'mcp-fetch', command: 'uvx', args: ['mcp-server-fetch'], enabled: true }),
        overwrite: false
      })
    )
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add an MCP server' })).toBeNull())
  })
})
