import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/** Windows can briefly keep handles open after marketplace IO — retry teardown. */
function rmUserData(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => join(tmpdir(), 'vyotiq-app'),
    getPath: (name: string) => {
      if (name === 'userData') return join(tmpdir(), 'vyotiq-userdata-mkt')
      return join(tmpdir(), name)
    }
  }
}))

describe('marketplace safePath', () => {
  const userData = join(tmpdir(), 'vyotiq-userdata-mkt')

  beforeEach(() => {
    mkdirSync(join(userData, 'marketplace', 'packages'), { recursive: true })
  })

  afterEach(() => {
    rmUserData(userData)
  })

  it('rejects traversal in id/version segments', async () => {
    const { resolveInsideMarketplacePackages, isSafeMarketplaceSegment } = await import(
      '@main/marketplace/safePath'
    )
    expect(isSafeMarketplaceSegment('..')).toBe(false)
    expect(isSafeMarketplaceSegment('a/b')).toBe(false)
    expect(isSafeMarketplaceSegment('good-pkg')).toBe(true)
    expect(() => resolveInsideMarketplacePackages('..', '1.0.0')).toThrow(/Invalid marketplace/)
    expect(() => resolveInsideMarketplacePackages('pkg', '..')).toThrow(/Invalid marketplace/)
  })

  it('rejects absolute and .. plugin-relative paths', async () => {
    const { resolveInsidePackageRoot } = await import('@main/marketplace/safePath')
    const root = join(userData, 'marketplace', 'packages', 'demo', '1.0.0')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'ok.md'), 'x')
    expect(resolveInsidePackageRoot(root, 'ok.md')).toBe(realpathSync(join(root, 'ok.md')))
    expect(() => resolveInsidePackageRoot(root, '../escape.md')).toThrow(/Unsafe/)
    expect(() => resolveInsidePackageRoot(root, '/etc/passwd')).toThrow(/Unsafe/)
  })

  it('rejects symlinks that escape the package root', async () => {
    const { symlinkSync } = await import('fs')
    const { resolveInsidePackageRoot } = await import('@main/marketplace/safePath')
    const root = join(userData, 'marketplace', 'packages', 'demo-link', '1.0.0')
    mkdirSync(root, { recursive: true })
    const outside = join(userData, 'outside-secret.txt')
    writeFileSync(outside, 'secret')
    try {
      symlinkSync(outside, join(root, 'leak.md'))
    } catch {
      // Windows without symlink privilege — skip
      return
    }
    expect(() => resolveInsidePackageRoot(root, 'leak.md')).toThrow(/Symlink|escapes/i)
  })

  it('rejects unsafe packagePath shapes', async () => {
    const { assertSafePackagePath } = await import('@main/marketplace/safePath')
    expect(assertSafePackagePath('demo/1.0.0')).toBe('demo/1.0.0')
    expect(() => assertSafePackagePath('../x')).toThrow()
    expect(() => assertSafePackagePath('only-one')).toThrow()
  })

  it('rejects catalog bundledPath/iconPath traversal at schema parse', async () => {
    const { MarketplaceCatalogEntrySchema } = await import('@shared/ipc/schemas/marketplace')
    const base = {
      id: 'demo',
      name: 'Demo',
      version: '1.0.0',
      kind: 'mcp' as const
    }
    expect(MarketplaceCatalogEntrySchema.safeParse({ ...base, bundledPath: 'ok/pkg' }).success).toBe(
      true
    )
    expect(
      MarketplaceCatalogEntrySchema.safeParse({ ...base, bundledPath: '../escape' }).success
    ).toBe(false)
    expect(
      MarketplaceCatalogEntrySchema.safeParse({ ...base, iconPath: 'icons/x.svg' }).success
    ).toBe(true)
    expect(
      MarketplaceCatalogEntrySchema.safeParse({ ...base, iconPath: '../../secret.svg' }).success
    ).toBe(false)
    expect(
      MarketplaceCatalogEntrySchema.safeParse({ ...base, bundledPath: 'C:/Windows/system32' }).success
    ).toBe(false)
    expect(
      MarketplaceCatalogEntrySchema.safeParse({ ...base, bundledPath: 'foo/C:/bar' }).success
    ).toBe(false)
    expect(
      MarketplaceCatalogEntrySchema.safeParse({ ...base, iconPath: '//server/share/x.svg' }).success
    ).toBe(false)
  })
})

