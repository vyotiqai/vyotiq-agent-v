import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const userData = join(tmpdir(), `vyotiq-install-ack-${process.pid}-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => join(tmpdir(), 'vyotiq-app'),
    getPath: (name: string) => {
      if (name === 'userData') return userData
      return join(tmpdir(), name)
    }
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8')
  }
}))

const getSettingsMock = vi.fn()
vi.mock('@main/settings/settings', () => ({
  getSettings: () => getSettingsMock(),
  setSettings: vi.fn((partial: Record<string, unknown>) => ({
    ...getSettingsMock(),
    ...partial
  })),
  clearSettingsCacheForTests: vi.fn(),
  readLegacyWorkspacePath: () => null,
  redactSettingsForIpc: (s: unknown) => s
}))

describe('installMarketplacePackage ack', () => {
  beforeEach(() => {
    mkdirSync(userData, { recursive: true })
    getSettingsMock.mockReset()
    getSettingsMock.mockReturnValue({
      marketplace: { registryUrl: '', remoteInstallAcked: false },
      mcpServers: []
    })
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  it('rejects path/git/npm/zip/registry/remote installs without remoteInstallAcked', async () => {
    const { installMarketplacePackage } = await import('@main/marketplace/install')
    for (const source of ['path', 'git', 'npm', 'zip', 'registry', 'remote'] as const) {
      await expect(
        installMarketplacePackage({
          source,
          target: source === 'path' ? userData : 'https://example.com/x'
        })
      ).rejects.toThrow(/Acknowledge marketplace install risk/i)
    }
  })

  it('allows install attempt past ack gate when remoteInstallAcked is true', async () => {
    getSettingsMock.mockReturnValue({
      marketplace: { registryUrl: '', remoteInstallAcked: true },
      mcpServers: []
    })
    const { installMarketplacePackage } = await import('@main/marketplace/install')
    // Path that is not a package — should fail detection, not ack.
    await expect(
      installMarketplacePackage({
        source: 'path',
        target: join(userData, 'not-a-package')
      })
    ).rejects.toThrow()
    // Prove we got past the ack check: error is not the ack message.
    try {
      await installMarketplacePackage({
        source: 'path',
        target: join(userData, 'not-a-package')
      })
    } catch (err) {
      expect(String(err)).not.toMatch(/Acknowledge marketplace install risk/i)
    }
  })
})

describe('npm pack + registry download guards', () => {
  it('rejects flag/path/URL npm pack targets', async () => {
    const { assertSafeNpmPackTarget } = await import('@main/marketplace/install')
    for (const bad of ['-f', '../evil', 'C:\\pkg', 'file:./x', 'https://evil/pkg']) {
      expect(() => assertSafeNpmPackTarget(bad)).toThrow(/Invalid npm package name/i)
    }
    expect(assertSafeNpmPackTarget('@scope/pkg')).toBe('@scope/pkg')
    expect(assertSafeNpmPackTarget('simple-pkg')).toBe('simple-pkg')
  })

  it('requires catalog downloadUrl to match registry origin', async () => {
    const { assertRegistryDownloadUrl } = await import('@main/marketplace/install')
    expect(
      assertRegistryDownloadUrl(
        'https://registry.example.com/v1/packages/a/versions/1/download',
        'https://registry.example.com'
      )
    ).toMatch(/registry\.example\.com/)
    expect(() =>
      assertRegistryDownloadUrl('https://evil.example/pkg.zip', 'https://registry.example.com')
    ).toThrow(/match the configured registry origin/i)
  })
})

describe('assertExtractContained', () => {
  let dest: string

  beforeEach(() => {
    dest = join(tmpdir(), `vyotiq-extract-${process.pid}-${Date.now()}`)
    mkdirSync(dest, { recursive: true })
  })

  afterEach(() => {
    rmSync(dest, { recursive: true, force: true })
  })

  it('accepts a normal extracted tree', async () => {
    const { assertExtractContained } = await import('@main/marketplace/install')
    writeFileSync(join(dest, 'vyotiq.mcp.json'), '{}')
    expect(() => assertExtractContained(dest)).not.toThrow()
  })

  it('rejects symlinks in the extract tree', async () => {
    if (process.platform === 'win32') {
      // Creating symlinks may require elevation on Windows CI.
      return
    }
    const { assertExtractContained } = await import('@main/marketplace/install')
    const outside = join(tmpdir(), `vyotiq-outside-${process.pid}`)
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'secret'), 'x')
    try {
      symlinkSync(outside, join(dest, 'escape-link'))
      expect(() => assertExtractContained(dest)).toThrow(/symlink/i)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('resolveMcpServersForSessionMap', () => {
  beforeEach(() => {
    mkdirSync(userData, { recursive: true })
    getSettingsMock.mockReturnValue({
      marketplace: { registryUrl: '', remoteInstallAcked: true },
      mcpServers: [
        {
          id: 'manual-a',
          name: 'Manual A',
          enabled: true,
          transport: 'stdio',
          command: 'echo',
          source: 'manual'
        },
        {
          id: 'manual-off',
          name: 'Manual Off',
          enabled: false,
          transport: 'stdio',
          command: 'echo',
          source: 'manual'
        }
      ]
    })
  })

  afterEach(async () => {
    const { invalidateMcpResolveCache } = await import('@main/marketplace/resolve')
    invalidateMcpResolveCache()
    rmSync(userData, { recursive: true, force: true })
  })

  it('returns only enabled servers when no workspaces are open', async () => {
    const { resolveMcpServersForSessionMap, invalidateMcpResolveCache } = await import(
      '@main/marketplace/resolve'
    )
    invalidateMcpResolveCache()
    const servers = resolveMcpServersForSessionMap()
    expect(servers.map((s) => s.id).sort()).toEqual(['manual-a'])
    expect(servers.every((s) => s.enabled)).toBe(true)
  })
})
