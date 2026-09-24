import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getAppPath: () => process.cwd(),
    isPackaged: false
  }
}))

vi.mock('@main/settings/settings', () => {
  let settings = {
    marketplace: { registryUrl: '', remoteInstallAcked: true },
    mcpServers: [] as Array<Record<string, unknown>>
  }
  return {
    getSettings: () => settings,
    setSettings: (partial: Record<string, unknown>) => {
      settings = { ...settings, ...partial }
      if (partial.mcpServers) {
        settings.mcpServers = partial.mcpServers as Array<Record<string, unknown>>
      }
    },
    enqueueSettingsMutation: async (fn: () => unknown) => fn()
  }
})

vi.mock('@main/workspace/workspaces', () => ({
  getWorkspaces: () => ({ activePath: null, openPaths: [], recentPaths: [] })
}))

import {
  classifyMcpInput,
  parseExternalMcpConfig,
  detectFromGitRepo,
  detectMcpInput,
  synthesizeVyotiqMcpManifest,
  applyDetectedManualMcp,
  mcpServerDedupeKey
} from '@main/marketplace/mcpImport'
import { getSettings, setSettings } from '@main/settings/settings'

describe('classifyMcpInput', () => {
  it('classifies GitHub URLs as git', () => {
    expect(classifyMcpInput('https://github.com/modelcontextprotocol/servers')).toBe('git')
  })

  it('classifies remote MCP URLs', () => {
    expect(classifyMcpInput('https://mcp.example.com/sse')).toBe('remote')
  })

  it('classifies stdio commands', () => {
    expect(classifyMcpInput('uvx mcp-server-fetch')).toBe('stdio')
    expect(classifyMcpInput('npx -y @modelcontextprotocol/server-memory')).toBe('stdio')
  })

  it('classifies npm package names', () => {
    expect(classifyMcpInput('@modelcontextprotocol/server-filesystem')).toBe('npm')
    expect(classifyMcpInput('@modelcontextprotocol/server-memory')).toBe('npm')
  })

  it('does not treat bare package-with-serve as stdio without a launcher', () => {
    expect(classifyMcpInput('@scope/pkg serve')).toBe('unknown')
  })

  it('classifies launcher + serve as stdio', () => {
    expect(classifyMcpInput('uvx mcp-server-fetch')).toBe('stdio')
  })

  it('classifies Cursor-style JSON', () => {
    expect(
      classifyMcpInput(JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['-y', 'x'] } } }))
    ).toBe('json')
  })
})

describe('parseExternalMcpConfig', () => {
  it('parses Cursor mcpServers objects', () => {
    const servers = parseExternalMcpConfig(
      JSON.stringify({
        mcpServers: {
          memory: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-memory']
          },
          remote: { url: 'https://mcp.example.com/mcp', transport: 'http' }
        }
      })
    )
    expect(servers).toHaveLength(2)
    expect(servers[0]?.command).toBe('npx')
    expect(servers.find((s) => s.url)?.url).toBe('https://mcp.example.com/mcp')
  })

  it('preserves explicit display name on entries', () => {
    const servers = parseExternalMcpConfig(
      JSON.stringify({
        mcpServers: {
          'memory-server': {
            name: 'Memory Server',
            command: 'npx',
            args: ['-y', 'x']
          }
        }
      })
    )
    expect(servers[0]?.name).toBe('Memory Server')
    expect(servers[0]?.id).toBe('memory-server')
  })
})

describe('detectFromGitRepo', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vyotiq-mcp-detect-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('detects from README uvx serve line', () => {
    writeFileSync(
      join(root, 'README.md'),
      `# Demo\n\n\`\`\`bash\nuvx mcp-server-fetch\n\`\`\`\n`
    )
    const result = detectFromGitRepo(root)
    expect(result.server.command).toBe('uvx')
    expect(result.server.args).toEqual(['mcp-server-fetch'])
    expect(result.confidence).not.toBe('low')
  })

  it('detects from .cursor/mcp.json', () => {
    mkdirSync(join(root, '.cursor'), { recursive: true })
    writeFileSync(
      join(root, '.cursor', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          demo: { command: 'npx', args: ['-y', 'demo-mcp'] }
        }
      })
    )
    const result = detectFromGitRepo(root)
    expect(result.server.command).toBe('npx')
    expect(result.confidence).toBe('high')
  })

  it('synthesizes vyotiq.mcp.json for install fallback', () => {
    writeFileSync(
      join(root, 'README.md'),
      '```\nuvx my-mcp serve\n```\n'
    )
    expect(synthesizeVyotiqMcpManifest(root)).toBe(true)
    expect(detectFromGitRepo(root).vyotiq).toBe(true)
  })
})

