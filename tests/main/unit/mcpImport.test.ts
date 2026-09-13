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

  it('points npm package detection at Marketplace Install npm', async () => {
    const result = await detectMcpInput({ input: '@modelcontextprotocol/server-memory' })
    expect(result.kind).toBe('npm')
    expect(result.warnings.join('\n')).toMatch(/Marketplace → Install npm/)
    expect(result.warnings.join('\n')).not.toMatch(/Advanced/)
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
