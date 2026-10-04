import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { WorkspacesState } from '@shared/ipc/schemas/workspace'

// register.ts touches Electron at import time only through this surface.
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  shell: { openPath: vi.fn(async () => '') },
  nativeTheme: { shouldUseDarkColors: false },
  dialog: { showOpenDialog: vi.fn(), showMessageBox: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp/vyotiq-userdata'), getAppPath: () => '/tmp/vyotiq-app', isPackaged: false }
}))

vi.mock('@main/logging/init', () => ({ logsDirectory: () => '/tmp/logs' }))
vi.mock('@main/logging/sentry', () => ({
  applySentryTelemetry: vi.fn(),
  isSentryBuildConfigured: () => false
}))
vi.mock('@main/app/window', () => ({
  getMainWindow: () => null,
  applyTitleBarTheme: () => undefined
}))

vi.mock('@main/agent/mcp', () => ({
  syncMcpServers: vi.fn(async () => {}),
  getMcpServerStatus: vi.fn(() => ({})),
  mcpStatusExtras: vi.fn(() => ({})),
  refreshMcpServers: vi.fn(async () => ({})),
  retryFailedMcpServers: vi.fn(async () => ({})),
  startMcpOAuth: vi.fn(),
  setMcpStdioWorkspace: vi.fn(),
  getMcpStdioWorkspace: vi.fn(() => null)
}))

import { mcpStdioWorkspaceAfterRemove } from '@main/ipc/register'

const state = (openPaths: string[], activePath: string | null): WorkspacesState =>
  ({
    version: 2,
    workspaceIdsByPath: {},
    legacySessionsMigrated: true,
    openPaths,
    activePath,
    recentPaths: [],
    uiStateByPath: {},
    settingsOverridesByPath: {}
  }) as unknown as WorkspacesState

describe('mcpStdioWorkspaceAfterRemove', () => {
  it('retargets the hint at the new active workspace when the hint named the closed one', () => {
    const next = state(['/ws-b'], '/ws-b')
    expect(mcpStdioWorkspaceAfterRemove('/ws-a', '/ws-a', next)).toBe('/ws-b')
  })

  it('clears the hint when the closed workspace was the last one open', () => {
    const next = state([], null)
    expect(mcpStdioWorkspaceAfterRemove('/ws-a', '/ws-a', next)).toBeNull()
  })

  it('leaves a hint that names a still-open workspace alone', () => {
    const next = state(['/ws-b'], '/ws-b')
    expect(mcpStdioWorkspaceAfterRemove('/ws-a', '/ws-b', next)).toBe('/ws-b')
  })

  it('leaves an unset hint unset', () => {
    const next = state(['/ws-b'], '/ws-b')
    expect(mcpStdioWorkspaceAfterRemove('/ws-a', null, next)).toBeNull()
  })
})

describe('workspacesRemove releases the stdio MCP hint', () => {
  const src = readFileSync(join(process.cwd(), 'src/main/ipc/register.ts'), 'utf8')

  it('hands the retargeted hint to setMcpStdioWorkspace inside the remove handler', () => {
    const start = src.indexOf('IPC.workspacesRemove,')
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf('IPC.workspacesSetActive,'))
    expect(body).toContain('mcpStdioWorkspaceAfterRemove')
    expect(body).toContain('setMcpStdioWorkspace')
    // The retarget must land before the sync that fans out warm stdio sessions,
    // otherwise the closed path is still in the warm set when sync reads it.
    expect(body.indexOf('setMcpStdioWorkspace')).toBeLessThan(body.indexOf('syncMcpServers'))
  })
})