describe('detectMcpInput git preview clone guardrails', () => {
  beforeEach(() => {
    setSettings({
      marketplace: { registryUrl: '', remoteInstallAcked: true },
      mcpServers: []
    })
  })

  it('rejects file: clone URLs before any git invocation', async () => {
    const result = await detectMcpInput({ input: 'file:///tmp/repo.git' })
    expect(result.kind).toBe('git')
    expect(result.confidence).toBe('low')
    expect(result.warnings.join('\n')).toMatch(/scheme is not allowed/i)
  })

  it('rejects git: scheme clone URLs', async () => {
    const result = await detectMcpInput({ input: 'git://gitlab.com/org/repo.git' })
    expect(result.kind).toBe('git')
    expect(result.confidence).toBe('low')
    expect(result.warnings.join('\n')).toMatch(/scheme not allowed/i)
  })

  it('points npm package detection at installing from Registry and trust', async () => {
    const result = await detectMcpInput({ input: '@modelcontextprotocol/server-memory' })
    expect(result.kind).toBe('npm')
    expect(result.warnings.join('\n')).toMatch(/Registry and trust/)
    expect(result.warnings.join('\n')).not.toMatch(/Advanced/)
  })
})

describe('detectMcpInput before the install acknowledgement', () => {
  beforeEach(() => {
    setSettings({
      marketplace: { registryUrl: '', remoteInstallAcked: false },
      mcpServers: []
    })
  })

  it('parses a URL, a package name and a JSON config as they are pasted', async () => {
    const remote = await detectMcpInput({ input: 'https://mcp.example.com/mcp' })
    expect(remote).toMatchObject({ kind: 'remote', confidence: 'high' })
    expect(remote.server?.url).toBe('https://mcp.example.com/mcp')

    const npm = await detectMcpInput({ input: '@modelcontextprotocol/server-memory' })
    expect(npm.server).toMatchObject({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] })

    const json = await detectMcpInput({
      input: JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['-y', 'x'] } } })
    })
    expect(json).toMatchObject({ kind: 'json', confidence: 'high' })
  })

  it('still will not clone a git URL', async () => {
    const result = await detectMcpInput({ input: 'https://github.com/org/repo' })
    expect(result).toMatchObject({ kind: 'git', confidence: 'low' })
    expect(result.server).toBeUndefined()
    expect(result.warnings.join('\n')).toMatch(/Registry and trust/)
  })

  it('still refuses to add what it parsed', () => {
    expect(() =>
      applyDetectedManualMcp({
        server: {
          id: 'mcp-remote',
          name: 'Remote',
          transport: 'http',
          url: 'https://mcp.example.com/mcp',
          enabled: true,
          source: 'manual'
        }
      })
    ).toThrow(/Acknowledge/i)
  })
})

describe('detectMcpInput catalog match', () => {
  beforeEach(() => {
    setSettings({
      marketplace: { registryUrl: '', remoteInstallAcked: true },
      mcpServers: []
    })
  })

  it('names the bundled package that serves the same endpoint', async () => {
    // The bundled GitHub manifest ends its URL with a slash; a pasted one need not.
    const result = await detectMcpInput({ input: 'https://api.githubcopilot.com/mcp' })
    expect(result.catalogMatch).toEqual({ id: 'github', name: 'GitHub' })
  })

  it('matches a launcher line by the package it runs, whatever the version pin', async () => {
    const result = await detectMcpInput({ input: 'npx -y @playwright/mcp@1.2.3' })
    expect(result.catalogMatch?.id).toBe('playwright')
    const uvx = await detectMcpInput({ input: 'uvx --with "mcp<2" mcp-server-fetch' })
    expect(uvx.catalogMatch?.id).toBe('fetch')
  })

  it('does not match a different server on the same host or launcher', async () => {
    expect((await detectMcpInput({ input: 'https://api.githubcopilot.com/other' })).catalogMatch).toBeUndefined()
    expect((await detectMcpInput({ input: 'npx -y @scope/unrelated-mcp' })).catalogMatch).toBeUndefined()
    // Sentry's bundled server is the hosted one; its npm package is a different launch.
    expect((await detectMcpInput({ input: 'npx -y @sentry/mcp-server@latest' })).catalogMatch).toBeUndefined()
  })
})

