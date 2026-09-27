/**
 * MCP connect and sync must not stall or leak, and must hand the model what a
 * server actually offers.
 *
 * Covers: servers connected side by side instead of one after another, the
 * connect deadline covering `tools/list`, the client closed when anything after
 * the handshake fails, tool-less servers, paged lists, `tools/list_changed`,
 * binary tool content, draft-07 argument schemas, the sync-fingerprint race and
 * per-workspace tool scoping.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'

const ISOLATED_USER_DATA = mkdtempSync(join(tmpdir(), 'vyotiq-mcp-sync-robust-'))

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
  shell: { openExternal: async () => undefined },
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false, on: () => undefined }
}))
vi.mock('@main/app/window', () => ({ getMainWindow: () => null }))
// Pin the stdio workspace set to the hint so each server has one session.
vi.mock('@main/workspace/workspaces', () => ({
  readWorkspacesState: () => ({ openPaths: [], activePath: null, workspaces: [] }),
  findWorkspaceSettingsOverride: () => undefined
}))

import {
  connectMcpServer,
  getMcpServerStatus,
  getMcpSessionGeneration,
  invokeMcpTool,
  listMcpPrompts,
  listMcpResources,
  listMcpToolDefinitions,
  mcpConnectTimeoutMs,
  resetMcpSessionsForTests,
  setMcpConnectTimeoutForTests,
  setMcpStdioWorkspace,
  shutdownMcpServers,
  syncMcpServers
} from '@main/agent/mcp'
import { MCP_OAUTH_CALLBACK_TIMEOUT_MS } from '@main/agent/mcp/oauth'

const fixtures = join(fileURLToPath(new URL('.', import.meta.url)), '../../fixtures')
const workspace = process.cwd()
const signal = (): AbortSignal => new AbortController().signal
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function stdio(id: string, fixture: string, env: Record<string, string> = {}) {
  return {
    id,
    name: id,
    enabled: true,
    transport: 'stdio' as const,
    command: process.execPath,
    args: [join(fixtures, fixture)],
    env
  }
}

function pidFile(): string {
  return join(ISOLATED_USER_DATA, `pid-${Date.now()}-${Math.random().toString(16).slice(2)}`)
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const call = (serverId: string, tool: string, args: Record<string, unknown> = {}) =>
  invokeMcpTool(serverId, tool, args, signal(), undefined, undefined, workspace)

beforeEach(() => {
  resetMcpSessionsForTests()
  setMcpStdioWorkspace(workspace)
})

afterEach(async () => {
  await shutdownMcpServers()
  resetMcpSessionsForTests()
})

describe('sync connects servers side by side', () => {
  it('starts every server before the first one is ready', async () => {
    const log = join(ISOLATED_USER_DATA, `starts-${Date.now()}.log`)
    const slow = (id: string) =>
      stdio(id, 'mcp-slow-start-server.mjs', { MCP_FIXTURE_DELAY_MS: '2000', MCP_FIXTURE_LOG: log })
    await syncMcpServers([slow('s1'), slow('s2'), slow('s3')])
    expect(listMcpToolDefinitions().map((t) => t.name).sort()).toEqual([
      'mcp__s1__ping',
      'mcp__s2__ping',
      'mcp__s3__ping'
    ])
    const events = readFileSync(log, 'utf8').trim()
      .split(/\r?\n/)
      .map((line) => line.split(' '))
    const starts = events.filter(([kind]) => kind === 'start').map(([, at]) => Number(at))
    const readies = events.filter(([kind]) => kind === 'ready').map(([, at]) => Number(at))
    expect(starts).toHaveLength(3)
    // Serially, each server launched only after the previous one was ready.
    expect(Math.max(...starts)).toBeLessThan(Math.min(...readies))
  }, 60_000)

  it('bumps the session generation on connect and on close', async () => {
    const before = getMcpSessionGeneration()
    await syncMcpServers([stdio('echo', 'mcp-echo-server.mjs')])
    const connected = getMcpSessionGeneration()
    expect(connected).toBeGreaterThan(before)
    await syncMcpServers([{ ...stdio('echo', 'mcp-echo-server.mjs'), enabled: false }])
    expect(getMcpSessionGeneration()).toBeGreaterThan(connected)
  }, 60_000)
})

describe('connect after the handshake', () => {
  it('bounds tools/list by the connect deadline and closes the child', async () => {
    const file = pidFile()
    const server = stdio('hangs', 'mcp-broken-tools-server.mjs', {
      MCP_FIXTURE_TOOLS: 'hang',
      MCP_FIXTURE_PID_FILE: file
    })
    const started = Date.now()
    setMcpConnectTimeoutForTests(3000)
    try {
      await syncMcpServers([server])
    } finally {
      setMcpConnectTimeoutForTests(null)
    }
    // Well under the SDK's 60s per-request default it used to wait on.
    expect(Date.now() - started).toBeLessThan(30_000)
    const status = getMcpServerStatus([server], workspace)[0]!
    expect(status.connected).toBe(false)
    expect(status.error).toMatch(/timed out|did not respond/i)
    const pid = Number(readFileSync(file, 'utf8'))
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 10_000 })
  }, 60_000)

  it('closes the stdio child when tools/list fails', async () => {
    const file = pidFile()
    const server = stdio('broken', 'mcp-broken-tools-server.mjs', {
      MCP_FIXTURE_TOOLS: 'error',
      MCP_FIXTURE_PID_FILE: file
    })
    await syncMcpServers([server])
    expect(getMcpServerStatus([server], workspace)[0]!.connected).toBe(false)
    expect(existsSync(file)).toBe(true)
    const pid = Number(readFileSync(file, 'utf8'))
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 10_000 })
  }, 60_000)

  it('connects a server that offers resources and no tools', async () => {
    const server = stdio('resonly', 'mcp-resources-only-server.mjs')
    await syncMcpServers([server])
    const status = getMcpServerStatus([server], workspace)[0]!
    expect(status.connected).toBe(true)
    expect(status.toolCount).toBe(0)
    const resources = await listMcpResources('resonly', undefined, signal(), workspace)
    expect(resources.map((r) => r.uri)).toEqual(['file:///readme.txt'])
  }, 60_000)
})

describe('what a server offers reaches the model', () => {
  it('follows nextCursor for tools, resources and prompts', async () => {
    await syncMcpServers([stdio('rich', 'mcp-rich-server.mjs')])
    const tools = listMcpToolDefinitions().map((t) => t.name)
    expect(tools).toContain('mcp__rich__first_page_tool')
    expect(tools).toContain('mcp__rich__second_page_tool')
    const resources = await listMcpResources('rich', undefined, signal(), workspace)
    expect(resources.map((r) => r.name)).toEqual(['first', 'second'])
    const prompts = await listMcpPrompts('rich', undefined, signal(), workspace)
    expect(prompts.map((p) => p.name)).toEqual(['first_prompt', 'second_prompt'])
  }, 60_000)

  it('picks up tools announced with tools/list_changed', async () => {
    await syncMcpServers([stdio('rich', 'mcp-rich-server.mjs')])
    const before = getMcpSessionGeneration()
    expect(listMcpToolDefinitions().map((t) => t.name)).not.toContain('mcp__rich__late_tool')
    expect((await call('rich', 'grow')).ok).toBe(true)
    await vi.waitFor(
      () => expect(listMcpToolDefinitions().map((t) => t.name)).toContain('mcp__rich__late_tool'),
      { timeout: 10_000 }
    )
    expect(getMcpSessionGeneration()).toBeGreaterThan(before)
  }, 60_000)

  it('summarises image content instead of pasting base64', async () => {
    await syncMcpServers([stdio('rich', 'mcp-rich-server.mjs')])
    const result = await call('rich', 'screenshot')
    expect(result.ok).toBe(true)
    expect(result.content).toContain('Screenshot taken')
    expect(result.content).toContain('[image mime=image/png bytes=300000]')
    expect(result.content).not.toContain('"data"')
    expect(result.content.length).toBeLessThan(2_000)
  }, 60_000)

  it('validates arguments against a draft-07 schema from the TypeScript SDK', async () => {
    await syncMcpServers([stdio('echo', 'mcp-echo-server.mjs')])
    const def = listMcpToolDefinitions().find((t) => t.name === 'mcp__echo__echo')
    expect(def?.parameters.$schema).toMatch(/draft-07/)
    const bad = await call('echo', 'echo', {})
    expect(bad.ok).toBe(false)
    expect(bad.content).toContain('Invalid arguments for MCP tool')
    const good = await call('echo', 'echo', { message: 'hi' })
    expect(good.ok).toBe(true)
    expect(good.content).toContain('hi')
  }, 60_000)
})

describe('sync fingerprint', () => {
  it('rebuilds a session that died while another sync was running', async () => {
    const crashy = stdio('crashy', 'mcp-crash-server.mjs')
    const slow = stdio('slow', 'mcp-slow-start-server.mjs', { MCP_FIXTURE_DELAY_MS: '2500' })
    await syncMcpServers([crashy])
    const inflight = syncMcpServers([crashy, slow])
    await sleep(300)
    // crashy's child exits while that sync is still connecting `slow`.
    await call('crashy', 'die_after_reply')
    await sleep(800)
    expect(getMcpServerStatus([crashy], workspace)[0]!.connected).toBe(false)
    await inflight
    await syncMcpServers([crashy, slow])
    const statuses = getMcpServerStatus([crashy, slow], workspace)
    expect(statuses.map((s) => s.connected)).toEqual([true, true])
  }, 60_000)
})

describe('tool definitions per workspace', () => {
  it('offers a run only the stdio sessions its workspace can invoke', async () => {
    const other = mkdtempSync(join(tmpdir(), 'vyotiq-mcp-other-ws-'))
    await connectMcpServer(stdio('echo', 'mcp-echo-server.mjs'), other)
    expect(listMcpToolDefinitions(other).map((t) => t.name)).toEqual(['mcp__echo__echo'])
    // The session exists, but invoke from `workspace` would refuse to borrow it.
    expect(listMcpToolDefinitions(workspace)).toEqual([])
    expect((await call('echo', 'echo', { message: 'x' })).ok).toBe(false)
  }, 60_000)
})

describe('interactive OAuth budget', () => {
  it('outlasts the callback server window', () => {
    expect(mcpConnectTimeoutMs({ interactiveOAuth: true })).toBeGreaterThan(
      MCP_OAUTH_CALLBACK_TIMEOUT_MS
    )
    expect(mcpConnectTimeoutMs()).toBe(120_000)
  })
})
