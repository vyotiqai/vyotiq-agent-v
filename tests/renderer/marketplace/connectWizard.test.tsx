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

/** Shared by the JSX prop and the expectation so the two cannot disagree. */
const WORKSPACE = 'C:\\ws'

/** Minimal installed server shape the connect flow reads back from main. */
const githubServer = {
  id: 'github',
  name: 'GitHub',
  transport: 'http' as const,
  url: 'https://api.githubcopilot.com/mcp/',
  enabled: true,
  source: 'marketplace' as const,
  packageId: 'github',
  auth: 'oauth' as const
}

function mockVyotiq(opts?: {
  packages?: unknown[]
  installed?: unknown[]
  mcpServersStatus?: unknown[]
  /** What `getSettings` reports — drives the post-install connect decision. */
  serversAfterInstall?: unknown[]
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
    getSettings: vi.fn(async () => ({
      ok: true as const,
      data: {
        ...baseSettings,
        mcpServers: opts?.serversAfterInstall ?? [githubServer]
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
  it('opens straight to Sign in after GitHub catalog install', async () => {
    mockVyotiq()
    render(
      <MarketplaceView settings={baseSettings} onUpdate={vi.fn(async () => ({ ok: true as const }))} />
    )
    expect(await screen.findByRole('heading', { name: /^Discover$/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Add$/i }))
    expect(await screen.findByRole('dialog', { name: /Connect GitHub/i })).toBeTruthy()

    // The whole journey is Add → Sign in. Nothing to click past first.
    expect(screen.getByRole('button', { name: /^Sign in$/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Continue$/i })).toBeNull()
    // Defaulted choices stay out of the way until asked for.
    expect(screen.queryByText(/Sign in with OAuth/i)).toBeNull()
    expect(screen.queryByText(/Where can Agent V use this/i)).toBeNull()
  })

  it('exposes the PAT and scope choices under Options', async () => {
    mockVyotiq()
    render(
      <MarketplaceView settings={baseSettings} onUpdate={vi.fn(async () => ({ ok: true as const }))} />
    )
    fireEvent.click(await screen.findByRole('button', { name: /^Add$/i }))
    expect(await screen.findByRole('dialog', { name: /Connect GitHub/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Options$/i }))
    expect(screen.getByText(/Sign in with OAuth/i)).toBeTruthy()
    expect(screen.getByText(/Paste a personal access token/i)).toBeTruthy()
    expect(screen.getByText(/Where can Agent V use this/i)).toBeTruthy()
  })

  it('does not open the wizard for a package that needs no credentials', async () => {
    const publicCatalog = {
      ...githubCatalog,
      id: 'deepwiki',
      name: 'DeepWiki',
      bundledPath: 'deepwiki',
      auth: 'none' as const
    }
    mockVyotiq({
      packages: [publicCatalog],
      serversAfterInstall: [
        {
          id: 'deepwiki',
          name: 'DeepWiki',
          transport: 'http' as const,
          url: 'https://mcp.deepwiki.com/mcp',
          enabled: true,
          source: 'marketplace' as const,
          auth: 'none' as const
        }
      ]
    })
    render(
      <MarketplaceView settings={baseSettings} onUpdate={vi.fn(async () => ({ ok: true as const }))} />
    )
    fireEvent.click(await screen.findByRole('button', { name: /^Add$/i }))
    await waitFor(() => {
      expect(window.vyotiq.getSettings).toHaveBeenCalled()
    })
    expect(screen.queryByRole('dialog', { name: /Connect/i })).toBeNull()
  })

  it('collects declared inputs for a token package and stores them on the server', async () => {
    const tokenCatalog = {
      ...githubCatalog,
      id: 'demo-token',
      name: 'Demo',
      bundledPath: 'demo-token',
      auth: 'token' as const
    }
    const tokenServer = {
      id: 'demo-token',
      name: 'Demo',
      transport: 'http' as const,
      url: 'https://mcp.example.com/mcp',
      enabled: true,
      source: 'marketplace' as const,
      auth: 'token' as const,
      setupUrl: 'https://example.com/tokens',
      inputs: [
        {
          name: 'DEMO_API_KEY',
          target: 'env' as const,
          label: 'API key',
          isSecret: true,
          isRequired: true
        }
      ]
    }
    mockVyotiq({ packages: [tokenCatalog], serversAfterInstall: [tokenServer] })
    const onUpdate = vi.fn(async () => ({ ok: true as const }))
    render(
      <MarketplaceView
        settings={{ ...baseSettings, mcpServers: [tokenServer] }}
        onUpdate={onUpdate}
      />
    )
    fireEvent.click(await screen.findByRole('button', { name: /^Add$/i }))
    expect(await screen.findByRole('dialog', { name: /Connect Demo/i })).toBeTruthy()

    const field = screen.getByLabelText(/API key/i)
    expect(field).toHaveProperty('type', 'password')
    fireEvent.change(field, { target: { value: 'sk-live-123' } })
    fireEvent.click(screen.getByRole('button', { name: /^Continue$/i }))
    fireEvent.click(await screen.findByRole('button', { name: /^Connect$/i }))

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpServers: expect.arrayContaining([
            expect.objectContaining({
              id: 'demo-token',
              env: expect.objectContaining({ DEMO_API_KEY: 'sk-live-123' })
            })
          ])
        })
      )
    })
    // A token package has no browser flow.
    expect(window.vyotiq.mcpStartOAuth).not.toHaveBeenCalled()
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
    expect(screen.getByRole('button', { name: /^Sign in$/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Options$/i }))
    expect(screen.getByText(/Where can Agent V use this/i)).toBeTruthy()
    expect(screen.getByText(/Read and write/i)).toBeTruthy()
  })

  it('writes the vendor OAuth client, then keeps it when saving scope', async () => {
    const slackServer = {
      id: 'slack',
      name: 'Slack',
      transport: 'http' as const,
      url: 'https://mcp.slack.com/mcp',
      enabled: true,
      source: 'marketplace' as const,
      auth: 'oauth-client' as const,
      setupUrl: 'https://api.slack.com/apps'
    }
    mockVyotiq({
      packages: [{ ...githubCatalog, id: 'slack', name: 'Slack', bundledPath: 'slack', auth: 'oauth-client' as const }],
      serversAfterInstall: [slackServer]
    })
    const onUpdate = vi.fn(async () => ({ ok: true as const }))
    render(
      <MarketplaceView
        settings={{ ...baseSettings, mcpServers: [slackServer] }}
        onUpdate={onUpdate}
      />
    )
    fireEvent.click(await screen.findByRole('button', { name: /^Add$/i }))
    expect(await screen.findByRole('dialog', { name: /Connect Slack/i })).toBeTruthy()

    // Slack advertises no dynamic registration, so the user supplies a client.
    fireEvent.change(screen.getByLabelText(/^OAuth client ID$/i), {
      target: { value: 'slack-client-id' }
    })
    fireEvent.change(screen.getByLabelText(/^OAuth client secret$/i), {
      target: { value: 'slack-secret' }
    })
    fireEvent.click(screen.getByRole('button', { name: /^Continue$/i }))

    await waitFor(() => {
      expect(window.vyotiq.mcpSetOAuthClientSecret).toHaveBeenCalledWith('slack', 'slack-secret')
    })
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpServers: expect.arrayContaining([
          expect.objectContaining({ id: 'slack', oauthClientId: 'slack-client-id' })
        ])
      })
    )

    // The second write must not map over a stale list and drop the client id
    // the first step just saved.
    window.vyotiq.getSettings = vi.fn(async () => ({
      ok: true as const,
      data: {
        ...baseSettings,
        mcpServers: [{ ...slackServer, oauthClientId: 'slack-client-id' }]
      }
    })) as never
    onUpdate.mockClear()

    fireEvent.click(await screen.findByRole('button', { name: /^Sign in$/i }))
    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalled()
    })
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpServers: expect.arrayContaining([
          expect.objectContaining({ id: 'slack', oauthClientId: 'slack-client-id' })
        ])
      })
    )
  })

  it('reaches startMcpOAuth in two clicks with the default scope', async () => {
    mockVyotiq()
    render(
      <MarketplaceView
        settings={{ ...baseSettings, mcpServers: [githubServer] }}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        activeWorkspacePath={WORKSPACE}
      />
    )
    fireEvent.click(await screen.findByRole('button', { name: /^Add$/i }))
    expect(await screen.findByRole('dialog', { name: /Connect GitHub/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Sign in$/i }))
    await waitFor(() => {
      expect(window.vyotiq.mcpStartOAuth).toHaveBeenCalledWith('github', {
        authScope: 'all-workspaces'
      })
    })
  })

  it('binds the token to one workspace when that option is chosen', async () => {
    mockVyotiq()
    render(
      <MarketplaceView
        settings={{ ...baseSettings, mcpServers: [githubServer] }}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        activeWorkspacePath={WORKSPACE}
      />
    )
    fireEvent.click(await screen.findByRole('button', { name: /^Add$/i }))
    expect(await screen.findByRole('dialog', { name: /Connect GitHub/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Options$/i }))
    fireEvent.click(screen.getByLabelText(/This workspace only/i))
    fireEvent.click(screen.getByRole('button', { name: /^Sign in$/i }))
    await waitFor(() => {
      expect(window.vyotiq.mcpStartOAuth).toHaveBeenCalledWith('github', {
        authScope: 'this-workspace',
        workspacePath: WORKSPACE
      })
    })
  })
})
