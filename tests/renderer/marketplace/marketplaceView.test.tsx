/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MarketplaceView } from '@renderer/features/marketplace'
import type { Settings } from '@shared/ipc'
import { DEFAULT_SETTINGS } from '@shared/ipc'

afterEach(() => {
  cleanup()
})

const baseSettings: Settings = {
  ...DEFAULT_SETTINGS,
  marketplace: { registryUrl: '', remoteInstallAcked: true },
  mcpServers: []
}

const catalogPackages = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    version: '1.0.0',
    description: 'MCP filesystem',
    kind: 'mcp' as const,
    source: 'bundled' as const,
    sections: ['featured'] as const,
    category: 'infrastructure',
    featuredRank: 1,
    verified: true,
    publisher: 'Model Context Protocol',
    installable: true,
    bundledPath: 'filesystem'
  },
  {
    id: 'memory',
    name: 'Memory',
    version: '1.0.0',
    description: 'MCP memory',
    kind: 'mcp' as const,
    source: 'bundled' as const,
    sections: ['featured'] as const,
    category: 'infrastructure',
    featuredRank: 2,
    verified: true,
    publisher: 'Model Context Protocol',
    installable: true,
    bundledPath: 'memory'
  },
  {
    id: 'implement-feature',
    name: 'Implement feature',
    version: '1.0.0',
    description: 'Feature implementation skill',
    kind: 'skill' as const,
    source: 'bundled' as const,
    category: 'skills',
    verified: true,
    publisher: 'Agent V',
    installable: true,
    bundledPath: 'implement-feature'
  },
  {
    id: 'fetch',
    name: 'Fetch',
    version: '1.0.0',
    description: 'Fetch MCP',
    kind: 'mcp' as const,
    source: 'bundled' as const,
    category: 'infrastructure',
    verified: true,
    publisher: 'Model Context Protocol',
    installable: true,
    bundledPath: 'fetch'
  },
  {
    id: 'create-skill',
    name: 'Create skill',
    version: '1.0.0',
    description: 'Create skill workflow',
    kind: 'skill' as const,
    source: 'bundled' as const,
    category: 'skills',
    verified: true,
    publisher: 'Agent V',
    installable: true,
    bundledPath: 'create-skill'
  },
  {
    id: 'grill-me',
    name: 'Grill me',
    version: '1.0.0',
    description: 'A relentless interview',
    kind: 'skill' as const,
    source: 'bundled' as const,
    category: 'skills',
    publisher: 'Matt Pocock',
    installable: true,
    bundledPath: 'grill-me',
    // Hands off to a skill that ships as its own card, so Add pulls it in too.
    dependsOn: ['grilling', 'memory']
  }
]

