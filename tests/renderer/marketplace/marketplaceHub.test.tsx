/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MarketplaceView } from '@renderer/features/marketplace'
import { DEFAULT_SETTINGS, type Settings } from '@shared/ipc'

afterEach(() => {
  cleanup()
})

const baseSettings: Settings = {
  ...DEFAULT_SETTINGS,
  marketplace: { registryUrl: '', remoteInstallAcked: true },
  mcpServers: []
}

function mockVyotiq(overrides?: Record<string, unknown>): void {
  // @ts-expect-error test bridge
  window.vyotiq = {
    marketplaceBrowse: vi.fn(async () => ({ ok: true as const, data: { packages: [] } })),
    marketplaceListInstalled: vi.fn(async () => ({
      ok: true as const,
      data: { schemaVersion: 1 as const, items: [] }
    })),
    marketplaceGetContents: vi.fn(async () => ({
      ok: true as const,
      data: { id: 'x', kind: 'mcp' as const, mcp: [], skills: [], rules: [] }
    })),
    mcpStatus: vi.fn(async () => ({ ok: true as const, data: { servers: [] } })),
    mcpRefresh: vi.fn(async () => ({ ok: true as const, data: { servers: [] } })),
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
      data: { preview: [], applied: 0, skipped: 0, warnings: [], scannedPaths: [] }
    })),
    marketplaceImportExternalMcp: vi.fn(async () => ({
      ok: true as const,
      data: { preview: [], applied: 0, skipped: 0, warnings: [], scannedPaths: [] }
    })),
    marketplacePickLocal: vi.fn(async () => ({ ok: true as const, data: null })),
    skillsListLocal: vi.fn(async () => ({
      ok: true as const,
      data: {
        skills: [
          {
            id: 'skill:local:personal:house-style',
            name: 'house-style',
            description: 'Personal house style skill used across every workspace.',
            source: 'personal' as const,
            skillPath: 'C:/Users/admin/.vyotiq/skills/house-style/SKILL.md',
            relativePath: '~/.vyotiq/skills/house-style/SKILL.md'
          }
        ]
      }
    })),
    skillsReadLocal: vi.fn(async () => ({
      ok: true as const,
      data: {
        skillPath: 'C:/Users/admin/.vyotiq/skills/house-style/SKILL.md',
        content:
          '---\nname: house-style\ndescription: Personal house style skill used across every workspace.\n---\n\n# House style\n',
        name: 'house-style',
        description: 'Personal house style skill used across every workspace.',
        body: '# House style\n'
      }
    })),
    skillsWriteLocal: vi.fn(async () => ({
      ok: true as const,
      data: {
        skillPath: 'C:/Users/admin/.vyotiq/skills/house-style/SKILL.md',
        relativePath: '~/.vyotiq/skills/house-style/SKILL.md',
        name: 'house-style'
      }
    })),
    skillsDeleteLocal: vi.fn(async () => ({ ok: true as const, data: true as const })),
    skillsOpenLocal: vi.fn(async () => ({ ok: true as const, data: true as const })),
    slashCommandsCreateSkill: vi.fn(async (payload: { scope?: string }) => ({
      ok: true as const,
      data: {
        path:
          payload.scope === 'personal'
            ? 'C:/Users/admin/.vyotiq/skills/release-notes/SKILL.md'
            : 'C:/tmp/.vyotiq/skills/release-notes/SKILL.md',
        relativePath:
          payload.scope === 'personal'
            ? '~/.vyotiq/skills/release-notes/SKILL.md'
            : '.vyotiq/skills/release-notes/SKILL.md',
        name: 'release-notes',
        source: payload.scope === 'personal' ? ('personal' as const) : ('project' as const)
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
      data: {
        rules: [
          {
            path: '.vyotiq/rules/ops.md',
            description: 'Never force-push main during a production incident.',
            alwaysApply: true
          }
        ]
      }
    })),
    workspaceFileRead: vi.fn(async () => ({
      ok: true as const,
      data: {
        path: '.vyotiq/rules/ops.md',
        kind: 'text' as const,
        content:
          '---\nalwaysApply: true\ndescription: Never force-push main during a production incident.\n---\n\nNever force-push main.\n',
        encoding: 'utf8' as const,
        eol: 'lf' as const,
        bom: false,
        size: 120,
        version: {
          size: 120,
          mtimeMs: 1,
          sha256: 'a'.repeat(64)
        },
        truncated: false
      }
    })),
    workspaceFileSave: vi.fn(async () => ({
      ok: true as const,
      data: {
        path: '.vyotiq/rules/ops.md',
        version: { size: 140, mtimeMs: 2, sha256: 'b'.repeat(64) },
        size: 140
      }
    })),
    workspaceFileDelete: vi.fn(async () => ({
      ok: true as const,
      data: { path: '.vyotiq/rules/ops.md', kind: 'file' as const }
    })),
    workspaceFileReveal: vi.fn(async () => ({ ok: true as const, data: true as const })),
    shellOpenExternal: vi.fn(async () => ({ ok: true as const, data: true as const })),
    onSkillsChanged: vi.fn(() => () => {}),
    ...overrides
  }
}

