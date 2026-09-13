import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const userData = join(tmpdir(), `vyotiq-settings-ack-${process.pid}-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? userData : join(tmpdir(), name)),
    getAppPath: () => join(tmpdir(), 'vyotiq-app'),
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8')
  }
}))

describe('setSettings mcpServers ack gate', () => {
  beforeEach(() => {
    mkdirSync(userData, { recursive: true })
  })

  afterEach(async () => {
    const { clearSettingsCacheForTests } = await import('@main/settings/settings')
    clearSettingsCacheForTests()
    rmSync(userData, { recursive: true, force: true })
  })

  it('rejects adding stdio MCP without remoteInstallAcked', async () => {
    const { clearSettingsCacheForTests, setSettings, getSettings } = await import(
      '@main/settings/settings'
    )
    clearSettingsCacheForTests()
    expect(getSettings().marketplace?.remoteInstallAcked).toBe(false)
    expect(() =>
      setSettings({
        mcpServers: [
          {
            id: 'new-stdio',
            name: 'New',
            enabled: true,
            transport: 'stdio',
            command: 'npx',
            source: 'manual'
          }
        ]
      })
    ).toThrow(/Acknowledge marketplace/i)
  })

  it('allows adding stdio MCP after remoteInstallAcked', async () => {
    const {
      clearSettingsCacheForTests,
      setSettings,
      getSettings,
      setMarketplaceRemoteInstallAcked
    } = await import('@main/settings/settings')
    clearSettingsCacheForTests()
    setMarketplaceRemoteInstallAcked(true)
    const next = setSettings({
      mcpServers: [
        {
          id: 'new-stdio',
          name: 'New',
          enabled: true,
          transport: 'stdio',
          command: 'npx',
          source: 'manual'
        }
      ]
    })
    expect(next.mcpServers.some((s) => s.id === 'new-stdio')).toBe(true)
    expect(getSettings().mcpServers.some((s) => s.id === 'new-stdio')).toBe(true)
  })

  it('skipMcpAck allows marketplace sync without remoteInstallAcked', async () => {
    const { clearSettingsCacheForTests, setSettings, getSettings } = await import(
      '@main/settings/settings'
    )
    clearSettingsCacheForTests()
    expect(getSettings().marketplace?.remoteInstallAcked).toBe(false)
    const next = setSettings(
      {
        mcpServers: [
          {
            id: 'bundled-mcp',
            name: 'Bundled',
            enabled: true,
            transport: 'stdio',
            command: 'uvx',
            source: 'marketplace'
          }
        ]
      },
      { skipMcpAck: true }
    )
    expect(next.mcpServers.some((s) => s.id === 'bundled-mcp')).toBe(true)
    expect(() =>
      setSettings({
        mcpServers: [
          {
            id: 'manual-mcp',
            name: 'Manual',
            enabled: true,
            transport: 'stdio',
            command: 'npx',
            source: 'manual'
          }
        ]
      })
    ).toThrow(/Acknowledge marketplace/i)
  })

  it('clears remoteInstallAcked when registryUrl changes via setSettings', async () => {
    const {
      clearSettingsCacheForTests,
      setSettings,
      getSettings,
      setMarketplaceRemoteInstallAcked
    } = await import('@main/settings/settings')
    clearSettingsCacheForTests()
    setMarketplaceRemoteInstallAcked(true)
    setSettings({ marketplace: { registryUrl: 'https://registry.example.com' } })
    expect(getSettings().marketplace?.registryUrl).toBe('https://registry.example.com')
    expect(getSettings().marketplace?.remoteInstallAcked).toBe(false)
  })

  it('preserves remoteInstallAcked when registryUrl is unchanged', async () => {
    const {
      clearSettingsCacheForTests,
      setSettings,
      getSettings,
      setMarketplaceRemoteInstallAcked
    } = await import('@main/settings/settings')
    clearSettingsCacheForTests()
    setSettings({ marketplace: { registryUrl: 'https://registry.example.com' } })
    setMarketplaceRemoteInstallAcked(true)
    setSettings({ marketplace: { registryUrl: 'https://registry.example.com' } })
    expect(getSettings().marketplace?.remoteInstallAcked).toBe(true)
  })

  it('restores Authorization when renderer echoes [redacted] back', async () => {
    const {
      clearSettingsCacheForTests,
      setSettings,
      getSettings,
      redactSettingsForIpc,
      REDACTED_VALUE,
      setMarketplaceRemoteInstallAcked
    } = await import('@main/settings/settings')
    const { readFileSync } = await import('fs')
    const { join: pathJoin } = await import('path')
    clearSettingsCacheForTests()
    setMarketplaceRemoteInstallAcked(true)
    setSettings({
      mcpServers: [
        {
          id: 'http-mcp',
          name: 'HTTP',
          enabled: true,
          transport: 'http',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer secret-token' },
          source: 'manual'
        }
      ]
    })
    // Disk must not keep plaintext Authorization
    const onDisk = JSON.parse(readFileSync(pathJoin(userData, 'settings.json'), 'utf8')) as {
      mcpServers: Array<{ headers?: Record<string, string> }>
    }
    expect(onDisk.mcpServers[0]?.headers?.Authorization).toBe(REDACTED_VALUE)
    expect(JSON.stringify(onDisk)).not.toContain('secret-token')

    const redacted = redactSettingsForIpc(getSettings())
    const server = redacted.mcpServers.find((s) => s.id === 'http-mcp')
    expect(server?.headers?.Authorization).toBe(REDACTED_VALUE)

    const next = setSettings({
      mcpServers: redacted.mcpServers.map((s) =>
        s.id === 'http-mcp' ? { ...s, enabled: false } : s
      )
    })
    expect(next.mcpServers.find((s) => s.id === 'http-mcp')?.enabled).toBe(false)
    // Persisted shape stays redacted; getSettings restores from secure storage.
    expect(next.mcpServers.find((s) => s.id === 'http-mcp')?.headers?.Authorization).toBe(
      REDACTED_VALUE
    )
    expect(getSettings().mcpServers.find((s) => s.id === 'http-mcp')?.headers?.Authorization).toBe(
      'Bearer secret-token'
    )
  })

  it('migrates legacy plaintext MCP env secrets on first getSettings load', async () => {
    const { writeFileSync, readFileSync } = await import('fs')
    const { join: pathJoin } = await import('path')
    const {
      clearSettingsCacheForTests,
      getSettings,
      REDACTED_VALUE
    } = await import('@main/settings/settings')
    const { getMcpServerSecrets } = await import('@main/settings/secrets')

    clearSettingsCacheForTests()
    writeFileSync(
      pathJoin(userData, 'settings.json'),
      JSON.stringify({
        provider: 'ollama',
        model: 'qwen2.5',
        ollamaBaseUrl: 'http://127.0.0.1:11434',
        theme: 'system',
        telemetryEnabled: false,
        mcpServers: [
          {
            id: 'legacy-env',
            name: 'Legacy',
            enabled: true,
            transport: 'stdio',
            command: 'npx',
            env: { API_KEY: 'plaintext-secret' },
            source: 'manual'
          }
        ]
      }),
      'utf8'
    )

    const settings = getSettings()
    expect(settings.mcpServers.find((s) => s.id === 'legacy-env')?.env?.API_KEY).toBe(
      'plaintext-secret'
    )

    const onDisk = JSON.parse(readFileSync(pathJoin(userData, 'settings.json'), 'utf8')) as {
      mcpServers: Array<{ env?: Record<string, string> }>
    }
    expect(onDisk.mcpServers[0]?.env?.API_KEY).toBe(REDACTED_VALUE)
    expect(JSON.stringify(onDisk)).not.toContain('plaintext-secret')
    expect(getMcpServerSecrets('legacy-env')?.env?.API_KEY).toBe('plaintext-secret')
  })

  it('clears auth token and OAuth state when an MCP server is removed', async () => {
    const {
      clearSettingsCacheForTests,
      setSettings,
      setMarketplaceRemoteInstallAcked
    } = await import('@main/settings/settings')
    const {
      setMcpAuthToken,
      getMcpAuthToken,
      setMcpOAuthState,
      getMcpOAuthState,
      setMcpServerSecrets,
      getMcpServerSecrets
    } = await import('@main/settings/secrets')

    clearSettingsCacheForTests()
    setMarketplaceRemoteInstallAcked(true)
    setSettings({
      mcpServers: [
        {
          id: 'gone-mcp',
          name: 'Gone',
          enabled: true,
          transport: 'http',
          url: 'https://example.com/mcp',
          source: 'manual'
        }
      ]
    })
    setMcpAuthToken('gone-mcp', 'Bearer secret-token')
    setMcpOAuthState('gone-mcp', {
      tokens: {
        access_token: 'access',
        refresh_token: 'refresh'
      }
    })
    setMcpServerSecrets('gone-mcp', { env: {}, headers: { 'X-Key': 'h' } })

    setSettings({ mcpServers: [] })

    expect(getMcpAuthToken('gone-mcp')).toBeNull()
    expect(getMcpOAuthState('gone-mcp')).toBeNull()
    expect(getMcpServerSecrets('gone-mcp')).toBeNull()
  })
})