describe('MarketplaceView', () => {
  beforeEach(() => {
    window.vyotiq = {
      marketplaceBrowse: vi.fn(async (opts?: { q?: string; kind?: string }) => {
        const q = opts?.q?.trim().toLowerCase()
        let packages = catalogPackages
        if (opts?.kind) packages = packages.filter((p) => p.kind === opts.kind)
        if (q) {
          packages = packages.filter(
            (p) =>
              p.id.toLowerCase().includes(q) ||
              p.name.toLowerCase().includes(q) ||
              p.description.toLowerCase().includes(q)
          )
        }
        return { ok: true as const, data: { packages } }
      }),
      marketplaceListInstalled: vi.fn(async () => ({
        ok: true as const,
        data: {
          schemaVersion: 1 as const,
          items: [
            {
              id: 'memory',
              kind: 'mcp' as const,
              name: 'Memory',
              version: '1.0.0',
              description: '',
              enabled: true,
              installSource: 'bundled' as const,
              installedAt: new Date().toISOString(),
              packagePath: 'memory/1.0.0'
            }
          ]
        }
      })),
      marketplaceGetContents: vi.fn(async () => ({
        ok: true as const,
        data: {
          id: 'filesystem',
          kind: 'mcp' as const,
          mcp: [{ id: 'filesystem', name: 'Filesystem', path: 'vyotiq.mcp.json' }],
          skills: [],
          rules: []
        }
      })),
      marketplaceInstall: vi.fn(async () => ({
        ok: true as const,
        data: {
          item: {
            id: 'filesystem',
            kind: 'mcp' as const,
            name: 'Filesystem',
            version: '1.0.0',
            description: '',
            enabled: true,
            installSource: 'bundled' as const,
            installedAt: new Date().toISOString(),
            packagePath: 'filesystem/1.0.0'
          }
        }
      })),
      mcpStatus: vi.fn(async () => ({
        ok: true as const,
        data: {
          servers: [
            {
              id: 'memory',
              name: 'Memory',
              enabled: true,
              connected: true,
              toolCount: 2
            }
          ]
        }
      })),
      mcpRefresh: vi.fn(async () => ({
        ok: true as const,
        data: {
          servers: [
            {
              id: 'memory',
              name: 'Memory',
              enabled: true,
              connected: true,
              toolCount: 2
            }
          ]
        }
      })),
      marketplaceDetectMcp: vi.fn(async () => ({
        ok: true as const,
        data: {
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
        }
      })),
      marketplaceApplyDetectedMcp: vi.fn(async () => ({
        ok: true as const,
        data: { applied: 'manual' as const, serverId: 'mcp-fetch' }
      })),
      marketplaceScanExternalMcp: vi.fn(async () => ({
        ok: true as const,
        data: {
          preview: [],
          applied: 0,
          skipped: 0,
          warnings: [],
          scannedPaths: []
        }
      })),
      marketplaceImportExternalMcp: vi.fn(async () => ({
        ok: true as const,
        data: {
          preview: [],
          applied: 0,
          skipped: 0,
          warnings: [],
          scannedPaths: []
        }
      })),
      marketplacePickLocal: vi.fn(async () => ({ ok: true as const, data: null })),
      skillsListLocal: vi.fn(async () => ({
        ok: true as const,
        data: {
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
        }
      })),
      skillsOpenLocal: vi.fn(async () => ({ ok: true as const, data: true as const })),
      skillsReadLocal: vi.fn(async () => ({
        ok: true as const,
        data: {
          skillPath: 'C:/tmp/.vyotiq/skills/ship-notes/SKILL.md',
          content: '---\nname: ship-notes\ndescription: Project skill for shipping notes from the current workspace.\n---\n\n# Ship notes\n',
          name: 'ship-notes',
          description: 'Project skill for shipping notes from the current workspace.',
          body: '# Ship notes\n'
        }
      })),
      skillsWriteLocal: vi.fn(async () => ({
        ok: true as const,
        data: {
          skillPath: 'C:/tmp/.vyotiq/skills/ship-notes/SKILL.md',
          relativePath: '.vyotiq/skills/ship-notes/SKILL.md',
          name: 'ship-notes'
        }
      })),
      skillsDeleteLocal: vi.fn(async () => ({ ok: true as const, data: true as const })),
      slashCommandsCreateSkill: vi.fn(async () => ({
        ok: true as const,
        data: {
          path: 'C:/tmp/.vyotiq/skills/release-notes/SKILL.md',
          relativePath: '.vyotiq/skills/release-notes/SKILL.md',
          name: 'release-notes',
          source: 'project' as const
        }
      })),
      slashCommandsCreateRule: vi.fn(async () => ({
        ok: true as const,
        data: {
          path: 'C:/tmp/.vyotiq/rules/release-notes.md',
          relativePath: '.vyotiq/rules/release-notes.md'
        }
      })),
      workspaceListRules: vi.fn(async () => ({
        ok: true as const,
        data: { rules: [] as Array<{ path: string; alwaysApply: boolean }> }
      })),
      workspaceFileRead: vi.fn(async () => ({
        ok: false as const,
        error: 'not used'
      })),
      workspaceFileSave: vi.fn(async () => ({
        ok: false as const,
        error: 'not used'
      })),
      workspaceFileDelete: vi.fn(async () => ({
        ok: false as const,
        error: 'not used'
      })),
      workspaceFileReveal: vi.fn(async () => ({ ok: true as const, data: true as const })),
      shellOpenExternal: vi.fn(async () => ({ ok: true as const, data: true as const })),
      onSkillsChanged: vi.fn(() => () => {})
    }
  })

  it('renders Featured without Discover and lists each package once', async () => {
    render(
      <MarketplaceView settings={baseSettings} onUpdate={vi.fn(async () => ({ ok: true as const }))} />
    )
    expect(await screen.findByRole('heading', { name: /^Installed$/i })).toBeTruthy()
    expect(await screen.findByRole('heading', { name: /^Featured$/i })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: /^Discover$/i })).toBeNull()
    expect(screen.getAllByText('Filesystem').length).toBe(1)
    expect(screen.getAllByText('Memory').length).toBe(1)
    expect(screen.getAllByText('Implement feature').length).toBe(1)
    expect(screen.getByRole('heading', { name: /^Skills$/i })).toBeTruthy()
    expect(screen.getByRole('heading', { name: /^Infrastructure$/i })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: /^Plugins$/i })).toBeNull()
    expect(screen.getByText('MCP servers, skills, and packages for the agent.')).toBeTruthy()
    expect(screen.getByPlaceholderText('Search packages, skills, MCPs…')).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Packages' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'Plugins' })).toBeNull()
    expect(screen.getByText('Fetch')).toBeTruthy()
    expect(screen.getByText('Create skill')).toBeTruthy()
    // Installed packages sit in Installed, not Featured / categories
    const installedSection = screen.getByRole('heading', { name: /^Installed$/i }).closest('section')
    expect(installedSection?.textContent).toContain('Memory')
    const featured = screen.getByRole('heading', { name: /^Featured$/i }).closest('section')
    expect(featured?.textContent).toContain('Filesystem')
    expect(featured?.textContent).not.toContain('Memory')
    const infra = screen.getByRole('heading', { name: /^Infrastructure$/i }).closest('section')
    expect(infra?.textContent).toContain('Fetch')
    expect(infra?.textContent).not.toContain('Filesystem')
    expect(infra?.textContent).not.toContain('Memory')
    expect(screen.queryByRole('button', { name: /^Coming soon$/i })).toBeNull()
  })

  it('shows Installing… only on the Featured card being installed', async () => {
    let resolveInstall: ((value: unknown) => void) | undefined
    window.vyotiq.marketplaceListInstalled = vi.fn(async () => ({
      ok: true as const,
      data: { schemaVersion: 1 as const, items: [] }
    }))
    // @ts-expect-error test bridge
    window.vyotiq.marketplaceInstall = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveInstall = resolve
        })
    )

    render(
      <MarketplaceView settings={baseSettings} onUpdate={vi.fn(async () => ({ ok: true as const }))} />
    )
    await screen.findByRole('heading', { name: /^Featured$/i })

    const featured = screen.getByRole('heading', { name: /^Featured$/i }).closest('section')
    expect(featured).toBeTruthy()
    const addButtons = within(featured!).getAllByRole('button', { name: /^Add$/i })
    expect(addButtons.length).toBeGreaterThanOrEqual(2)

    fireEvent.click(addButtons[0]!)

    await waitFor(() => {
      expect(within(featured!).getAllByRole('button', { name: /^Installing/i }).length).toBe(1)
    })
    expect(within(featured!).getAllByRole('button', { name: /^Add$/i }).length).toBe(
      addButtons.length - 1
    )

    resolveInstall?.({
      ok: true,
      data: {
        item: {
          id: 'filesystem',
          kind: 'mcp',
          name: 'Filesystem',
          version: '1.0.0',
          description: '',
          enabled: true,
          installSource: 'bundled',
          installedAt: new Date().toISOString(),
          packagePath: 'filesystem/1.0.0'
        }
      }
    })
    await waitFor(() => {
      expect(within(featured!).queryByRole('button', { name: /^Installing/i })).toBeNull()
    })
  })

  it('shows Installing… only on the detail being installed, not on other details', async () => {
    let resolveInstall: ((value: unknown) => void) | undefined
    // @ts-expect-error test bridge
    window.vyotiq.marketplaceInstall = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveInstall = resolve
        })
    )
    render(
      <MarketplaceView settings={baseSettings} onUpdate={vi.fn(async () => ({ ok: true as const }))} />
    )
    await screen.findByRole('heading', { name: /^Featured$/i })
    fireEvent.click(screen.getByText('Filesystem'))
    expect(await screen.findByRole('button', { name: /^Add to Agent V$/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Add to Agent V$/i }))
    expect(await screen.findByRole('button', { name: /^Installing/i })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /^Marketplace$/i }))
    await screen.findByRole('heading', { name: /^Featured$/i })
    fireEvent.click(screen.getByText('Fetch'))
    expect(await screen.findByRole('button', { name: /^Add to Agent V$/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Installing/i })).toBeNull()

    resolveInstall?.({
      ok: true,
      data: {
        item: {
          id: 'filesystem',
          kind: 'mcp',
          name: 'Filesystem',
          version: '1.0.0',
          description: '',
          enabled: true,
          installSource: 'bundled',
          installedAt: new Date().toISOString(),
          packagePath: 'filesystem/1.0.0'
        }
      }
    })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^Installing/i })).toBeNull()
    })
  })

  it('Manage hub lists packages, skills, and MCP add', async () => {
    render(
      <MarketplaceView settings={baseSettings} onUpdate={vi.fn(async () => ({ ok: true as const }))} />
    )
    fireEvent.click((await screen.findAllByRole('tab', { name: /^Manage$/i }))[0]!)
    expect(await screen.findByRole('tab', { name: /^MCPs$/i })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /^Skills$/i })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /^Rules$/i })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /^Packages$/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: /^Packages$/i }))
    expect(await screen.findByText('Memory')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: /^Skills$/i }))
    expect(await screen.findByText('ship-notes')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: /^MCPs$/i }))
    fireEvent.click(await screen.findByRole('button', { name: /^New$/i }))
    expect(await screen.findByLabelText(/Paste MCP URL, command, or JSON/i)).toBeTruthy()
  })

  it('shows connected state for installed MCP packages', async () => {
    render(
      <MarketplaceView settings={baseSettings} onUpdate={vi.fn(async () => ({ ok: true as const }))} />
    )
    expect(await screen.findAllByText(/Connected · 2 tools/i)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /^Connected$/i }).length).toBeGreaterThan(0)
  })

  it('keeps Browse, detail, and Manage on the same connected MCP status', async () => {
    const settings: Settings = {
      ...baseSettings,
      mcpServers: [
        {
          id: 'memory-settings',
          name: 'Memory',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-memory'],
          enabled: false,
          source: 'marketplace',
          packageId: 'memory'
        }
      ]
    }
    render(
      <MarketplaceView settings={settings} onUpdate={vi.fn(async () => ({ ok: true as const }))} />
    )
    const installed = await screen.findByRole('heading', { name: /^Installed$/i })
    expect(installed.closest('section')?.textContent).toMatch(/Connected · 2 tools/i)
    expect(screen.getAllByRole('button', { name: /^Connected$/i }).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByText('Memory'))
    expect(await screen.findByRole('button', { name: /^Connected$/i })).toBeTruthy()
    expect(screen.getByText(/Connected · 2 tools/i)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /^Manage$/i }))
    expect(await screen.findByText(/Connected · 2 tools/i)).toBeTruthy()
    expect(screen.queryByText(/^Disabled$/i)).toBeNull()
    expect(screen.queryByRole('checkbox', { name: /Enable MCP server/i })).toBeNull()
  })

  it('does not show connected on Browse when the MCP is disabled', async () => {
    window.vyotiq.marketplaceListInstalled = vi.fn(async () => ({
      ok: true as const,
      data: {
        schemaVersion: 1 as const,
        items: [
          {
            id: 'memory',
            kind: 'mcp' as const,
            name: 'Memory',
            version: '1.0.0',
            description: '',
            enabled: false,
            installSource: 'bundled' as const,
            installedAt: new Date().toISOString(),
            packagePath: 'memory/1.0.0'
          }
        ]
      }
    }))
    window.vyotiq.mcpStatus = vi.fn(async () => ({
      ok: true as const,
      data: {
        servers: [
          {
            id: 'memory',
            name: 'Memory',
            enabled: false,
            connected: true,
            toolCount: 2
          }
        ]
      }
    }))
    const settings: Settings = {
      ...baseSettings,
      mcpServers: [
        {
          id: 'memory',
          name: 'Memory',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-memory'],
          enabled: false,
          source: 'marketplace',
          packageId: 'memory'
        }
      ]
    }
    render(
      <MarketplaceView settings={settings} onUpdate={vi.fn(async () => ({ ok: true as const }))} />
    )
    const installed = await screen.findByRole('heading', { name: /^Installed$/i })
    expect(installed.closest('section')?.textContent).toMatch(/Disabled/i)
    expect(installed.closest('section')?.textContent).not.toMatch(/Connected/i)

    fireEvent.click(screen.getByText('Memory'))
    expect(await screen.findByRole('button', { name: /^Disabled$/i })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /^Manage$/i }))
    expect(await screen.findByText(/^Disabled$/i)).toBeTruthy()
    expect(screen.queryByText(/Connected · 2 tools/i)).toBeNull()
  })

  it('does not show connected on Featured catalog MCPs that are not installed', async () => {
    window.vyotiq.mcpStatus = vi.fn(async () => ({
      ok: true as const,
      data: {
        servers: [
          {
            id: 'filesystem',
            name: 'Filesystem',
            enabled: true,
            connected: true,
            toolCount: 6
          },
          {
            id: 'memory',
            name: 'Memory',
            enabled: true,
            connected: true,
            toolCount: 2
          }
        ]
      }
    }))
    render(
      <MarketplaceView settings={baseSettings} onUpdate={vi.fn(async () => ({ ok: true as const }))} />
    )
    await screen.findByRole('heading', { name: /^Featured$/i })
    const featured = screen.getByRole('heading', { name: /^Featured$/i }).closest('section')
    expect(featured?.textContent).toContain('Filesystem')
    expect(featured?.textContent).not.toMatch(/Connected/i)
    expect(within(featured!).getAllByRole('button', { name: /^Add$/i }).length).toBeGreaterThan(0)
  })

  it('marks the selected package when returning from detail', async () => {
    render(
      <MarketplaceView settings={baseSettings} onUpdate={vi.fn(async () => ({ ok: true as const }))} />
    )
    await screen.findByRole('heading', { name: /^Featured$/i })
    fireEvent.click(screen.getByText('Filesystem'))
    expect(await screen.findByRole('button', { name: /^Add to Agent V$/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Marketplace$/i }))
    await screen.findByRole('heading', { name: /^Featured$/i })
    const selected = screen.getAllByRole('button', { current: 'page' })
    expect(selected.some((el) => el.textContent?.includes('Filesystem'))).toBe(true)
  })

  it('opens package detail with contents', async () => {
    render(
      <MarketplaceView settings={baseSettings} onUpdate={vi.fn(async () => ({ ok: true as const }))} />
    )
    await screen.findByRole('heading', { name: /^Featured$/i })
    fireEvent.click(screen.getByText('Filesystem'))
    expect(await screen.findByRole('button', { name: /^Add to Agent V$/i })).toBeTruthy()
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /^MCP$/i })).toBeTruthy()
    })
  })

  /**
   * Add on an interlinked skill installs more than the card names. Say so
   * before the click, and only for the part the user does not already have —
   * `memory` is installed in this fixture, so it must not be listed.
   */
  it('names the packages an install will pull in with it', async () => {
    render(
      <MarketplaceView settings={baseSettings} onUpdate={vi.fn(async () => ({ ok: true as const }))} />
    )
    await screen.findByRole('heading', { name: /^Featured$/i })
    fireEvent.click(screen.getByText('Grill me'))
    const note = await screen.findByText(/^Also installs/i)
    expect(note.textContent).toContain('grilling')
    expect(note.textContent).not.toContain('memory')
  })

  it('opens Manage from header Browse/Manage tabs', async () => {
    render(
      <MarketplaceView settings={baseSettings} onUpdate={vi.fn(async () => ({ ok: true as const }))} />
    )
    const manageTabs = await screen.findAllByRole('tab', { name: /^Manage$/i })
    fireEvent.click(manageTabs[0]!)
    expect(await screen.findByRole('tab', { name: /^MCPs$/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: /^Browse$/i }))
    expect(await screen.findByRole('heading', { name: /^Featured$/i })).toBeTruthy()
  })

  it('Manage shows Package registry panel with URL and ack', async () => {
    render(
      <MarketplaceView settings={baseSettings} onUpdate={vi.fn(async () => ({ ok: true as const }))} />
    )
    fireEvent.click((await screen.findAllByRole('tab', { name: /^Manage$/i }))[0]!)
    expect(await screen.findByLabelText(/Package registry/i)).toBeTruthy()
    expect(screen.getByLabelText(/Registry URL/i)).toBeTruthy()
    expect(screen.getByLabelText(/Acknowledge marketplace install risk/i)).toBeTruthy()
  })

  it('refreshes the remote catalog after the registry URL changes on blur', async () => {
    const refreshCatalog = vi.fn(async () => ({
      ok: true as const,
      data: { schemaVersion: 1 as const, packages: [] }
    }))
    // @ts-expect-error test bridge
    window.vyotiq.marketplaceRefreshCatalog = refreshCatalog
    render(
      <MarketplaceView settings={baseSettings} onUpdate={vi.fn(async () => ({ ok: true as const }))} />
    )
    fireEvent.click((await screen.findAllByRole('tab', { name: /^Manage$/i }))[0]!)
    const input = await screen.findByLabelText(/Registry URL/i)
    fireEvent.change(input, { target: { value: 'https://registry.example.com' } })
    fireEvent.blur(input)
    await waitFor(() => {
      expect(refreshCatalog).toHaveBeenCalledTimes(1)
    })
  })

  it('exposes full package names on truncated cards and roving tab a11y', async () => {
    render(
      <MarketplaceView settings={baseSettings} onUpdate={vi.fn(async () => ({ ok: true as const }))} />
    )
    await screen.findByRole('heading', { name: /^Featured$/i })

    const filesystem = screen.getByRole('button', { name: 'Filesystem' })
    expect(filesystem.getAttribute('title')).toBe('Filesystem')
    expect(filesystem.querySelector('p[title="Filesystem"]')).toBeTruthy()
    expect(filesystem.querySelector('p[title="MCP filesystem"]')).toBeTruthy()

    const browse = screen.getByRole('tab', { name: /^Browse$/i })
    const manage = screen.getAllByRole('tab', { name: /^Manage$/i })[0]!
    expect(browse.getAttribute('aria-selected')).toBe('true')
    expect(browse.getAttribute('tabindex')).toBe('0')
    expect(manage.getAttribute('tabindex')).toBe('-1')
    expect(browse.getAttribute('aria-controls')).toBe('marketplace-browse-panel')
    expect(document.getElementById('marketplace-browse-panel')?.getAttribute('role')).toBe(
      'tabpanel'
    )

    fireEvent.keyDown(browse.closest('[role="tablist"]')!, { key: 'ArrowRight' })
    expect(await screen.findByRole('tab', { name: /^MCPs$/i })).toBeTruthy()
    const manageHeader = screen.getAllByRole('tab', { name: /^Manage$/i })[0]!
    expect(manageHeader.getAttribute('aria-selected')).toBe('true')
    expect(manageHeader.getAttribute('tabindex')).toBe('0')
  })

  it('empty search points to Manage → Add for external MCPs', async () => {
    render(
      <MarketplaceView settings={baseSettings} onUpdate={vi.fn(async () => ({ ok: true as const }))} />
    )
    await screen.findByRole('heading', { name: /^Featured$/i })
    fireEvent.change(screen.getByLabelText(/Search marketplace/i), {
      target: { value: 'not-in-catalog-xyz' }
    })
    expect(
      await screen.findByText(/No matching packages in the curated catalog/i)
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Open Manage to add$/i }))
    expect(await screen.findByLabelText(/Paste MCP URL, command, or JSON/i)).toBeTruthy()
  })

  it('links installed detail to Manage', async () => {
    render(
      <MarketplaceView settings={baseSettings} onUpdate={vi.fn(async () => ({ ok: true as const }))} />
    )
    await screen.findByRole('heading', { name: /^Featured$/i })
    fireEvent.click(screen.getByText('Memory'))
    expect(await screen.findByRole('button', { name: /^Connected$/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Manage$/i }))
    expect(await screen.findByRole('tab', { name: /^MCPs$/i })).toBeTruthy()
  })

  it('detects pasted stdio MCP on Manage MCPs New panel', async () => {
    render(
      <MarketplaceView settings={baseSettings} onUpdate={vi.fn(async () => ({ ok: true as const }))} />
    )
    fireEvent.click((await screen.findAllByRole('tab', { name: /^Manage$/i }))[0]!)
    fireEvent.click(await screen.findByRole('button', { name: /^New$/i }))
    const paste = await screen.findByLabelText(/Paste MCP URL, command, or JSON/i)
    fireEvent.change(paste, { target: { value: 'uvx mcp-server-fetch' } })
    fireEvent.click(screen.getByRole('button', { name: /^Detect$/i }))
    expect(await screen.findByDisplayValue('uvx')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Add & connect/i }))
    await waitFor(() => {
      expect(window.vyotiq.marketplaceApplyDetectedMcp).toHaveBeenCalled()
    })
  })

  it('focuses marketplace search on mount', async () => {
    render(
      <MarketplaceView
        settings={baseSettings}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onClose={vi.fn()}
      />
    )
    const search = await screen.findByLabelText(/Search marketplace/i)
    await waitFor(() => {
      expect(document.activeElement).toBe(search)
    })
  })

  it('closes on Escape from an empty search', async () => {
    const onClose = vi.fn()
    render(
      <MarketplaceView
        settings={baseSettings}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onClose={onClose}
      />
    )
    const search = await screen.findByLabelText(/Search marketplace/i)
    fireEvent.change(search, { target: { value: 'filesystem' } })
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('renders Discover above Featured and does not duplicate ids', async () => {
    // @ts-expect-error test bridge
    window.vyotiq.marketplaceBrowse = vi.fn(async () => ({
      ok: true as const,
      data: {
        packages: [
          {
            id: 'github',
            name: 'GitHub',
            version: '1.0.0',
            description: 'Official hosted GitHub MCP.',
            kind: 'mcp' as const,
            source: 'bundled' as const,
            sections: ['discover', 'featured'] as const,
            category: 'developer',
            featuredRank: 1,
            publisher: 'GitHub',
            installable: true,
            bundledPath: 'github'
          },
          {
            id: 'gmail',
            name: 'Gmail',
            version: '1.0.0',
            description: 'Official hosted Gmail MCP.',
            kind: 'mcp' as const,
            source: 'bundled' as const,
            sections: ['discover', 'featured'] as const,
            category: 'productivity',
            featuredRank: 2,
            publisher: 'Google',
            installable: true,
            bundledPath: 'gmail'
          },
          {
            id: 'filesystem',
            name: 'Filesystem',
            version: '1.0.0',
            description: 'MCP filesystem',
            kind: 'mcp' as const,
            source: 'bundled' as const,
            sections: ['featured'] as const,
            category: 'infrastructure',
            featuredRank: 5,
            publisher: 'Model Context Protocol',
            installable: true,
            bundledPath: 'filesystem'
          },
          {
            id: 'fetch',
            name: 'Fetch',
            version: '1.0.0',
            description: 'Fetch MCP',
            kind: 'mcp' as const,
            source: 'bundled' as const,
            category: 'infrastructure',
            publisher: 'Model Context Protocol',
            installable: true,
            bundledPath: 'fetch'
          }
        ]
      }
    }))
    window.vyotiq.marketplaceListInstalled = vi.fn(async () => ({
      ok: true as const,
      data: { schemaVersion: 1 as const, items: [] }
    }))

    render(
      <MarketplaceView settings={baseSettings} onUpdate={vi.fn(async () => ({ ok: true as const }))} />
    )
    expect(await screen.findByRole('heading', { name: /^Discover$/i })).toBeTruthy()
    expect(screen.getByRole('heading', { name: /^Featured$/i })).toBeTruthy()
    expect(screen.getByRole('heading', { name: /^Infrastructure$/i })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: /^Developer$/i })).toBeNull()
    expect(screen.queryByRole('heading', { name: /^Productivity$/i })).toBeNull()
    expect(screen.getAllByText('GitHub').length).toBe(1)
    expect(screen.getAllByText('Gmail').length).toBe(1)
    const discover = screen.getByRole('heading', { name: /^Discover$/i }).closest('section')
    expect(discover?.textContent).toContain('GitHub')
    expect(discover?.textContent).toContain('Gmail')
    expect(within(discover!).getAllByRole('button', { name: /^Add$/i }).length).toBe(2)
    const featured = screen.getByRole('heading', { name: /^Featured$/i }).closest('section')
    expect(featured?.textContent).toContain('Filesystem')
    expect(featured?.textContent).not.toContain('GitHub')
    expect(featured?.textContent).not.toContain('Gmail')
    const infra = screen.getByRole('heading', { name: /^Infrastructure$/i }).closest('section')
    expect(infra?.textContent).toContain('Fetch')
    expect(infra?.textContent).not.toContain('Filesystem')
    expect(within(infra!).getByRole('button', { name: /^Add$/i })).toBeTruthy()
  })
})
