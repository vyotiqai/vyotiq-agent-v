import { describe, expect, it, afterEach, vi } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync } from 'fs'
import { fileURLToPath } from 'url'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getAppPath: () => process.cwd(),
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8')
  }
}))

import {
  collectStdioWorkspacePaths,
  connectMcpServer,
  disconnectMcpServer,
  invokeMcpTool,
  listConnectedMcpServerIdsForTests,
  mcpStdioSessionKey,
  resetMcpSessionsForTests,
  setMcpStdioWorkspace,
  shutdownMcpServers,
  syncMcpServers
} from '@main/agent/mcp'

const fixturePath = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../fixtures/mcp-echo-server.mjs'
)

const echoServer = {
  id: 'echo',
  name: 'Echo Fixture',
  enabled: true,
  transport: 'stdio' as const,
  command: process.execPath,
  args: [fixturePath],
  env: {}
}

describe('MCP workspace-scoped stdio sessions', () => {
  afterEach(async () => {
    await shutdownMcpServers()
    resetMcpSessionsForTests()
  })

  it('keeps independent stdio sessions per workspace path', async () => {
    const wsA = mkdtempSync(join(tmpdir(), 'vyotiq-mcp-a-'))
    const wsB = mkdtempSync(join(tmpdir(), 'vyotiq-mcp-b-'))
    try {
      setMcpStdioWorkspace(wsA)
      await connectMcpServer(echoServer, wsA)
      await connectMcpServer(echoServer, wsB)

      expect(listConnectedMcpServerIdsForTests()).toEqual(['echo'])

      const resultA = await invokeMcpTool(
        'echo',
        'echo',
        { message: 'workspace-a' },
        new AbortController().signal,
        undefined,
        undefined,
        wsA
      )
      const resultB = await invokeMcpTool(
        'echo',
        'echo',
        { message: 'workspace-b' },
        new AbortController().signal,
        undefined,
        undefined,
        wsB
      )
      expect(resultA.ok).toBe(true)
      expect(resultB.ok).toBe(true)
      expect(resultA.content).toContain('workspace-a')
      expect(resultB.content).toContain('workspace-b')

      await disconnectMcpServer('echo')
      expect(mcpStdioSessionKey('echo', wsA)).toContain('echo')
    } finally {
      await shutdownMcpServers()
      resetMcpSessionsForTests()
      rmSync(wsA, { recursive: true, force: true })
      rmSync(wsB, { recursive: true, force: true })
    }
  })

  it('does not borrow a parent stdio session for an explicit other cwd', async () => {
    const wsA = mkdtempSync(join(tmpdir(), 'vyotiq-mcp-parent-'))
    const wsB = mkdtempSync(join(tmpdir(), 'vyotiq-mcp-worktree-'))
    try {
      setMcpStdioWorkspace(wsA)
      await connectMcpServer(echoServer, wsA)
      const borrowed = await invokeMcpTool(
        'echo',
        'echo',
        { message: 'should-not-run' },
        new AbortController().signal,
        undefined,
        undefined,
        wsB
      )
      expect(borrowed.ok).toBe(false)
      expect(borrowed.content).toMatch(/not connected/i)
    } finally {
      await shutdownMcpServers()
      resetMcpSessionsForTests()
      rmSync(wsA, { recursive: true, force: true })
      rmSync(wsB, { recursive: true, force: true })
    }
  })

  it('does not disconnect other workspace stdio sessions when setMcpStdioWorkspace changes', async () => {
    const wsA = mkdtempSync(join(tmpdir(), 'vyotiq-mcp-swap-a-'))
    const wsB = mkdtempSync(join(tmpdir(), 'vyotiq-mcp-swap-b-'))
    try {
      setMcpStdioWorkspace(wsA)
      await syncMcpServers([echoServer])
      const first = await invokeMcpTool(
        'echo',
        'echo',
        { message: 'still-up' },
        new AbortController().signal,
        undefined,
        undefined,
        wsA
      )
      expect(first.ok).toBe(true)

      setMcpStdioWorkspace(wsB)
      const second = await invokeMcpTool(
        'echo',
        'echo',
        { message: 'still-up-after-hint' },
        new AbortController().signal,
        undefined,
        undefined,
        wsA
      )
      expect(second.ok).toBe(true)
      expect(collectStdioWorkspacePaths()).toContain(wsB)
    } finally {
      await shutdownMcpServers()
      resetMcpSessionsForTests()
      rmSync(wsA, { recursive: true, force: true })
      rmSync(wsB, { recursive: true, force: true })
    }
  })
})
