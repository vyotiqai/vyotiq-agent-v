import { describe, expect, it, afterEach, vi } from 'vitest'
import { delimiter, join } from 'path'
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
  },
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false, on: () => undefined }
}))

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null
}))

import {
  connectMcpServer,
  disconnectMcpServer,
  invokeMcpTool,
  listConnectedMcpServerIdsForTests,
  listMcpToolDefinitions,
  mcpToolName,
  getMcpServerStatus,
  gitMcpNotARepoMessage,
  isGitMcpNotARepoError,
  refreshMcpServers,
  retryFailedMcpServers,
  resetMcpSessionsForTests,
  setMcpStdioWorkspace,
  shutdownMcpServers,
  syncMcpServers,
  buildMcpChildEnv,
  friendlyMcpOAuthError
} from '@main/agent/mcp'
import { executeTool } from '@main/agent/tools'

const fixturePath = join(fileURLToPath(new URL('.', import.meta.url)), '../../fixtures/mcp-echo-server.mjs')
const slowFixturePath = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../fixtures/mcp-slow-echo-server.mjs'
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

describe('MCP stdio integration', () => {
  afterEach(async () => {
    await shutdownMcpServers()
    resetMcpSessionsForTests()
  })

  it('scrubs parent API keys from MCP child env unless opted in via server.env', () => {
    const env = buildMcpChildEnv(
      { CUSTOM_OK: '1' },
      {
        PATH: '/usr/bin',
        OPENAI_API_KEY: 'sk-secret',
        ANTHROPIC_API_KEY: 'sk-anth',
        CUSTOM_OK: 'from-parent'
      }
    )
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.CUSTOM_OK).toBe('1')
    // mcpSearchPath appends the fallback bin dirs on POSIX, so assert the
    // parent's PATH still leads rather than pinning the whole string.
    expect(env.PATH?.split(delimiter)[0]).toBe('/usr/bin')
    if (process.platform === 'win32') {
      expect(env.PYTHONIOENCODING).toBe('utf-8')
    }
  })

  it('blocks process-control keys from server.env overlay', () => {
    const env = buildMcpChildEnv(
      {
        PATH: '/evil',
        NODE_OPTIONS: '--require evil',
        PYTHONPATH: '/evil',
        SAFE_TOKEN: 'ok'
      },
      { PATH: '/usr/bin' }
    )
    // The overlay's PATH must be ignored entirely: the parent's entry leads and
    // "/evil" never appears, on any platform.
    expect(env.PATH?.split(delimiter)[0]).toBe('/usr/bin')
    expect(env.PATH?.split(delimiter)).not.toContain('/evil')
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.PYTHONPATH).toBeUndefined()
    expect(env.SAFE_TOKEN).toBe('ok')
  })

  it('connects, lists tools, invokes echo, and disconnects', async () => {
    await connectMcpServer(echoServer)

    const tools = listMcpToolDefinitions()
    expect(tools.some((t) => t.name === mcpToolName('echo', 'echo'))).toBe(true)

    const result = await invokeMcpTool(
      'echo',
      'echo',
      { message: 'hello-mcp' },
      new AbortController().signal
    )
    expect(result.ok).toBe(true)
    expect(result.content).toContain('hello-mcp')

    await disconnectMcpServer('echo')
    const after = await invokeMcpTool('echo', 'echo', {}, new AbortController().signal)
    expect(after.ok).toBe(false)
    expect(after.content).toMatch(/not connected/i)
  })

  it('routes namespaced MCP tools through executeTool', async () => {
    await connectMcpServer(echoServer)

    const name = mcpToolName('echo', 'echo')
    const result = await executeTool(
      name,
      JSON.stringify({ message: 'via-executeTool' }),
      '/tmp',
      new AbortController().signal
    )
    expect(result.ok).toBe(true)
    expect(result.content).toContain('via-executeTool')
  })

  it('rejects MCP tool args that fail the server inputSchema locally', async () => {
    await connectMcpServer(echoServer)
    const name = mcpToolName('echo', 'echo')
    const result = await executeTool(
      name,
      JSON.stringify({ message: 123 }),
      '/tmp',
      new AbortController().signal
    )
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/string|message/i)
  })

  it('aborts in-flight MCP tool calls when the run signal is cancelled', async () => {
    await connectMcpServer({
      id: 'slow',
      name: 'Slow Echo',
      enabled: true,
      command: process.execPath,
      args: [slowFixturePath]
    })

    const controller = new AbortController()
    const invokePromise = invokeMcpTool(
      'slow',
      'slow_echo',
      { message: 'too-slow' },
      controller.signal
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    controller.abort()

    await expect(invokePromise).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('syncMcpServers', () => {
  afterEach(async () => {
    await shutdownMcpServers()
    resetMcpSessionsForTests()
  })

  it('connects enabled servers and exposes their tools', async () => {
    await syncMcpServers([echoServer])
    expect(listConnectedMcpServerIdsForTests()).toEqual(['echo'])
    expect(listMcpToolDefinitions().some((t) => t.name === mcpToolName('echo', 'echo'))).toBe(
      true
    )
  })

  it('disconnects servers removed from the enabled set', async () => {
    await syncMcpServers([echoServer])
    await syncMcpServers([{ ...echoServer, enabled: false }])
    expect(listConnectedMcpServerIdsForTests()).toEqual([])
    expect(listMcpToolDefinitions()).toEqual([])
  })

  it('is idempotent for already-connected servers', async () => {
    await syncMcpServers([echoServer])
    await syncMcpServers([echoServer])
    expect(listConnectedMcpServerIdsForTests()).toEqual(['echo'])
    const result = await invokeMcpTool(
      'echo',
      'echo',
      { message: 'still-up' },
      new AbortController().signal
    )
    expect(result.ok).toBe(true)
    expect(result.content).toContain('still-up')
  })

  it('refreshMcpServers reconnects after disconnecting (does not skip via fingerprint)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vyotiq-mcp-refresh-'))
    try {
      setMcpStdioWorkspace(ws)
      await syncMcpServers([echoServer])
      expect(listConnectedMcpServerIdsForTests()).toEqual(['echo'])

      const statuses = await refreshMcpServers([echoServer])
      expect(listConnectedMcpServerIdsForTests()).toEqual(['echo'])
      expect(statuses[0]?.connected).toBe(true)
      expect(statuses[0]?.error).toBeUndefined()

      const result = await invokeMcpTool(
        'echo',
        'echo',
        { message: 'after-refresh' },
        new AbortController().signal,
        undefined,
        undefined,
        ws
      )
      expect(result.ok).toBe(true)
      expect(result.content).toContain('after-refresh')
    } finally {
      await shutdownMcpServers()
      resetMcpSessionsForTests()
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('survives connect failures without leaving partial sessions', async () => {
    await syncMcpServers([
      {
        id: 'bad',
        name: 'Bad',
        enabled: true,
        command: 'vyotiq-nonexistent-mcp-command',
        args: []
      }
    ])
    expect(listConnectedMcpServerIdsForTests()).toEqual([])
    expect(listMcpToolDefinitions()).toEqual([])
  })

  it('reports connect errors via getMcpServerStatus', async () => {
    await syncMcpServers([
      {
        id: 'bad',
        name: 'Bad',
        enabled: true,
        command: 'vyotiq-nonexistent-mcp-command',
        args: []
      }
    ])
    const status = getMcpServerStatus([
      {
        id: 'bad',
        name: 'Bad',
        enabled: true,
        command: 'vyotiq-nonexistent-mcp-command',
        args: []
      }
    ])
    expect(status[0]?.connected).toBe(false)
    expect(status[0]?.error).toBeTruthy()
  })

  it('does not re-attempt a failed connect within the cooldown window', async () => {
    const bad = {
      id: 'bad-cooldown',
      name: 'Bad',
      enabled: true,
      command: 'vyotiq-nonexistent-mcp-command',
      args: [] as string[]
    }
    await syncMcpServers([bad])
    const first = getMcpServerStatus([bad])[0]?.error
    expect(first).toBeTruthy()

    // Second sync should skip the spawn (same config, within cooldown) and keep the error.
    await syncMcpServers([bad])
    expect(getMcpServerStatus([bad])[0]?.error).toBe(first)
  })

  it('forceRetryFailures clears cooldown and re-attempts connect', async () => {
    const bad = {
      id: 'bad-force-retry',
      name: 'Bad',
      enabled: true,
      command: 'vyotiq-nonexistent-mcp-command-force',
      args: [] as string[]
    }
    await syncMcpServers([bad])
    const first = getMcpServerStatus([bad])[0]?.error
    expect(first).toBeTruthy()

    await syncMcpServers([bad], { forceRetryFailures: true })
    const second = getMcpServerStatus([bad])[0]?.error
    expect(second).toBeTruthy()
    // Re-attempted (error string may match) but status still disconnected.
    expect(getMcpServerStatus([bad])[0]?.connected).toBe(false)
  })

  it('retryFailedMcpServers retries the failed server and keeps a live call running', async () => {
    const slow = {
      id: 'slow-live',
      name: 'Slow Echo',
      enabled: true,
      transport: 'stdio' as const,
      command: process.execPath,
      args: [slowFixturePath]
    }
    const bad = {
      id: 'bad-retry-only',
      name: 'Bad',
      enabled: true,
      command: 'vyotiq-nonexistent-mcp-command-retry',
      args: [] as string[]
    }
    await syncMcpServers([slow, bad])
    expect(listConnectedMcpServerIdsForTests()).toEqual(['slow-live'])
    expect(getMcpServerStatus([bad])[0]?.error).toBeTruthy()

    // Refresh would disconnect this session and fail the call; a retry of
    // the failures only must leave it running.
    const call = invokeMcpTool('slow-live', 'slow_echo', { message: 'kept' }, new AbortController().signal)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const statuses = await retryFailedMcpServers([slow, bad])

    const result = await call
    expect(result.ok).toBe(true)
    expect(result.content).toContain('kept')
    expect(statuses.find((s) => s.id === 'slow-live')?.connected).toBe(true)
    expect(statuses.find((s) => s.id === 'bad-retry-only')?.error).toBeTruthy()
  })

  it('skips spawning Git MCP when workspace is not a git repo', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'vyotiq-git-mcp-'))
    try {
      setMcpStdioWorkspace(workspace)
      const gitServer = {
        id: 'git',
        name: 'Git',
        enabled: true,
        transport: 'stdio' as const,
        // Would fail loudly if spawn were attempted (uvx may not exist / would exit).
        command: 'vyotiq-should-not-spawn-git-mcp',
        args: ['mcp-server-git', '--repository', '.']
      }
      await syncMcpServers([gitServer])
      expect(listConnectedMcpServerIdsForTests()).toEqual([])
      const status = getMcpServerStatus([gitServer])[0]
      expect(status?.connected).toBe(false)
      expect(status?.error).toBe(gitMcpNotARepoMessage(workspace))
      expect(isGitMcpNotARepoError(status?.error)).toBe(true)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('does not force-retry permanent Git MCP not-a-repo failures', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'vyotiq-git-mcp-perm-'))
    try {
      setMcpStdioWorkspace(workspace)
      const gitServer = {
        id: 'git',
        name: 'Git',
        enabled: true,
        transport: 'stdio' as const,
        command: 'vyotiq-should-not-spawn-git-mcp-retry',
        args: ['mcp-server-git', '--repository', '.']
      }
      await syncMcpServers([gitServer])
      const first = getMcpServerStatus([gitServer])[0]?.error
      expect(first).toBe(gitMcpNotARepoMessage(workspace))

      await syncMcpServers([gitServer], { forceRetryFailures: true })
      expect(getMcpServerStatus([gitServer])[0]?.error).toBe(first)
      expect(listConnectedMcpServerIdsForTests()).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('reconnects when connection config changes', async () => {
    await syncMcpServers([echoServer])
    const before = listMcpToolDefinitions().length
    expect(before).toBeGreaterThan(0)

    const updated = {
      ...echoServer,
      args: [fixturePath, '--prefix', 'changed']
    }
    await syncMcpServers([updated])
    expect(listConnectedMcpServerIdsForTests()).toEqual(['echo'])
    expect(listMcpToolDefinitions().length).toBeGreaterThan(0)

    const result = await invokeMcpTool(
      'echo',
      'echo',
      { message: 'reconnect-ok' },
      new AbortController().signal
    )
    expect(result.ok).toBe(true)
    expect(result.content).toContain('reconnect-ok')
  })

  it('rejects duplicate server ids', async () => {
    await expect(
      syncMcpServers([
        echoServer,
        { ...echoServer, name: 'Echo duplicate' }
      ])
    ).rejects.toThrow(/duplicate mcp server id/i)
  })
})

describe('MCP HTTP SSRF', () => {
  afterEach(async () => {
    await shutdownMcpServers()
    resetMcpSessionsForTests()
  })

  it('refuses private / loopback remote MCP URLs', async () => {
    await expect(
      connectMcpServer({
        id: 'ssrf',
        name: 'SSRF Fixture',
        enabled: true,
        transport: 'http',
        url: 'http://127.0.0.1:9/mcp',
        env: {}
      })
    ).rejects.toThrow(/private or loopback/i)
  })

  it('refuses link-local metadata URLs', async () => {
    await expect(
      connectMcpServer({
        id: 'meta',
        name: 'Meta Fixture',
        enabled: true,
        transport: 'sse',
        url: 'http://169.254.169.254/latest/meta-data/',
        env: {}
      })
    ).rejects.toThrow(/private or loopback/i)
  })
})

describe('friendlyMcpOAuthError', () => {
  const dcr = () =>
    new Error('Incompatible auth server: does not support dynamic client registration')
  const server = { id: 'github', name: 'GitHub' } as never

  it('rewrites the SDK DCR failure into something the user can act on', () => {
    const out = friendlyMcpOAuthError(dcr(), {
      id: 'github',
      name: 'GitHub',
      setupUrl: 'https://github.com/settings/applications/new'
    } as never) as Error
    expect(out.message).toContain('GitHub cannot register this app automatically')
    expect(out.message).toContain('https://github.com/settings/applications/new')
    expect(out.message).not.toContain('dynamic client registration')
  })

  it('still names the fix when the manifest declares no setup page', () => {
    const out = friendlyMcpOAuthError(dcr(), server) as Error
    expect(out.message).toContain('OAuth client ID and secret')
    expect(out.message).not.toContain('Register one at')
  })

  it('passes every other value through untouched', () => {
    const other = new Error('socket hang up')
    expect(friendlyMcpOAuthError(other, server)).toBe(other)
    expect(friendlyMcpOAuthError('not an error', server)).toBe('not an error')
  })
})
