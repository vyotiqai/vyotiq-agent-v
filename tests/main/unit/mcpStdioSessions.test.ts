/**
 * One stdio MCP server costs one child process per live session, and a session
 * is keyed per workspace. So the count of listed workspaces — not the count of
 * workspaces actually doing something — used to decide how many processes the
 * app keeps alive. These tests pin the idle count and the two escape hatches
 * that keep a configured server reachable.
 */
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
  },
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false, on: () => undefined }
}))
vi.mock('@main/app/window', () => ({ getMainWindow: () => null }))

const state = vi.hoisted(() => ({
  openPaths: [] as string[],
  activePath: null as string | null,
  activeRuns: [] as Array<{ runId: string; workspacePath: string }>
}))
vi.mock('@main/workspace/workspaces', () => ({
  readWorkspacesState: () => ({
    openPaths: state.openPaths,
    activePath: state.activePath,
    workspaces: []
  }),
  findWorkspaceSettingsOverride: () => undefined
}))
vi.mock('@main/agent/runRegistry', () => ({
  listActiveRuns: () => state.activeRuns
}))

import {
  collectStdioWorkspacePaths,
  invokeMcpTool,
  listMcpSessionKeysForTests,
  mcpStdioSessionKey,
  refreshMcpServers,
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

const signal = (): AbortSignal => new AbortController().signal

function makeWorkspaces(count: number): string[] {
  const dirs = Array.from({ length: count }, () =>
    mkdtempSync(join(tmpdir(), 'vyotiq-mcp-fanout-'))
  )
  state.openPaths = dirs
  state.activePath = dirs[0] ?? null
  return dirs
}

/** Temp workspace dirs to delete once each test is done with them. */
const listTempDirs: string[] = []

describe('stdio MCP sessions across listed workspaces', () => {
  afterEach(async () => {
    await shutdownMcpServers()
    resetMcpSessionsForTests()
    state.openPaths = []
    state.activePath = null
    state.activeRuns = []
    for (const dir of listTempDirs) rmSync(dir, { recursive: true, force: true })
    listTempDirs.length = 0
  })

  it('keeps one live session per workspace doing work, not per workspace listed', async () => {
    const dirs = makeWorkspaces(4)
    listTempDirs.push(...dirs)
    // One workspace is on screen and has a run; three are merely open.
    state.activeRuns = [{ runId: 'run-1', workspacePath: dirs[0] }]

    expect(collectStdioWorkspacePaths()).toHaveLength(4)

    await syncMcpServers([echoServer])

    const keys = listMcpSessionKeysForTests()
    expect(keys).toEqual([mcpStdioSessionKey('echo', dirs[0])])
  })

  it('does not add a process per extra listed workspace', async () => {
    const few = makeWorkspaces(1)
    await syncMcpServers([echoServer])
    const idle = listMcpSessionKeysForTests().length
    await shutdownMcpServers()
    resetMcpSessionsForTests()

    const many = makeWorkspaces(8)
    listTempDirs.push(...many)
    await syncMcpServers([echoServer])

    expect(listMcpSessionKeysForTests()).toHaveLength(idle)
    for (const dir of few) rmSync(dir, { recursive: true, force: true })
  })

  it('still serves the workspace that has the run', async () => {
    const dirs = makeWorkspaces(3)
    listTempDirs.push(...dirs)
    state.activeRuns = [{ runId: 'run-1', workspacePath: dirs[0] }]

    await syncMcpServers([echoServer])

    const result = await invokeMcpTool(
      'echo',
      'echo',
      { message: 'busy-workspace' },
      signal(),
      undefined,
      undefined,
      dirs[0]
    )
    expect(result.ok).toBe(true)
    expect(result.content).toContain('busy-workspace')
  })

  it('keeps a server reachable after the run ends and the workspace is reactivated', async () => {
    const dirs = makeWorkspaces(2)
    listTempDirs.push(...dirs)
    state.activeRuns = [{ runId: 'run-1', workspacePath: dirs[0] }]
    await syncMcpServers([echoServer])

    state.activeRuns = []
    setMcpStdioWorkspace(dirs[1])
    await syncMcpServers([echoServer])

    const result = await invokeMcpTool(
      'echo',
      'echo',
      { message: 'reactivated' },
      signal(),
      undefined,
      undefined,
      dirs[1]
    )
    expect(result.ok).toBe(true)
    expect(result.content).toContain('reactivated')
  })

  it('warm-connects every open workspace on an explicit Refresh', async () => {
    const dirs = makeWorkspaces(4)
    listTempDirs.push(...dirs)

    await refreshMcpServers([echoServer])

    expect(listMcpSessionKeysForTests()).toHaveLength(4)
    for (const dir of dirs) {
      expect(listMcpSessionKeysForTests()).toContain(mcpStdioSessionKey('echo', dir))
    }
  })
})