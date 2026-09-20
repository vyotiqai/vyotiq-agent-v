/**
 * An MCP server that dies must come back on its own.
 *
 * Three defects used to compound here: a dead transport stayed in the session
 * map reporting `connected`, a failed tool call tore the session down and
 * erased the reason, and the sync that was supposed to rebuild it skipped on
 * an unchanged fingerprint. The result was a server that went dark on its
 * first hiccup and stayed dark until the user clicked Refresh.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'

const ISOLATED_USER_DATA = mkdtempSync(join(tmpdir(), 'vyotiq-mcp-recovery-'))

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
// Pin the stdio workspace set: the host machine's real open workspaces would
// otherwise add a second session per server and mask a failed teardown.
vi.mock('@main/workspace/workspaces', () => ({
  readWorkspacesState: () => ({ openPaths: [], activePath: null, workspaces: [] }),
  findWorkspaceSettingsOverride: () => undefined
}))

import {
  getMcpServerStatus,
  invokeMcpTool,
  isMcpSessionFatalError,
  listMcpToolDefinitions,
  resetMcpSessionsForTests,
  setMcpStdioWorkspace,
  shutdownMcpServers,
  syncMcpServers
} from '@main/agent/mcp'

const fixturePath = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../fixtures/mcp-crash-server.mjs'
)

const crashServer = {
  id: 'crashy',
  name: 'Crash Fixture',
  enabled: true,
  transport: 'stdio' as const,
  command: process.execPath,
  args: [fixturePath],
  env: {}
}

const workspace = process.cwd()
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const status = (): ReturnType<typeof getMcpServerStatus>[number] =>
  getMcpServerStatus([crashServer], workspace)[0]
const call = (tool: string, args: Record<string, unknown> = {}) =>
  invokeMcpTool('crashy', tool, args, new AbortController().signal, undefined, undefined, workspace)

describe('isMcpSessionFatalError', () => {
  it('treats only transport and auth failures as session-fatal', () => {
    // These killed the session before, and none of them says the transport died.
    expect(isMcpSessionFatalError('MCP error -32001: Request timed out')).toBe(false)
    expect(isMcpSessionFatalError('MCP error -32603: Internal error')).toBe(false)
    expect(isMcpSessionFatalError('MCP error -32602: Invalid arguments for tool x')).toBe(false)
    expect(isMcpSessionFatalError('Error POSTing to endpoint (HTTP 503)')).toBe(false)
    expect(isMcpSessionFatalError(undefined)).toBe(false)

    expect(isMcpSessionFatalError('Not connected')).toBe(true)
    expect(isMcpSessionFatalError('MCP error -32000: Connection closed')).toBe(true)
    expect(isMcpSessionFatalError('Unauthorized')).toBe(true)
    expect(isMcpSessionFatalError('socket hang up')).toBe(true)
    expect(isMcpSessionFatalError('fetch failed')).toBe(true)
  })
})

describe('MCP session recovery', () => {
  beforeEach(async () => {
    resetMcpSessionsForTests()
    setMcpStdioWorkspace(workspace)
    await syncMcpServers([crashServer])
    expect(status().connected).toBe(true)
  })

  afterEach(async () => {
    await shutdownMcpServers()
    resetMcpSessionsForTests()
  })

  it('stops advertising tools once the child process exits', async () => {
    const before = listMcpToolDefinitions().map((t) => t.name)
    expect(before).toContain('mcp__crashy__echo')

    await call('die_after_reply')
    await sleep(800)

    // The transport closing is enough; nothing had to call the server to notice.
    const dead = status()
    expect(dead.connected).toBe(false)
    expect(dead.toolCount).toBe(0)
    expect(dead.error).toBeTruthy()
    expect(listMcpToolDefinitions().map((t) => t.name)).not.toContain('mcp__crashy__echo')
  })

  it('reconnects on the next sync after the child exits', async () => {
    await call('die_after_reply')
    await sleep(800)
    expect(status().connected).toBe(false)

    await syncMcpServers([crashServer])

    expect(status().connected).toBe(true)
    const result = await call('echo', { message: 'back' })
    expect(result.ok).toBe(true)
    expect(result.content).toContain('back')
  })

  it('reconnects on the next sync after a call dies mid-flight', async () => {
    const failed = await call('die_during_call')
    expect(failed.ok).toBe(false)
    expect(failed.content).toContain('will reconnect on next sync')
    expect(status().connected).toBe(false)

    // The promise the error message makes has to hold.
    await syncMcpServers([crashServer])

    expect(status().connected).toBe(true)
    const result = await call('echo', { message: 'recovered' })
    expect(result.ok).toBe(true)
    expect(result.content).toContain('recovered')
  })

  it('keeps the failure reason visible after the session is torn down', async () => {
    await call('die_during_call')

    // The run loop only retries a failed server when it can see an error, and
    // the UI has nothing else to explain the disconnect.
    const dead = status()
    expect(dead.connected).toBe(false)
    expect(dead.error).toBeTruthy()
  })

  it('keeps the session when only the tool call fails', async () => {
    const failed = await call('does_not_exist')
    expect(failed.ok).toBe(false)

    // A tool-level rejection says nothing about the transport.
    expect(status().connected).toBe(true)
    const result = await call('echo', { message: 'still here' })
    expect(result.ok).toBe(true)
    expect(result.content).toContain('still here')
  })
})
