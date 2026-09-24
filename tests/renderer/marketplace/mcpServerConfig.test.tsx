/**
 * @vitest-environment jsdom
 */
import { useCallback, useState, type JSX } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MarketplaceView } from '@renderer/features/marketplace'
import { McpServerConfig } from '@renderer/features/marketplace/McpServerConfig'
import { DEFAULT_SETTINGS, type McpServer, type McpServerStatus, type Settings } from '@shared/ipc'

const gmailServer: McpServer = {
  id: 'gmail',
  name: 'Gmail',
  transport: 'http',
  url: 'https://gmailmcp.googleapis.com/mcp/v1',
  enabled: true
}

const githubServer: McpServer = {
  id: 'github',
  name: 'GitHub',
  transport: 'http',
  url: 'https://api.githubcopilot.com/mcp/',
  enabled: true
}

const gitServer: McpServer = {
  id: 'git',
  name: 'Git',
  transport: 'stdio',
  command: 'uvx',
  args: ['mcp-server-git'],
  requires: ['uv'],
  enabled: true,
  source: 'manual'
}

const disconnected: McpServerStatus = { id: 'x', name: 'x', enabled: true, connected: false, toolCount: 0 }

function ok<T>(data: T) {
  return { ok: true as const, data }
}

type Bridge = Record<string, (...args: never[]) => unknown>
let bridge: Bridge

function installBridge(overrides: Bridge = {}): void {
  bridge = {
    marketplaceBrowse: vi.fn(async () => ok({ packages: [] })),
    marketplaceListInstalled: vi.fn(async () => ok({ schemaVersion: 1 as const, items: [] })),
    skillsListLocal: vi.fn(async () => ok({ skills: [] })),
    mcpStatus: vi.fn(async () => ok({ servers: [] })),
    mcpRefresh: vi.fn(async () => ok({ servers: [] })),
    mcpSetAuthToken: vi.fn(async () => ok(true as const)),
    mcpClearAuthToken: vi.fn(async () => ok(true as const)),
    mcpStartOAuth: vi.fn(async () => ok({ servers: [] })),
    mcpPickBinary: vi.fn(async () => ok({ path: 'C:/tools/uv/uvx.exe' })),
    shellOpenExternal: vi.fn(async () => ok(true as const)),
    ...overrides
  }
  window.vyotiq = bridge as unknown as typeof window.vyotiq
}