describe('detectMcpInput names a pasted launcher line', () => {
  beforeEach(() => {
    setSettings({
      marketplace: { registryUrl: '', remoteInstallAcked: true },
      mcpServers: []
    })
  })

  it('by the package it runs, past the runner flags and the version pin', async () => {
    const result = await detectMcpInput({ input: 'npx -y @sentry/mcp-server@latest' })
    expect(result.server).toMatchObject({
      name: '@sentry/mcp-server',
      command: 'npx',
      args: ['-y', '@sentry/mcp-server@latest']
    })
    expect(result.server?.id).toMatch(/^mcp-sentry-mcp-server-/)

    const uvx = await detectMcpInput({ input: 'uvx --with "mcp<2" mcp-server-fetch' })
    expect(uvx.server?.name).toBe('mcp-server-fetch')
  })

  it('never by a flag, whatever the command', async () => {
    const result = await detectMcpInput({ input: 'node --inspect server-main' })
    expect(result.server?.name).toBe('server-main')
  })

  it('keeps the package name for an npm paste, and ids it by the package', async () => {
    const result = await detectMcpInput({ input: '@modelcontextprotocol/server-memory' })
    expect(result.server?.name).toBe('@modelcontextprotocol/server-memory')
    expect(result.server?.id).toMatch(/^mcp-modelcontextprotocol-server-memory-/)
  })
})

describe('applyDetectedManualMcp', () => {
  beforeEach(() => {
    setSettings({
      marketplace: { registryUrl: '', remoteInstallAcked: true },
      mcpServers: []
    })
  })

  it('adds a stdio server and dedupes by fingerprint', () => {
    const first = applyDetectedManualMcp({
      server: {
        id: 'mcp-a',
        name: 'A',
        transport: 'stdio',
        command: 'uvx',
        args: ['tool', 'serve'],
        enabled: true,
        source: 'manual'
      }
    })
    expect(first.applied).toBe('manual')
    expect(getSettings().mcpServers).toHaveLength(1)
    expect(() =>
      applyDetectedManualMcp({
        server: {
          id: 'mcp-b',
          name: 'B',
          transport: 'stdio',
          command: 'uvx',
          args: ['tool', 'serve'],
          enabled: true,
          source: 'manual'
        }
      })
    ).toThrow(/already configured/)
  })

  it('mcpServerDedupeKey distinguishes urls', () => {
    expect(
      mcpServerDedupeKey({ id: '1', transport: 'http', url: 'https://a.example/mcp' })
    ).not.toBe(
      mcpServerDedupeKey({ id: '2', transport: 'http', url: 'https://b.example/mcp' })
    )
  })
})

describe('scanExternalMcpConfigs with a pasted config', () => {
  it('lists every server in it without reading the default paths', async () => {
    const { scanExternalMcpConfigs } = await import('@main/marketplace/mcpImport')
    const result = scanExternalMcpConfigs({
      json: JSON.stringify({
        mcpServers: {
          fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
          docs: { url: 'https://mcp.example.com/mcp' }
        }
      })
    })
    expect(result.preview.map((s) => s.id).sort()).toEqual(['docs', 'fs'])
    expect(result.scannedPaths).toEqual([])
  })

  it('says why a pasted config could not be read', async () => {
    const { scanExternalMcpConfigs } = await import('@main/marketplace/mcpImport')
    const result = scanExternalMcpConfigs({ json: '{ not json' })
    expect(result.preview).toEqual([])
    expect(result.warnings.length).toBeGreaterThan(0)
  })
})

describe('importExternalMcpServers name preservation', () => {
  beforeEach(() => {
    setSettings({
      marketplace: { registryUrl: '', remoteInstallAcked: true },
      mcpServers: []
    })
  })

  it('imports servers payload with display names intact', async () => {
    const { importExternalMcpServers } = await import('@main/marketplace/mcpImport')
    const result = await importExternalMcpServers({
      mode: 'merge',
      servers: [
        {
          id: 'memory-server',
          name: 'Memory Server',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'x'],
          enabled: true,
          source: 'manual'
        }
      ]
    })
    expect(result.applied).toBe(1)
    expect(getSettings().mcpServers[0]?.name).toBe('Memory Server')
  })

  it('rejects remote import without ack', async () => {
    setSettings({
      marketplace: { registryUrl: '', remoteInstallAcked: false },
      mcpServers: []
    })
    const { importExternalMcpServers } = await import('@main/marketplace/mcpImport')
    await expect(
      importExternalMcpServers({
        mode: 'merge',
        servers: [
          {
            id: 'remote-x',
            name: 'Remote',
            transport: 'http',
            url: 'https://mcp.example.com/mcp',
            enabled: true,
            source: 'manual'
          }
        ]
      })
    ).rejects.toThrow(/Acknowledge marketplace|Acknowledge remote/i)
  })
})
