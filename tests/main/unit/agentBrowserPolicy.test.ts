import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/ipc'

vi.mock('electron', () => ({
  session: { fromPartition: () => ({ on: vi.fn() }) },
  WebContentsView: class {
    webContents = {
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      isDestroyed: () => false,
      close: vi.fn()
    }
    setBounds = vi.fn()
    setVisible = vi.fn()
  }
}))

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null
}))

vi.mock('@main/settings/settings', () => ({
  getSettings: vi.fn(() => ({
    ...DEFAULT_SETTINGS,
    browserDomainAllowlist: ['example.com', '*.allowed.dev']
  }))
}))

import { hostAllowedByAllowlist, isSyncBlockedNavigation } from '@main/app/agentBrowser'

describe('browser navigation policy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('hostAllowedByAllowlist matches exact and wildcard suffix hosts', () => {
    expect(hostAllowedByAllowlist('example.com', ['example.com'])).toBe(true)
    expect(hostAllowedByAllowlist('api.allowed.dev', ['*.allowed.dev'])).toBe(true)
    expect(hostAllowedByAllowlist('evil.com', ['example.com'])).toBe(false)
  })

  it('isSyncBlockedNavigation blocks private hosts in Ask/Plan mode', () => {
    expect(isSyncBlockedNavigation('http://127.0.0.1:8080', false)).toBe(true)
    expect(isSyncBlockedNavigation('https://example.com/', false)).toBe(false)
  })

  it('isSyncBlockedNavigation enforces domain allowlist on redirects', () => {
    expect(isSyncBlockedNavigation('https://evil.com/', false)).toBe(true)
    expect(isSyncBlockedNavigation('https://api.allowed.dev/page', false)).toBe(false)
  })
})
