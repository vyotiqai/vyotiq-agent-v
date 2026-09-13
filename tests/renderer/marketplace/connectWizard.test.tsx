/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MarketplaceView } from '@renderer/features/marketplace'
import { DEFAULT_SETTINGS, type Settings } from '@shared/ipc'

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) {
    this.open = true
  })
  HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) {
    this.open = false
  })
})

afterEach(() => {
  cleanup()
})

const baseSettings: Settings = {
  ...DEFAULT_SETTINGS,
  marketplace: { registryUrl: '', remoteInstallAcked: true },
  mcpServers: []
}

const githubCatalog = {
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
}

const gmailCatalog = {
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
}

function mockVyotiq(opts?: {
  packages?: unknown[]
  installed?: unknown[]
  mcpServersStatus?: unknown[]
}): void {
  const packages = opts?.packages ?? [githubCatalog]
  // @ts-expect-error test bridge
  window.vyotiq = {
    marketplaceBrowse: vi.fn(async () => ({ ok: true as const, data: { packages } })),
    marketplaceListInstalled: vi.fn(async () => ({
      ok: true as const,
      data: { schemaVersion: 1 as const, items: opts?.installed ?? [] }
    })),
    marketplaceGetContents: vi.fn(async () => ({
      ok: true as const,
      data: { id: 'github', kind: 'mcp' as const, mcp: [], skills: [], rules: [] }
    })),
    marketplaceInstall: vi.fn(async () => ({
      ok: true as const,
      data: {
        item: {
          id: 'github',
          kind: 'mcp' as const,
          name: 'GitHub',
          version: '1.0.0',
          description: '',
          enabled: true,
          installSource: 'bundled' as const,
          installedAt: new Date().toISOString(),
          packagePath: 'github/1.0.0'
        }
      }
    })),
    mcpStatus: vi.fn(async () => ({
      ok: true as const,
      data: { servers: opts?.mcpServersStatus ?? [], hasGoogleMcpClientSecret: false }
    })),
    mcpRefresh: vi.fn(async () => ({
      ok: true as const,
      data: { servers: opts?.mcpServersStatus ?? [], hasGoogleMcpClientSecret: false }
    })),
    mcpStartOAuth: vi.fn(async () => ({
      ok: true as const,
      data: { servers: [], hasGoogleMcpClientSecret: false }
    })),
    mcpSetAuthToken: vi.fn(async () => ({ ok: true as const, data: true as const })),
    mcpSetGoogleClientSecret: vi.fn(async () => ({ ok: true as const, data: true as const })),
    mcpSetOAuthClientSecret: vi.fn(async () => ({ ok: true as const, data: true as const })),
    skillsListLocal: vi.fn(async () => ({ ok: true as const, data: { skills: [] } })),
    onSkillsChanged: vi.fn(() => () => {})
  }
}

describe('Connect MCP wizard', () => {
  it('opens after GitHub catalog install and offers OAuth or PAT', async () => {
    mockVyotiq()
    render(
      <MarketplaceView settings={baseSettings} onUpdate={vi.fn(async () => ({ ok: true as const }))} />
    )
    expect(await screen.findByRole('heading', { name: /^Discover$/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Add$/i }))
    expect(await screen.findByRole('dialog', { name: /Connect GitHub/i })).toBeTruthy()
    expect(screen.getByText(/Sign in with OAuth/i)).toBeTruthy()
    expect(screen.getByText(/Paste a personal access token/i)).toBeTruthy()
    expect(screen.queryByText(/ready/i)).toBeNull()
  })

  it('shows Google client setup and exact redirect URI on first Gmail connect', async () => {
    mockVyotiq({
      packages: [gmailCatalog],
      installed: [
        {
          id: 'gmail',
          kind: 'mcp',
          name: 'Gmail',
          version: '1.0.0',
          description: '',
          enabled: true,
          installSource: 'bundled',
          installedAt: new Date().toISOString(),
          packagePath: 'gmail/1.0.0'
        }
      ]
    })
    const settings: Settings = {
      ...baseSettings,
      googleMcpClientId: '',
      mcpServers: [
        {
          id: 'gmail',
          name: 'Gmail',
          transport: 'http',
          url: 'https://gmailmcp.googleapis.com/mcp/v1',
          enabled: true,
          source: 'marketplace',
          packageId: 'gmail'
        }
      ]
    }
    render(
      <MarketplaceView
        settings={settings}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    fireEvent.click((await screen.findAllByRole('tab', { name: /^Manage$/i }))[0]!)
    fireEvent.click(await screen.findByRole('button', { name: /^Connect$/i }))
    expect(await screen.findByRole('dialog', { name: /Connect Gmail/i })).toBeTruthy()
    expect(screen.getByLabelText('OAuth redirect URI')).toHaveProperty(
      'value',
      'http://127.0.0.1:19847/oauth/callback'
    )
    expect(screen.getByLabelText(/Google Cloud client ID/i)).toBeTruthy()
    expect(screen.getByLabelText(/Google Cloud client secret/i)).toBeTruthy()
  })

  it('skips Google client setup when a shared client already exists', async () => {
    mockVyotiq({
      packages: [gmailCatalog],
      installed: [
        {
          id: 'gmail',
          kind: 'mcp',
          name: 'Gmail',
          version: '1.0.0',
          description: '',
          enabled: true,
          installSource: 'bundled',
          installedAt: new Date().toISOString(),
          packagePath: 'gmail/1.0.0'
        }
      ]
    })
    // @ts-expect-error test bridge
    window.vyotiq.mcpStatus = vi.fn(async () => ({
      ok: true as const,
      data: {
        servers: [
          {
            id: 'gmail',
            name: 'Gmail',
            enabled: true,
            connected: false,
            toolCount: 0,
            hasOAuthClientSecret: true
          }
        ],
        hasGoogleMcpClientSecret: true
      }
    }))
    const settings: Settings = {
      ...baseSettings,
      googleMcpClientId: '123.apps.googleusercontent.com',
      mcpServers: [
        {
          id: 'gmail',
          name: 'Gmail',
          transport: 'http',
          url: 'https://gmailmcp.googleapis.com/mcp/v1',
          enabled: true,
          source: 'marketplace',
          packageId: 'gmail'
        }
      ]
    }
    render(
      <MarketplaceView
        settings={settings}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    fireEvent.click((await screen.findAllByRole('tab', { name: /^Manage$/i }))[0]!)
    await waitFor(() => {
      expect(window.vyotiq.mcpStatus).toHaveBeenCalled()
    })
    fireEvent.click(await screen.findByRole('button', { name: /^Connect$/i }))
    expect(await screen.findByRole('dialog', { name: /Connect Gmail/i })).toBeTruthy()
    expect(screen.queryByLabelText(/Google Cloud client ID/i)).toBeNull()
    expect(screen.getByText(/Where can Agent V use this/i)).toBeTruthy()
  })

  it('calls startMcpOAuth with workspace scope after GitHub continue', async () => {
    mockVyotiq()
    render(
      <MarketplaceView
        settings={baseSettings}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        activeWorkspacePath="C:\\ws"
      />
    )
    fireEvent.click(await screen.findByRole('button', { name: /^Add$/i }))
    expect(await screen.findByRole('dialog', { name: /Connect GitHub/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Continue$/i }))
    expect(await screen.findByText(/Where can Agent V use this/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Continue$/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Sign in$/i }))
    await waitFor(() => {
      expect(window.vyotiq.mcpStartOAuth).toHaveBeenCalledWith('github', {
        authScope: 'all-workspaces'
      })
    })
  })
})