describe('Marketplace manage hub', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
    if (typeof Range !== 'undefined') {
      Object.defineProperty(Range.prototype, 'getClientRects', {
        configurable: true,
        value: () => [] as unknown as DOMRectList
      })
      Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
        configurable: true,
        value: () =>
          ({
            x: 0,
            y: 0,
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            width: 0,
            height: 0,
            toJSON: () => ({})
          }) as DOMRect
      })
    }
    mockVyotiq()
  })

  it('shows the MCP empty state and opens documentation', async () => {
    render(
      <MarketplaceView settings={baseSettings} onUpdate={vi.fn(async () => ({ ok: true as const }))} />
    )
    fireEvent.click((await screen.findAllByRole('tab', { name: /^Manage$/i }))[0]!)
    expect(await screen.findByRole('heading', { name: /Connect External Tools with MCP/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Documentation$/i }))
    await waitFor(() => {
      expect(window.vyotiq.shellOpenExternal).toHaveBeenCalledWith('https://modelcontextprotocol.io/')
    })
  })

  it('creates a user skill from New and opens the editor', async () => {
    render(
      <MarketplaceView settings={baseSettings} onUpdate={vi.fn(async () => ({ ok: true as const }))} />
    )
    fireEvent.click((await screen.findAllByRole('tab', { name: /^Manage$/i }))[0]!)
    fireEvent.click(await screen.findByRole('tab', { name: /^Skills$/i }))
    expect(await screen.findByText('house-style')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^New user skill$/i }))
    const input = await screen.findByLabelText('Prompt input')
    fireEvent.change(input, { target: { value: 'release notes' } })
    fireEvent.click(screen.getByRole('button', { name: /^OK$/i }))
    await waitFor(() => {
      expect(window.vyotiq.slashCommandsCreateSkill).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'personal', title: 'release notes' })
      )
    })
  })

  it('disables workspace skill New without a workspace', async () => {
    render(
      <MarketplaceView settings={baseSettings} onUpdate={vi.fn(async () => ({ ok: true as const }))} />
    )
    fireEvent.click((await screen.findAllByRole('tab', { name: /^Manage$/i }))[0]!)
    fireEvent.click(await screen.findByRole('tab', { name: /^Skills$/i }))
    const workspaceNew = screen.getByRole('button', { name: /^New workspace skill$/i })
    expect(workspaceNew).toHaveProperty('disabled', true)
    expect(screen.getByText(/Open a workspace to create a project skill/i)).toBeTruthy()
  })

  it('saves skill property edits through skillsWriteLocal', async () => {
    render(
      <MarketplaceView
        settings={baseSettings}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        activeWorkspacePath="C:/tmp/project"
      />
    )
    fireEvent.click((await screen.findAllByRole('tab', { name: /^Manage$/i }))[0]!)
    fireEvent.click(await screen.findByRole('tab', { name: /^Skills$/i }))
    fireEvent.click(await screen.findByText('house-style'))
    const description = await screen.findByLabelText('Skill description')
    fireEvent.change(description, {
      target: { value: 'Updated house style skill for TypeScript modules in this product.' }
    })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }))
    await waitFor(() => {
      expect(window.vyotiq.skillsWriteLocal).toHaveBeenCalled()
    })
    const payload = vi.mocked(window.vyotiq.skillsWriteLocal).mock.calls[0]![0]
    expect(payload.content).toContain('Updated house style skill')
  })

  it('writes a new user rule through settings', async () => {
    const onUpdate = vi.fn(async () => ({ ok: true as const }))
    render(<MarketplaceView settings={baseSettings} onUpdate={onUpdate} />)
    fireEvent.click((await screen.findAllByRole('tab', { name: /^Manage$/i }))[0]!)
    fireEvent.click(await screen.findByRole('tab', { name: /^Rules$/i }))
    fireEvent.click(screen.getByRole('button', { name: /^New user rule$/i }))
    expect(await screen.findByRole('button', { name: /^Confirm$/i })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('User rule name'), {
      target: { value: 'House style' }
    })
    fireEvent.click(screen.getByRole('button', { name: /^Confirm$/i }))
    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          userRules: [
            expect.objectContaining({
              name: 'House style',
              enabled: true,
              body: ''
            })
          ]
        })
      )
    })
  })

  it('opens Manage Skills when focusSkillPath is set', async () => {
    render(
      <MarketplaceView
        settings={baseSettings}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        focusSkillPath="C:/Users/admin/.vyotiq/skills/house-style/SKILL.md"
      />
    )
    expect((await screen.findByRole('tab', { name: /^Skills$/i })).getAttribute('aria-selected')).toBe(
      'true'
    )
    expect(await screen.findByText('house-style')).toBeTruthy()
  })

  it('opens Manage Rules when focusRulePath is set', async () => {
    render(
      <MarketplaceView
        settings={baseSettings}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        activeWorkspacePath="C:/tmp/project"
        focusRulePath=".vyotiq/rules/ops.md"
      />
    )
    expect((await screen.findByRole('tab', { name: /^Rules$/i })).getAttribute('aria-selected')).toBe(
      'true'
    )
    expect(await screen.findByText('.vyotiq/rules/ops.md')).toBeTruthy()
  })

  it('does not offer Save after a skill file fails to load', async () => {
    mockVyotiq({
      skillsReadLocal: vi.fn(async () => ({
        ok: false as const,
        error: 'Path is not a local skill file'
      }))
    })
    render(
      <MarketplaceView settings={baseSettings} onUpdate={vi.fn(async () => ({ ok: true as const }))} />
    )
    fireEvent.click((await screen.findAllByRole('tab', { name: /^Manage$/i }))[0]!)
    fireEvent.click(await screen.findByRole('tab', { name: /^Skills$/i }))
    fireEvent.click(await screen.findByText('house-style'))
    await waitFor(() => {
      expect(screen.getAllByText('Path is not a local skill file').length).toBeGreaterThan(0)
    })
    expect(screen.queryByRole('button', { name: /^Save$/i })).toBeNull()
  })

  it('keeps glob frontmatter when saving a project rule', async () => {
    mockVyotiq({
      workspaceListRules: vi.fn(async () => ({
        ok: true as const,
        data: {
          rules: [
            {
              path: '.cursor/rules/typescript.mdc',
              description: 'TypeScript modules in this workspace',
              alwaysApply: false
            }
          ]
        }
      })),
      workspaceFileRead: vi.fn(async () => ({
        ok: true as const,
        data: {
          path: '.cursor/rules/typescript.mdc',
          kind: 'text' as const,
          content: [
            '---',
            'globs:',
            '  - "*.ts"',
            'alwaysApply: false',
            'description: TypeScript modules in this workspace',
            '---',
            '',
            'Prefer named exports.',
            ''
          ].join('\n'),
          encoding: 'utf8' as const,
          eol: 'lf' as const,
          bom: false,
          size: 180,
          version: { size: 180, mtimeMs: 1, sha256: 'c'.repeat(64) },
          truncated: false
        }
      })),
      workspaceFileSave: vi.fn(async () => ({
        ok: true as const,
        data: {
          path: '.cursor/rules/typescript.mdc',
          version: { size: 200, mtimeMs: 2, sha256: 'd'.repeat(64) },
          size: 200
        }
      }))
    })
    render(
      <MarketplaceView
        settings={baseSettings}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        activeWorkspacePath="C:/tmp/project"
      />
    )
    fireEvent.click((await screen.findAllByRole('tab', { name: /^Manage$/i }))[0]!)
    fireEvent.click(await screen.findByRole('tab', { name: /^Rules$/i }))
    fireEvent.click(await screen.findByText('.cursor/rules/typescript.mdc'))
    fireEvent.click(await screen.findByRole('button', { name: /^Save$/i }))
    await waitFor(() => {
      expect(window.vyotiq.workspaceFileSave).toHaveBeenCalled()
    })
    const payload = vi.mocked(window.vyotiq.workspaceFileSave).mock.calls[0]![0]
    expect(payload.content).toContain('globs:')
    expect(payload.content).toContain('- "*.ts"')
    expect(payload.content).toContain('alwaysApply: false')
  })

  it('saves root instruction files without stripping a leading --- block', async () => {
    const agents = [
      '---',
      'name: workspace',
      '---',
      '',
      '# AGENTS.md',
      '',
      'Follow the workspace instructions in this file.',
      ''
    ].join('\n')
    mockVyotiq({
      workspaceListRules: vi.fn(async () => ({
        ok: true as const,
        data: {
          rules: [{ path: 'AGENTS.md', alwaysApply: true }]
        }
      })),
      workspaceFileRead: vi.fn(async () => ({
        ok: true as const,
        data: {
          path: 'AGENTS.md',
          kind: 'text' as const,
          content: agents,
          encoding: 'utf8' as const,
          eol: 'lf' as const,
          bom: false,
          size: agents.length,
          version: { size: agents.length, mtimeMs: 1, sha256: 'e'.repeat(64) },
          truncated: false
        }
      })),
      workspaceFileSave: vi.fn(async () => ({
        ok: true as const,
        data: {
          path: 'AGENTS.md',
          version: { size: agents.length, mtimeMs: 2, sha256: 'f'.repeat(64) },
          size: agents.length
        }
      }))
    })
    render(
      <MarketplaceView
        settings={baseSettings}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        activeWorkspacePath="C:/tmp/project"
      />
    )
    fireEvent.click((await screen.findAllByRole('tab', { name: /^Manage$/i }))[0]!)
    fireEvent.click(await screen.findByRole('tab', { name: /^Rules$/i }))
    fireEvent.click(await screen.findByText('AGENTS.md'))
    expect(await screen.findByText(/Root instruction files are always applied/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }))
    await waitFor(() => {
      expect(window.vyotiq.workspaceFileSave).toHaveBeenCalled()
    })
    const payload = vi.mocked(window.vyotiq.workspaceFileSave).mock.calls[0]![0]
    expect(payload.content).toBe(agents)
  })
})
