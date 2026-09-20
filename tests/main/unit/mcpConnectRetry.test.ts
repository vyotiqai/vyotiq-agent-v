/**
 * A remote MCP connect used to be one shot.
 *
 * The transports run on the runtime's global fetch, whose connect timeout is
 * 10s and which retries nothing. So a DNS blip or a half-open Wi-Fi link — the
 * failure that reached the log as
 * `fetch failed — Connect Timeout Error (attempted addresses: …, timeout: 10000ms)` —
 * left the server showing "Connect failed" until somebody noticed and hit
 * Refresh. These cover the retry that closes that gap, and the two things it
 * must not do: retry a failure a second attempt cannot change, and leak the
 * half-built client from the attempt it just abandoned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const ISOLATED_USER_DATA = mkdtempSync(join(tmpdir(), 'vyotiq-mcp-retry-'))

/** Shared with the hoisted mock factories below, which run before any import. */
const fake = vi.hoisted(() => ({
  /** What `client.connect` does, one entry per call. */
  script: [] as Array<Error | null>,
  connectCalls: 0,
  closedClients: 0,
  /** Held open to observe the in-flight state; null means connect immediately. */
  gate: null as Promise<void> | null
}))

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
// The real one resolves DNS to prove the host is public. This test is about
// what happens after that check, and must not depend on the network.
vi.mock('@main/net/webFetch', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertPublicUrl: async (url: string) => new URL(url)
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    onclose?: () => void
    onerror?: (err: unknown) => void
    setRequestHandler(): void {}
    getServerCapabilities(): Record<string, unknown> {
      return {}
    }
    async connect(): Promise<void> {
      const outcome = fake.script[fake.connectCalls] ?? null
      fake.connectCalls += 1
      if (fake.gate) await fake.gate
      if (outcome) throw outcome
    }
    async listTools(): Promise<{ tools: Array<{ name: string }> }> {
      return { tools: [{ name: 'ask' }] }
    }
    async close(): Promise<void> {
      fake.closedClients += 1
    }
  }
}))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    async close(): Promise<void> {}
  }
}))

import {
  connectMcpServer,
  getMcpServerStatus,
  resetMcpSessionsForTests,
  shutdownMcpServers
} from '@main/agent/mcp'

const server = {
  id: 'deepwiki',
  name: 'DeepWiki',
  enabled: true,
  transport: 'http' as const,
  url: 'https://mcp.deepwiki.com/mcp'
}

/** The failure the user actually hit, shape and all. */
function connectTimeout(): Error {
  const cause = new Error(
    'Connect Timeout Error (attempted addresses: 44.236.210.131:443, ' +
      '2600:1f14:36ec:d01::ebaf:443, timeout: 10000ms)'
  )
  ;(cause as Error & { code?: string }).code = 'UND_ERR_CONNECT_TIMEOUT'
  const err = new Error('fetch failed')
  ;(err as Error & { cause?: unknown }).cause = cause
  return err
}

beforeEach(() => {
  fake.script = []
  fake.connectCalls = 0
  fake.closedClients = 0
  fake.gate = null
})

afterEach(async () => {
  await shutdownMcpServers()
  resetMcpSessionsForTests()
})

describe('connecting a remote MCP server', () => {
  it('rides out a transient network failure instead of giving up', async () => {
    fake.script = [connectTimeout(), connectTimeout(), null]

    await connectMcpServer(server)

    expect(fake.connectCalls).toBe(3)
    const status = getMcpServerStatus([server])[0]
    expect(status.connected).toBe(true)
    expect(status.error).toBeUndefined()
  })

  it('closes the client it abandons, once per retry', async () => {
    fake.script = [connectTimeout(), null]

    await connectMcpServer(server)

    // The failed attempt's client holds a socket; leaving it open would leak
    // one connection per retry for the life of the app.
    expect(fake.closedClients).toBe(1)
  })

  it('gives up once the failures stop looking transient', async () => {
    fake.script = [connectTimeout(), connectTimeout(), connectTimeout(), null]

    await expect(connectMcpServer(server)).rejects.toThrow(/fetch failed/)

    // Three attempts, then the circuit breaker in the sync loop takes over.
    expect(fake.connectCalls).toBe(3)
    expect(getMcpServerStatus([server])[0].connected).toBe(false)
  })

  it('reports a connect in flight rather than a server that is down', async () => {
    // Without this the first seconds of every launch read as an outage: sync
    // dials every enabled server and Home renders each one as
    // "<name> is not connected" before any of them has had a chance to answer.
    let release = (): void => {}
    fake.gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const inFlight = connectMcpServer(server)
    await vi.waitFor(() => expect(fake.connectCalls).toBe(1))

    const dialling = getMcpServerStatus([server])[0]
    expect(dialling.connecting).toBe(true)
    expect(dialling.connected).toBe(false)

    release()
    await inFlight

    const settled = getMcpServerStatus([server])[0]
    expect(settled.connecting).toBeUndefined()
    expect(settled.connected).toBe(true)
  })

  it('does not retry a failure a second attempt cannot change', async () => {
    // A rejected credential is the server's answer, not a lost packet.
    fake.script = [new Error('HTTP 401 Unauthorized'), null]

    await expect(connectMcpServer(server)).rejects.toThrow(/401/)

    expect(fake.connectCalls).toBe(1)
  })
})