describe('sanitizeMcpManifestEnv', () => {
  it('drops PATH and other process-control keys case-insensitively', async () => {
    const { sanitizeMcpManifestEnv } = await import('@main/marketplace/sanitizeMcpEnv')
    expect(
      sanitizeMcpManifestEnv({
        PATH: '/evil',
        Path: '/evil2',
        path: '/evil3',
        LD_PRELOAD: 'x.so',
        DYLD_INSERT_LIBRARIES: 'y.dylib',
        NODE_OPTIONS: '--require evil',
        PYTHONPATH: '/evil-py',
        NODE_PATH: '/evil-node',
        DOTNET_STARTUP_HOOKS: 'evil.dll',
        JAVA_TOOL_OPTIONS: '-javaagent:evil',
        BASH_ENV: '/evil.sh',
        OPENSSL_CONF: '/evil.conf',
        FOO: 'bar'
      })
    ).toEqual({ FOO: 'bar' })
    expect(sanitizeMcpManifestEnv(undefined)).toBeUndefined()
    expect(sanitizeMcpManifestEnv({ PATH: 'x' })).toBeUndefined()
  })

  it('treats mixed-case loader keys as blocked', async () => {
    const { sanitizeMcpManifestEnv, isBlockedMcpEnvKey } = await import(
      '@main/marketplace/sanitizeMcpEnv'
    )
    expect(isBlockedMcpEnvKey('pythonpath')).toBe(true)
    expect(isBlockedMcpEnvKey('Node_Options')).toBe(true)
    expect(isBlockedMcpEnvKey('MY_API_KEY')).toBe(false)
    expect(sanitizeMcpManifestEnv({ pythonpath: 'x', Api_Key: 'secret' })).toEqual({
      Api_Key: 'secret'
    })
  })
})

describe('isAllowedExternalMcpConfigPath', () => {
  it('allows default basenames under home and rejects arbitrary paths', async () => {
    const { isAllowedExternalMcpConfigPath, defaultExternalConfigPaths } = await import(
      '@main/marketplace/mcpImport'
    )
    const { join } = await import('path')
    const { homedir } = await import('os')

    for (const p of defaultExternalConfigPaths()) {
      expect(isAllowedExternalMcpConfigPath(p)).toBe(true)
    }
    expect(isAllowedExternalMcpConfigPath(join(homedir(), '.cursor', 'mcp.json'))).toBe(true)
    expect(isAllowedExternalMcpConfigPath(join(homedir(), 'secrets.txt'))).toBe(false)
    expect(isAllowedExternalMcpConfigPath('C:\\Windows\\System32\\config\\SAM')).toBe(false)
  })
})

describe('isContainmentOrSymlinkError', () => {
  it('classifies extract security failures', async () => {
    const { isContainmentOrSymlinkError } = await import('@main/marketplace/install')
    expect(isContainmentOrSymlinkError(new Error('Archive extract rejected symlink: x'))).toBe(true)
    expect(isContainmentOrSymlinkError(new Error('Archive extract escaped destination: y'))).toBe(
      true
    )
    expect(isContainmentOrSymlinkError(new Error('tar: Error opening archive'))).toBe(false)
  })
})

