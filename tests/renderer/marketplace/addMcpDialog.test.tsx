/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MarketplaceView } from '@renderer/features/marketplace'
import { argsToLine, envToLine, lineToEnv } from '@renderer/features/marketplace/AddMcpDialog'
import { tokenizeCommand } from '@shared/utils/mcpClassify'
import {
  DEFAULT_SETTINGS,
  type DetectedMcpServer,
  type McpDetectResult,
  type Settings,
  type WorkspaceSettingsOverride
} from '@shared/ipc'

const settings: Settings = {
  ...DEFAULT_SETTINGS,
  marketplace: { registryUrl: '', remoteInstallAcked: true },
  mcpServers: []
}

const fetchServer: DetectedMcpServer = {
  id: 'mcp-fetch',
  name: 'fetch',
  transport: 'stdio',
  command: 'uvx',
  args: ['mcp-server-fetch'],
  enabled: true,
  source: 'manual'
}

function ok<T>(data: T) {
  return { ok: true as const, data }
}

function detected(partial: Partial<McpDetectResult> = {}) {
  return ok<McpDetectResult>({
    kind: 'stdio',
    confidence: 'high',
    server: fetchServer,
    warnings: [],
    duplicate: false,
    ...partial
  })
}

type Bridge = Record<string, (...args: never[]) => unknown>
let bridge: Bridge