beforeEach(() => {
  installBridge()
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const signIn = () => screen.getByRole('button', { name: 'Sign in with OAuth' }) as HTMLButtonElement

describe('McpServerConfig sign-in', () => {
  it('holds Google sign-in until a client ID and a stored secret exist', async () => {
    render(
      <McpServerConfig
        server={gmailServer}
        status={{ ...disconnected, id: 'gmail', name: 'Gmail' }}
        onUpdate={async () => true}
      />
    )
    expect(signIn().disabled).toBe(true)
    // A disabled button never gets hover, so the reason is on its wrapper's tooltip.
    fireEvent.pointerEnter(signIn().parentElement!)
    await waitFor(() =>
      expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
        'Add a Google Cloud client ID and secret before signing in.'
      )
    )
    expect(screen.getByLabelText('OAuth client ID for gmail')).toBeTruthy()
    expect(screen.getByLabelText('OAuth client secret for gmail')).toBeTruthy()
    expect(screen.getByLabelText('Bearer token for gmail')).toBeTruthy()
    // A Google server always shows the fixed loopback address to register.
    expect(screen.getByLabelText('OAuth redirect URI for gmail')).toBeTruthy()
  })

  it('allows Google sign-in with the shared client ID and a stored secret', () => {
    render(
      <McpServerConfig
        server={gmailServer}
        status={{ ...disconnected, id: 'gmail', name: 'Gmail', hasOAuthClientSecret: true }}
        googleMcpClientId="123.apps.googleusercontent.com"
        onUpdate={async () => true}
      />
    )
    expect(signIn().disabled).toBe(false)
    expect((screen.getByLabelText('OAuth client ID for gmail') as HTMLInputElement).placeholder).toBe(
      'Shared Google client is set'
    )
  })

  it('allows GitHub sign-in without a client ID', async () => {
    const onAuthChanged = vi.fn()
    render(
      <McpServerConfig
        server={githubServer}
        status={{ ...disconnected, id: 'github', name: 'GitHub' }}
        onUpdate={async () => true}
        onAuthChanged={onAuthChanged}
      />
    )
    expect(signIn().disabled).toBe(false)
    fireEvent.click(signIn())
    await waitFor(() => expect(bridge.mcpStartOAuth).toHaveBeenCalledWith('github'))
    expect(onAuthChanged).toHaveBeenCalledTimes(1)
  })

  it('says why a sign-in failed', async () => {
    installBridge({ mcpStartOAuth: vi.fn(async () => ({ ok: false as const, error: 'The browser was closed.' })) })
    render(
      <McpServerConfig
        server={githubServer}
        status={{ ...disconnected, id: 'github', name: 'GitHub' }}
        onUpdate={async () => true}
      />
    )
    fireEvent.click(signIn())
    expect((await screen.findByRole('alert')).textContent).toBe('The browser was closed.')
  })

  it('offers no OAuth sign-in for a local server', () => {
    render(<McpServerConfig server={gitServer} status={undefined} onUpdate={async () => true} />)
    expect(screen.queryByRole('button', { name: 'Sign in with OAuth' })).toBeNull()
    expect(screen.queryByLabelText('Bearer token for git')).toBeNull()
  })
})

describe('McpServerConfig fields', () => {
  it('saves arguments one per line and environment as KEY=value lines', async () => {
    const onUpdate = vi.fn(async () => true)
    render(<McpServerConfig server={gitServer} status={undefined} onUpdate={onUpdate} />)
    const args = screen.getByLabelText('MCP arguments for git') as HTMLTextAreaElement
    expect(args.value).toBe('mcp-server-git')
    fireEvent.change(args, { target: { value: 'mcp-server-git\n--repository\nC:/work/repo' } })
    fireEvent.blur(args)
    await waitFor(() =>
      expect(onUpdate).toHaveBeenLastCalledWith({ ...gitServer, args: ['mcp-server-git', '--repository', 'C:/work/repo'] })
    )

    const env = screen.getByLabelText('MCP environment for git')
    fireEvent.change(env, { target: { value: 'GIT_AUTHOR_NAME=Ada\nEMPTY=' } })
    fireEvent.blur(env)
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(2))
    expect(onUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ env: expect.objectContaining({ GIT_AUTHOR_NAME: 'Ada' }) })
    )
  })

  it('writes nothing when a field is left as it was', () => {
    const onUpdate = vi.fn(async () => true)
    render(<McpServerConfig server={gitServer} status={undefined} onUpdate={onUpdate} />)
    fireEvent.blur(screen.getByLabelText('MCP command for git'))
    fireEvent.blur(screen.getByLabelText('MCP arguments for git'))
    fireEvent.blur(screen.getByLabelText('MCP server name for git'))
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('puts a field back when its save is refused', async () => {
    const onUpdate = vi.fn(async () => false)
    render(<McpServerConfig server={gitServer} status={undefined} onUpdate={onUpdate} />)
    const command = screen.getByLabelText('MCP command for git') as HTMLInputElement
    fireEvent.change(command, { target: { value: 'uv' } })
    fireEvent.blur(command)
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(command.value).toBe('uvx'))
  })

  it('keeps a bearer token in secure storage, never in the headers', async () => {
    const onUpdate = vi.fn(async () => true)
    const onAuthChanged = vi.fn()
    const server: McpServer = { ...githubServer, headers: { Authorization: 'Bearer old', 'X-Team': 'core' } }
    render(
      <McpServerConfig
        server={server}
        status={{ ...disconnected, id: 'github', name: 'GitHub' }}
        onUpdate={onUpdate}
        onAuthChanged={onAuthChanged}
      />
    )
    // The stored Authorization is not shown back as a header.
    expect((screen.getByLabelText('MCP extra headers for github') as HTMLTextAreaElement).value).toBe('X-Team=core')
    const token = screen.getByLabelText('Bearer token for github') as HTMLInputElement
    expect(token.type).toBe('password')
    fireEvent.change(token, { target: { value: 'ghp_new' } })
    fireEvent.blur(token)
    await waitFor(() => expect(bridge.mcpSetAuthToken).toHaveBeenCalledWith('github', 'ghp_new'))
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ ...server, headers: { 'X-Team': 'core' } }))
    expect(onAuthChanged).toHaveBeenCalledTimes(1)
    expect(token.value).toBe('')
  })
})

