/**
 * A server off globally but forced on for an open workspace must stay
 * connected. Sync connects from the session map (overrides applied); the
 * post-connect check used the global list, saw the server disabled, and closed
 * the session it had just opened — silently, with no error to retry on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeFileSync } from 'fs'
import { join } from 'path'

const { USER_DATA, WS } = vi.hoisted(() => {
  // vi.mock factories run before module-level code; build the paths here.
  const { mkdtempSync: mk } = require('fs') as typeof import('fs')
  const { join: j } = require('path') as typeof import('path')
  const { tmpdir: tmp } = require('os') as typeof import('os')
  return { USER_DATA: mk(j(tmp(), 'vyotiq-mcp-force-on-')), WS: process.cwd() }
})

vi.mock('electron', () => ({
  app: { getPath: () => USER_DATA, getAppPath: () => process.cwd(), isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8')
  },
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false, on: () => undefined }
}))
vi.mock('@main/app/window', () => ({ getMainWindow: () => null }))
vi.mock('@main/workspace/workspaces', () => {
  const override = { marketplaceOverrides: { mcp: { echo: true } } }
  const state = {
    openPaths: [WS],
    activePath: WS,
    workspaces: [],
    settingsOverridesByPath: { [WS]: override }
  }
  return {
    readWorkspacesState: () => state,
    getWorkspaces: () => state,
    findWorkspaceSettingsOverride: () => override
  }
})

import { invalidateMcpResolveCache, resolveMcpServersForSessionMap } from '@main/marketplace/resolve'
import {
  getMcpServerStatus,
  listMcpToolDefinitions,
  resetMcpSessionsForTests,
  shutdownMcpServers,
  syncMcpServers
} from '@main/agent/mcp'

describe('workspace Force-on MCP server', () => {
  afterEach(async () => {
    await shutdownMcpServers()
    resetMcpSessionsForTests()
  })

  it('stays connected when it is off globally and forced on for the open workspace', async () => {
    resetMcpSessionsForTests()
    writeFileSync(
      join(USER_DATA, 'settings.json'),
      JSON.stringify({
        mcpServers: [
          {
            id: 'echo',
            name: 'Echo',
            enabled: false,
            transport: 'stdio',
            command: process.execPath,
            args: [join(process.cwd(), 'tests/fixtures/mcp-echo-server.mjs')],
            env: {}
          }
        ]
      })
    )
    invalidateMcpResolveCache()
    const sessionServers = resolveMcpServersForSessionMap()
    expect(sessionServers.map((s) => [s.id, s.enabled])).toEqual([['echo', true]])

    await syncMcpServers(sessionServers)

    expect(getMcpServerStatus(sessionServers, WS)[0]?.connected).toBe(true)
    expect(listMcpToolDefinitions(WS).map((t) => t.name)).toEqual(['mcp__echo__echo'])
  }, 60_000)
})