function installBridge(overrides: Bridge = {}): void {
  bridge = {
    marketplaceBrowse: vi.fn(async () =>
      ok({
        packages: [
          {
            id: 'memory',
            name: 'Memory',
            version: '1.0.0',
            description: 'MCP memory',
            kind: 'mcp' as const,
            source: 'bundled' as const,
            installable: true,
            bundledPath: 'memory'
          }
        ]
      })
    ),
    marketplaceListInstalled: vi.fn(async () => ok({ schemaVersion: 1 as const, items: [] })),
    skillsListLocal: vi.fn(async () => ok({ skills: [] })),
    mcpStatus: vi.fn(async () => ok({ servers: [] })),
    marketplaceDetectMcp: vi.fn(async () => detected()),
    marketplaceApplyDetectedMcp: vi.fn(async () => ok({ applied: 'manual' as const, serverId: 'mcp-fetch' })),
    marketplaceScanExternalMcp: vi.fn(async () =>
      ok({ preview: [], applied: 0, skipped: 0, warnings: [], scannedPaths: [] })
    ),
    marketplaceImportExternalMcp: vi.fn(async () =>
      ok({ preview: [], applied: 1, skipped: 0, warnings: [], scannedPaths: [] })
    ),
    marketplacePickLocal: vi.fn(async () => ok(null)),
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

async function openDialog(props: Partial<Parameters<typeof MarketplaceView>[0]> = {}): Promise<HTMLElement> {
  render(<MarketplaceView settings={settings} onUpdate={vi.fn(async () => ({ ok: true as const }))} {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Add MCP server' }))
  return screen.getByRole('dialog', { name: 'Add an MCP server' })
}

function paste(dialog: HTMLElement, text: string): void {
  fireEvent.change(within(dialog).getByLabelText('Paste a URL, npm package, npx command or JSON'), {
    target: { value: text }
  })
}

const addButton = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: 'Add and connect' }) as HTMLButtonElement

describe('argument and environment lines', () => {
  it('quotes only what needs it, so the line reads back the same', () => {
    const args = ['-y', '@modelcontextprotocol/server-filesystem', 'C:/My Files', 'say "hi"']
    const line = argsToLine(args)
    expect(line).toBe(`-y @modelcontextprotocol/server-filesystem "C:/My Files" 'say "hi"'`)
    expect(tokenizeCommand(line)).toEqual(args)
  })

  it('reads KEY=value pairs back, values with spaces included', () => {
    const env = { API_BASE: 'https://example.com', EXTRA_PATH: 'C:/Program Files/uv' }
    const line = envToLine(env)
    expect(line).toBe('API_BASE=https://example.com "EXTRA_PATH=C:/Program Files/uv"')
    expect(lineToEnv(line)).toEqual(env)
  })

  it('drops tokens that are not KEY=value, and an empty line is no environment', () => {
    expect(lineToEnv('A=1 stray =nokey B=')).toEqual({ A: '1', B: '' })
    expect(lineToEnv('   ')).toBeUndefined()
  })
})

describe('Add an MCP server', () => {
  it('shows the address and transport of a remote server, and adds it without launch fields', async () => {
    installBridge({
      marketplaceDetectMcp: vi.fn(async () =>
        detected({
          kind: 'remote',
          server: { id: 'deepwiki', name: 'DeepWiki', transport: 'http', url: 'https://mcp.deepwiki.com/mcp', enabled: true }
        })
      )
    })
    const dialog = await openDialog()
    paste(dialog, 'https://mcp.deepwiki.com/mcp')
    expect(await within(dialog).findByText('Detected a remote HTTP server')).toBeTruthy()
    expect((within(dialog).getByRole('textbox', { name: 'Server URL' }) as HTMLInputElement).value).toBe(
      'https://mcp.deepwiki.com/mcp'
    )
    const transport = within(dialog).getByRole('radiogroup', { name: 'Server transport' })
    expect(within(transport).getByRole('radio', { name: 'HTTP' }).getAttribute('aria-checked')).toBe('true')
    expect(within(dialog).queryByRole('textbox', { name: 'Server command' })).toBeNull()

    fireEvent.click(within(transport).getByRole('radio', { name: 'SSE' }))
    fireEvent.click(addButton(dialog))
    await waitFor(() => expect(bridge.marketplaceApplyDetectedMcp).toHaveBeenCalledTimes(1))
    const payload = vi.mocked(bridge.marketplaceApplyDetectedMcp).mock.calls[0]![0] as unknown as {
      server: DetectedMcpServer
    }
    expect(payload.server).toEqual({
      id: 'deepwiki',
      name: 'DeepWiki',
      transport: 'sse',
      url: 'https://mcp.deepwiki.com/mcp',
      enabled: true
    })
  })

  it('lists every server in a pasted config and imports the ones left ticked', async () => {
    const memory: DetectedMcpServer = { ...fetchServer, id: 'memory-local', name: 'memory', command: 'npx', args: ['-y', 'server-memory'] }
    installBridge({
      marketplaceDetectMcp: vi.fn(async () => detected({ kind: 'json' })),
      marketplaceScanExternalMcp: vi.fn(async () =>
        ok({ preview: [fetchServer, memory], applied: 0, skipped: 0, warnings: [], scannedPaths: [] })
      )
    })
    const dialog = await openDialog()
    const json = JSON.stringify({ mcpServers: { fetch: { command: 'uvx' }, memory: { command: 'npx' } } })
    paste(dialog, json)
    expect(await within(dialog).findByText('Found 2 servers')).toBeTruthy()
    expect(bridge.marketplaceScanExternalMcp).toHaveBeenCalledWith({ json })
    // Each row says what it runs.
    expect(within(dialog).getByText('npx -y server-memory')).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'Import 2' })).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Import fetch' }))
    expect(within(dialog).queryByRole('button', { name: 'Import 2' })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import 1' }))
    await waitFor(() =>
      expect(bridge.marketplaceImportExternalMcp).toHaveBeenCalledWith({
        mode: 'merge',
        selectedIds: ['memory-local'],
        servers: [memory]
      })
    )
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add an MCP server' })).toBeNull())
  })

  it('keeps the field typeable while a pasted config is being read', async () => {
    let finishScan: () => void = () => {}
    installBridge({
      marketplaceDetectMcp: vi.fn(async () => detected({ kind: 'json' })),
      marketplaceScanExternalMcp: vi.fn(
        () =>
          new Promise((resolve) => {
            finishScan = () => resolve(ok({ preview: [], applied: 0, skipped: 0, warnings: [], scannedPaths: [] }))
          })
      )
    })
    const dialog = await openDialog()
    const field = within(dialog).getByLabelText('Paste a URL, npm package, npx command or JSON') as HTMLTextAreaElement
    paste(dialog, '{"mcpServers":{"fetch":{"command":"uvx"}}}')
    await waitFor(() => expect(bridge.marketplaceScanExternalMcp).toHaveBeenCalled())
    // The scan is out, and the marketplace is busy — the field is not.
    expect(field.disabled).toBe(false)
    finishScan()
  })

  it('waits for Detect before cloning a git URL', async () => {
    installBridge({
      marketplaceDetectMcp: vi.fn(async () =>
        detected({
          kind: 'git',
          server: undefined,
          install: { source: 'git', target: 'https://github.com/owner/repo' }
        })
      )
    })
    const dialog = await openDialog()
    paste(dialog, 'https://github.com/owner/repo')
    expect(await within(dialog).findByText('A git repository')).toBeTruthy()
    // Give the debounce a chance to fire; a git URL must not be detected on its own.
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(bridge.marketplaceDetectMcp).not.toHaveBeenCalled()
    expect(addButton(dialog).disabled).toBe(true)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Detect' }))
    await waitFor(() =>
      expect(bridge.marketplaceDetectMcp).toHaveBeenCalledWith({ input: 'https://github.com/owner/repo' })
    )
    expect(await within(dialog).findByText('Detected a git repository')).toBeTruthy()
    await waitFor(() => expect(addButton(dialog).disabled).toBe(false))
    fireEvent.click(addButton(dialog))
    await waitFor(() =>
      expect(bridge.marketplaceApplyDetectedMcp).toHaveBeenCalledWith({
        install: { source: 'git', target: 'https://github.com/owner/repo' },
        overwrite: false
      })
    )
  })

  it('points to the catalog package that runs the same server', async () => {
    installBridge({
      marketplaceDetectMcp: vi.fn(async () => detected({ catalogMatch: { id: 'memory', name: 'Memory' } }))
    })
    const dialog = await openDialog()
    paste(dialog, 'npx -y @modelcontextprotocol/server-memory')
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Memory' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add an MCP server' })).toBeNull())
    const row = document.querySelector('[data-extension-key="mcp:memory"]')!
    expect(within(row as HTMLElement).getByRole('button', { current: true })).toBeTruthy()
    expect(bridge.marketplaceApplyDetectedMcp).not.toHaveBeenCalled()
  })

  it('replaces a server already added only when asked to', async () => {
    installBridge({ marketplaceDetectMcp: vi.fn(async () => detected({ duplicate: true })) })
    const dialog = await openDialog()
    paste(dialog, 'uvx mcp-server-fetch')
    // The status line says so; the checkbox below it is the way through.
    expect(await within(dialog).findByText(/· already added/)).toBeTruthy()
    expect(addButton(dialog).disabled).toBe(true)
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Replace the server already added with this id' }))
    expect(addButton(dialog).disabled).toBe(false)
    fireEvent.click(addButton(dialog))
    await waitFor(() =>
      expect(bridge.marketplaceApplyDetectedMcp).toHaveBeenCalledWith(expect.objectContaining({ overwrite: true }))
    )
  })

  it('adds a server off everywhere and on in this workspace when asked', async () => {
    const onSetSettingsOverride = vi.fn(
      async (_path: string, _override: WorkspaceSettingsOverride | null) => ({ ok: true as const })
    )
    const dialog = await openDialog({ activeWorkspacePath: 'C:/work/app', onSetSettingsOverride })
    paste(dialog, 'uvx mcp-server-fetch')
    await within(dialog).findByText('Detected a stdio server')
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Available in this workspace only' }))
    fireEvent.click(addButton(dialog))
    await waitFor(() =>
      expect(bridge.marketplaceApplyDetectedMcp).toHaveBeenCalledWith(
        expect.objectContaining({ server: expect.objectContaining({ id: 'mcp-fetch', enabled: false }) })
      )
    )
    await waitFor(() =>
      expect(onSetSettingsOverride).toHaveBeenCalledWith('C:/work/app', {
        useOverride: false,
        marketplaceOverrides: { mcp: { 'mcp-fetch': true } }
      })
    )
  })

  it('cannot scope a server to a workspace when none is open', async () => {
    const dialog = await openDialog()
    paste(dialog, 'uvx mcp-server-fetch')
    await within(dialog).findByText('Detected a stdio server')
    const only = within(dialog).getByRole('checkbox', { name: 'Available in this workspace only' }) as HTMLInputElement
    expect(only.disabled).toBe(true)
  })

  it('says what went wrong when a paste cannot be read', async () => {
    installBridge({
      marketplaceDetectMcp: vi.fn(async () => ({ ok: false as const, error: 'Could not tell what this is.' }))
    })
    const dialog = await openDialog()
    paste(dialog, 'something odd')
    expect(await within(dialog).findByText('Could not tell what this is.')).toBeTruthy()
    expect(addButton(dialog).disabled).toBe(true)
  })

  it('reads the Cursor and Claude configs as soon as the import view opens', async () => {
    installBridge({
      marketplaceScanExternalMcp: vi.fn(async () =>
        ok({ preview: [fetchServer], applied: 0, skipped: 0, warnings: [], scannedPaths: [] })
      )
    })
    const dialog = await openDialog()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import from Cursor or Claude…' }))
    expect(within(dialog).getByRole('heading', { name: 'Import MCP servers' })).toBeTruthy()
    await waitFor(() => expect(bridge.marketplaceScanExternalMcp).toHaveBeenCalledWith({}))
    expect(await within(dialog).findByRole('checkbox', { name: 'Import fetch' })).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import 1' }))
    await waitFor(() =>
      expect(bridge.marketplaceImportExternalMcp).toHaveBeenCalledWith({
        mode: 'merge',
        selectedIds: ['mcp-fetch'],
        servers: [fetchServer]
      })
    )
  })
})