/** Settings that change when the view writes them. */
function Harness({ initial }: { initial: Settings }): JSX.Element {
  const [settings, setSettings] = useState(initial)
  const update = useCallback(async (partial: Partial<Settings>) => {
    setSettings((prev) => ({ ...prev, ...partial }))
    return { ok: true as const }
  }, [])
  return <MarketplaceView settings={settings} onUpdate={update} />
}

describe('Configuration in the detail', () => {
  const settings: Settings = { ...DEFAULT_SETTINGS, mcpServers: [gitServer] }

  it('stays collapsed until it is opened', async () => {
    installBridge({ mcpStatus: vi.fn(async () => ok({ servers: [{ ...disconnected, id: 'git', name: 'Git' }] })) })
    render(<Harness initial={settings} />)
    const toggle = await screen.findByRole('button', { name: 'Configuration' })
    const panel = document.getElementById('mcp-config-git')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.getAttribute('aria-controls')).toBe('mcp-config-git')
    expect(panel?.hasAttribute('hidden')).toBe(true)
    expect(screen.queryByLabelText('MCP command for git')).toBeNull()

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(panel?.hasAttribute('hidden')).toBe(false)
    expect(within(panel!).getByLabelText('MCP command for git')).toBeTruthy()
  })

  it('opens by itself for a failure its fields can fix, once status says so', async () => {
    installBridge({
      mcpStatus: vi.fn(async () =>
        ok({
          servers: [
            { ...disconnected, id: 'git', name: 'Git', error: 'spawn uvx EACCES', errorKind: 'config' as const }
          ]
        })
      )
    })
    render(<Harness initial={settings} />)
    const toggle = await screen.findByRole('button', { name: 'Configuration' })
    await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('true'))
    expect((await screen.findByRole('alert')).textContent).toBe('spawn uvx EACCES')
    // Closing it is the person's call, and it stays closed.
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })

  it('offers Install, Locate and Retry for a missing binary without opening anything', async () => {
    const missing = ok({
      servers: [
        {
          ...disconnected,
          id: 'git',
          name: 'Git',
          error: 'uvx (uv) was not found on PATH, so this MCP server cannot start.',
          errorKind: 'binary' as const,
          missingBinary: 'uvx',
          missingBinaryInstallUrl: 'https://docs.astral.sh/uv/getting-started/installation/'
        }
      ]
    })
    // Still missing after a retry — nothing was installed in between.
    installBridge({ mcpStatus: vi.fn(async () => missing), mcpRefresh: vi.fn(async () => missing) })
    render(<Harness initial={settings} />)
    const detail = await screen.findByRole('complementary', { name: 'Git details' })
    const install = await within(detail).findByRole('button', { name: 'Install uvx' })
    expect(within(detail).getByRole('button', { name: 'Configuration' }).getAttribute('aria-expanded')).toBe('false')
    expect(within(detail).getByText(/was not found on PATH, so this server cannot start\./)).toBeTruthy()

    fireEvent.click(install)
    await waitFor(() =>
      expect(bridge.shellOpenExternal).toHaveBeenCalledWith('https://docs.astral.sh/uv/getting-started/installation/')
    )

    fireEvent.click(within(detail).getByRole('button', { name: 'Retry' }))
    // Only the failed servers are dialled again; main clears its binary cache first.
    await waitFor(() => expect(bridge.mcpRefresh).toHaveBeenCalledWith({ workspacePath: null, failedOnly: true }))

    fireEvent.click(within(detail).getByRole('button', { name: 'Locate binary…' }))
    await waitFor(() => expect(bridge.mcpPickBinary).toHaveBeenCalledWith('uvx'))
    // The pick is saved on the server and shown where it runs from.
    expect(await within(detail).findByText('C:/tools/uv/uvx.exe')).toBeTruthy()
  })
})