describe('assertSafeGitCloneUrl', () => {
  it('allows https/ssh/git@ and rejects http/git/file/ext/local', async () => {
    const { assertSafeGitCloneUrl } = await import('@main/marketplace/install')
    expect(assertSafeGitCloneUrl('https://github.com/org/repo.git')).toContain('https://')
    expect(assertSafeGitCloneUrl('git@github.com:org/repo.git')).toContain('git@')
    expect(assertSafeGitCloneUrl('ssh://git@github.com/org/repo.git')).toContain('ssh://')
    expect(() => assertSafeGitCloneUrl('http://github.com/org/repo.git')).toThrow(/not allowed/i)
    expect(() => assertSafeGitCloneUrl('git://github.com/org/repo.git')).toThrow(/not allowed/i)
    expect(() => assertSafeGitCloneUrl('file:///tmp/repo')).toThrow(/not allowed/i)
    expect(() => assertSafeGitCloneUrl('ext::sh -c evil')).toThrow(/not allowed/i)
    expect(() => assertSafeGitCloneUrl('/tmp/local-repo')).toThrow(/must be/i)
  })
})

describe('clearNestedPluginMcpSecrets', () => {
  const userData = join(tmpdir(), 'vyotiq-userdata-mkt')

  beforeEach(() => {
    mkdirSync(join(userData, 'marketplace', 'packages'), { recursive: true })
  })

  afterEach(() => {
    rmUserData(userData)
  })

  it('does not throw or read outside the package for traversal mcp paths', async () => {
    const { clearNestedPluginMcpSecrets, writeMarketplaceIndex } = await import(
      '@main/marketplace/indexStore'
    )
    const { marketplacePackageDir } = await import('@main/marketplace/paths')
    const { mkdirSync: mkdir, writeFileSync: write, existsSync } = await import('fs')

    writeMarketplaceIndex({ schemaVersion: 1, items: [] })
    const root = marketplacePackageDir('plug-escape', '1.0.0')
    mkdir(root, { recursive: true })
    const outside = join(userData, 'marketplace', 'packages', 'escape-target')
    mkdir(outside, { recursive: true })
    write(
      join(outside, 'vyotiq.mcp.json'),
      JSON.stringify({
        schemaVersion: 1,
        kind: 'mcp',
        id: 'leaked',
        name: 'Leaked',
        version: '1.0.0',
        transport: 'stdio',
        command: 'echo'
      })
    )
    write(
      join(root, 'vyotiq.plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        kind: 'plugin',
        id: 'plug-escape',
        name: 'Plug',
        version: '1.0.0',
        mcp: ['../escape-target']
      })
    )

    expect(() =>
      clearNestedPluginMcpSecrets({
        id: 'plug-escape',
        kind: 'plugin',
        name: 'Plug',
        version: '1.0.0',
        description: '',
        enabled: true,
        installSource: 'path',
        installedAt: new Date().toISOString(),
        packagePath: 'plug-escape/1.0.0'
      })
    ).not.toThrow()
    expect(existsSync(join(outside, 'vyotiq.mcp.json'))).toBe(true)
  })
})

describe('removeInstalledItem path consistency', () => {
  it('deletes via packagePath under packages root', async () => {
    const { upsertInstalledItem, removeInstalledItem, readMarketplaceIndex } = await import(
      '@main/marketplace/indexStore'
    )
    const { resolveInstalledPackageRoot } = await import('@main/marketplace/paths')
    const { existsSync, mkdirSync, writeFileSync, rmSync } = await import('fs')

    // Reset index cache by writing empty via upsert then filter — clear via write
    const { writeMarketplaceIndex } = await import('@main/marketplace/indexStore')
    writeMarketplaceIndex({ schemaVersion: 1, items: [] })

    const packagePath = 'demo-pkg/1.0.0'
    const dir = resolveInstalledPackageRoot(packagePath)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'marker.txt'), 'x')

    upsertInstalledItem({
      id: 'demo-pkg',
      kind: 'skill',
      name: 'Demo',
      version: '1.0.0',
      description: '',
      enabled: true,
      installSource: 'path',
      installedAt: new Date().toISOString(),
      packagePath
    })
    expect(existsSync(join(dir, 'marker.txt'))).toBe(true)

    removeInstalledItem('demo-pkg')
    expect(existsSync(dir)).toBe(false)
    expect(readMarketplaceIndex().items.find((i) => i.id === 'demo-pkg')).toBeUndefined()

    rmSync(join(tmpdir(), 'vyotiq-userdata-mkt', 'marketplace'), { recursive: true, force: true })
  })
})
