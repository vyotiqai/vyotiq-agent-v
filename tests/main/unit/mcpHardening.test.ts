/**
 * Three defences that were present in the code but not actually working:
 * argument validation (looked up under the wrong key, so it never ran),
 * per-server schema isolation (one cache entry per bare tool name), and a
 * guard on tool names before they reach a provider.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'

const ISOLATED_USER_DATA = mkdtempSync(join(tmpdir(), 'vyotiq-mcp-hardening-'))

vi.mock('electron', () => ({
  app: {
    getPath: () => ISOLATED_USER_DATA,
    getAppPath: () => process.cwd(),
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8')
  },
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false, on: () => undefined }
}))
vi.mock('@main/app/window', () => ({ getMainWindow: () => null }))
vi.mock('@main/workspace/workspaces', () => ({
  readWorkspacesState: () => ({ openPaths: [], activePath: null, workspaces: [] }),
  findWorkspaceSettingsOverride: () => undefined
}))

import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  invokeMcpTool,
  isSupportedMcpToolName,
  listMcpToolDefinitions,
  mcpToolName,
  registerMcpSessionForTests,
  resetMcpSessionsForTests,
  setMcpStdioWorkspace,
  shutdownMcpServers,
  syncMcpServers
} from '@main/agent/mcp'

const workspace = process.cwd()
const signal = (): AbortSignal => new AbortController().signal

function mockClient(callTool: ReturnType<typeof vi.fn>): Parameters<
  typeof registerMcpSessionForTests
>[1] {
  return {
    callTool,
    listTools: vi.fn(async () => ({ tools: [] })),
    listResources: vi.fn(async () => ({ resources: [] })),
    readResource: vi.fn(async () => ({ contents: [] })),
    listPrompts: vi.fn(async () => ({ prompts: [] })),
    getPrompt: vi.fn(async () => ({ messages: [] })),
    getServerCapabilities: vi.fn(() => ({})),
    close: vi.fn(async () => undefined)
  } as unknown as Client
}

const okResult = { content: [{ type: 'text', text: 'done' }] }

describe('isSupportedMcpToolName', () => {
  it('accepts what every provider accepts and rejects the rest', () => {
    expect(isSupportedMcpToolName('mcp__github__create_issue')).toBe(true)
    expect(isSupportedMcpToolName('mcp__a__b-c_1')).toBe(true)

    // A provider answers these with a 400 for the whole request.
    expect(isSupportedMcpToolName('mcp__srv__dotted.name')).toBe(false)
    expect(isSupportedMcpToolName('mcp__srv__has space')).toBe(false)
    expect(isSupportedMcpToolName('mcp__srv__unicode✨')).toBe(false)
    expect(isSupportedMcpToolName(`mcp__srv__${'x'.repeat(200)}`)).toBe(false)
    expect(isSupportedMcpToolName('')).toBe(false)
  })
})

describe('MCP argument validation', () => {
  afterEach(() => {
    resetMcpSessionsForTests()
  })

  it('rejects arguments that do not match the declared schema', async () => {
    const callTool = vi.fn(async () => okResult)
    registerMcpSessionForTests('alpha', mockClient(callTool), [
      {
        name: mcpToolName('alpha', 'search'),
        description: 'Search',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query']
        }
      }
    ])

    const bad = await invokeMcpTool('alpha', 'search', {}, signal())
    expect(bad.ok).toBe(false)
    expect(bad.content).toContain('Invalid arguments for MCP tool')
    // The whole point is catching it before a paid round-trip.
    expect(callTool).not.toHaveBeenCalled()

    const good = await invokeMcpTool('alpha', 'search', { query: 'hello' }, signal())
    expect(good.ok).toBe(true)
    expect(callTool).toHaveBeenCalledTimes(1)
  })

  it('keeps each server on its own schema for a shared tool name', async () => {
    const alphaCall = vi.fn(async () => okResult)
    const betaCall = vi.fn(async () => okResult)

    registerMcpSessionForTests('alpha', mockClient(alphaCall), [
      {
        name: mcpToolName('alpha', 'search'),
        description: 'Search',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query']
        }
      }
    ])
    registerMcpSessionForTests('beta', mockClient(betaCall), [
      {
        name: mcpToolName('beta', 'search'),
        description: 'Search',
        parameters: {
          type: 'object',
          properties: { limit: { type: 'number' } },
          required: ['limit']
        }
      }
    ])

    // Compile alpha's schema first; a bare-name cache would then reuse it.
    expect((await invokeMcpTool('alpha', 'search', { query: 'x' }, signal())).ok).toBe(true)

    const betaOk = await invokeMcpTool('beta', 'search', { limit: 5 }, signal())
    expect(betaOk.ok).toBe(true)

    const betaBad = await invokeMcpTool('beta', 'search', { query: 'x' }, signal())
    expect(betaBad.ok).toBe(false)
    expect(betaBad.content).toContain('Invalid arguments for MCP tool')
  })
})

describe('tool names a provider would reject', () => {
  afterEach(async () => {
    await shutdownMcpServers()
    resetMcpSessionsForTests()
  })

  it('are dropped at connect instead of breaking every request', async () => {
    resetMcpSessionsForTests()
    setMcpStdioWorkspace(workspace)
    await syncMcpServers([
      {
        id: 'odd',
        name: 'Odd Names',
        enabled: true,
        transport: 'stdio' as const,
        command: process.execPath,
        args: [
          join(
            fileURLToPath(new URL('.', import.meta.url)),
            '../../fixtures/mcp-odd-names-server.mjs'
          )
        ],
        env: {}
      }
    ])

    const exposed = listMcpToolDefinitions().map((t) => t.name)
    expect(exposed).toContain('mcp__odd__fine_tool')
    expect(exposed.every((n) => isSupportedMcpToolName(n))).toBe(true)
    expect(exposed.some((n) => n.includes('dotted.name'))).toBe(false)
    expect(exposed.some((n) => n.length > 128)).toBe(false)
  }, 60_000)
})
