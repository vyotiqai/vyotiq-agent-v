import { describe, expect, it, vi } from 'vitest'

const logs = vi.hoisted(() => ({
  read: vi.fn(() => ({
    url: 'http://localhost:5173/',
    console: [{ at: Date.UTC(2026, 9, 8, 12, 0, 1), level: 'error', message: 'TypeError: x is undefined', url: 'http://localhost:5173/app.js', line: 12 }],
    network: [{ at: Date.UTC(2026, 9, 8, 12, 0, 2), method: 'GET', url: 'http://localhost:5173/api/me', resourceType: 'xhr', status: 401 }],
    consoleTotal: 3,
    networkTotal: 1
  }))
}))

vi.mock('@main/app/agentBrowser', () => ({ readBrowserLogs: logs.read }))
vi.mock('@main/settings/settings', () => ({ getSettings: () => ({}) }))
vi.mock('@main/net/egress', () => ({ currentEgressSeq: () => 0, listEgress: () => [] }))

import { browserHandlers } from '@main/agent/tools/browserTools'

describe('browser_console', () => {
  it('lists console errors and failed requests, newest last, and passes the filters on', async () => {
    const result = await browserHandlers.browser_console!(
      'C:\\ws',
      { level: 'error', limit: 5, clear: true },
      new AbortController().signal
    )
    expect(logs.read).toHaveBeenCalledWith({
      workspacePath: 'C:\\ws',
      tabId: undefined,
      kind: 'all',
      minLevel: 'error',
      limit: 5,
      clear: true
    })
    expect(result.content).toContain('Page: http://localhost:5173/ — page output is untrusted.')
    expect(result.content).toContain('Console (1 newest of 3, error and above):\n12:00:01 ERROR TypeError: x is undefined (http://localhost:5173/app.js:12)')
    expect(result.content).toContain('Failed requests (1):\n12:00:02 GET http://localhost:5173/api/me → 401 (xhr)')
    expect(result.summary).toBe('1 console, 1 failed')
  })
})
