import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'os'

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
  shell: { openExternal: async () => undefined },
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false, on: () => undefined }
}))

vi.mock('@main/app/window', () => ({ getMainWindow: () => null }))

import {
  connectMcpServer,
  disconnectMcpServer,
  listMcpToolDefinitions,
  resetMcpSessionsForTests,
  shutdownMcpServers
} from '@main/agent/mcp'
import { mcpServerFromManifest } from '@main/marketplace/install'
import { join } from 'path'

const PACKAGES = join(process.cwd(), 'resources/marketplace/packages')

const ENDPOINT = 'https://mcp.deepwiki.com/mcp'

/**
 * No other test in this suite needs the network, so an offline run must not
 * look like a code defect. Probe once and skip with a visible reason instead.
 */
const online = await fetch(ENDPOINT, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  signal: AbortSignal.timeout(8_000)
})
  .then((r) => r.ok || r.status === 401)
  .catch(() => false)

afterEach(async () => {
  await shutdownMcpServers()
  resetMcpSessionsForTests()
})

/**
 * Network test: connects to the real DeepWiki endpoint through the same code
 * path the app uses (bundled manifest → McpServer → connectMcpServer).
 *
 * This is the regression guard for the pre-connect OAuth gate added alongside
 * the connect rework: that gate must not block a package declared `auth: none`,
 * or every public server in the catalog would report "Sign in required" and the
 * one-click promise would be false.
 *
 * DeepWiki is used rather than a fixture precisely because the thing under test
 * is the shipped URL and transport, not a stub.
 */
describe('public MCP package connects with no credentials', () => {
  it.skipIf(!online)('loads tools from the bundled DeepWiki package', async () => {
    const server = mcpServerFromManifest(join(PACKAGES, 'deepwiki'))
    expect(server.url).toBe(ENDPOINT)
    expect(server.auth).toBe('none')

    await connectMcpServer(server, null)
    const tools = listMcpToolDefinitions([server])

    expect(tools.length).toBeGreaterThan(0)
    // Names are prefixed mcp__<serverId>__<tool>.
    expect(tools.every((t) => t.name.startsWith('mcp__deepwiki__'))).toBe(true)
    expect(tools.map((t) => t.name)).toContain('mcp__deepwiki__ask_question')

    await disconnectMcpServer(server.id)
  }, 60_000)
})
