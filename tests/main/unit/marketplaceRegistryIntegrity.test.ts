import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { MarketplaceCatalogEntry } from '@shared/ipc'

const execFileAsync = promisify(execFile)

const userData = join(tmpdir(), `vyotiq-registry-integrity-${process.pid}-${Date.now()}`)
const REGISTRY = 'https://registry.example'
const PKG_ID = 'digest-demo-skill'

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

const downloadMock = vi.fn()
const fetchMock = vi.fn()
vi.mock('@main/agent/tools/webFetch', () => ({
  downloadPublicUrlToFile: (...args: unknown[]) => downloadMock(...args),
  fetchPublicResponse: (...args: unknown[]) => fetchMock(...args)
}))

let archiveBytes: Buffer = Buffer.alloc(0)
let archiveSha256 = ''

let hostileArchiveBytes: Buffer = Buffer.alloc(0)

/** Build one 512-byte USTAR header for a regular file (checksum included). */
function ustarHeader(name: string, size: number): Buffer {
  const buf = Buffer.alloc(512)
  buf.write(name, 0, 100, 'utf8')
  buf.write('0000644\0', 100)
  buf.write('0000000\0', 108)
  buf.write('0000000\0', 116)
  buf.write(size.toString(8).padStart(11, '0') + '\0', 124, 12)
  buf.write('00000000000\0', 136, 12)
  buf.write('        ', 148, 8)
  buf.write('0', 156, 1)
  buf.write('ustar\0', 257, 6)
  buf.write('00', 263, 2)
  let sum = 0
  for (const byte of buf) sum += byte
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
  return buf
}

/**
 * Pack entries into an uncompressed USTAR tarball by hand. `tar -cf` cannot
 * portably create `..` member names (bsdtar and GNU tar both refuse them at
 * creation), so the hostile fixture's bytes are constructed directly.
 */
function ustarArchive(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = []
  for (const entry of entries) {
    parts.push(ustarHeader(entry.name, entry.data.length), entry.data)
    const pad = (512 - (entry.data.length % 512)) % 512
    if (pad) parts.push(Buffer.alloc(pad))
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}

beforeAll(async () => {
  // Real gzipped tarball holding a valid skill package. The registry branch names
  // the download `pkg.zip` and tar -xf auto-detects gzip, so this mirrors what a
  // registry actually serves while staying cross-platform (bsdtar + GNU tar).
  const srcDir = mkdtempSync(join(tmpdir(), 'vyotiq-registry-integrity-src-'))
  try {
    writeFileSync(
      join(srcDir, 'SKILL.md'),
      `---
name: ${PKG_ID}
description: A skill for testing registry digest verification.
---

Instructions.
`
    )
    const tgz = join(srcDir, 'pkg.tgz')
    await execFileAsync('tar', ['-czf', tgz, '-C', srcDir, 'SKILL.md'])
    archiveBytes = readFileSync(tgz)
    archiveSha256 = createHash('sha256').update(archiveBytes).digest('hex')
  } finally {
    rmSync(srcDir, { recursive: true, force: true })
  }

  // Hostile fixture: plain USTAR tarball carrying a `../evil.txt` member next
  // to a valid skill root. Served through the registry download mock as
  // pkg.zip; `tar -tf` lists both members so the pre-scan sees the escape.
  hostileArchiveBytes = ustarArchive([
    {
      name: 'SKILL.md',
      data: Buffer.from(
        `---\nname: ${PKG_ID}\ndescription: Hostile archive fixture.\n---\n\nInstructions.\n`,
        'utf8'
      )
    },
    { name: '../evil.txt', data: Buffer.from('escaped\n', 'utf8') }
  ])
})

afterAll(() => {
  rmSync(userData, { recursive: true, force: true })
})

beforeEach(() => {
  mkdirSync(userData, { recursive: true })
  getSettingsMock.mockReset()
  getSettingsMock.mockReturnValue({
    marketplace: { registryUrl: REGISTRY, remoteInstallAcked: true },
    mcpServers: []
  })
  downloadMock.mockReset()
  downloadMock.mockImplementation(async (_url: string, destPath: string) => {
    writeFileSync(destPath, archiveBytes)
  })
  fetchMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(userData, { recursive: true, force: true })
})

function catalogEntry(sha256?: string): MarketplaceCatalogEntry {
  return {
    id: PKG_ID,
    name: 'Digest Demo Skill',
    version: '1.0.0',
    description: '',
    kind: 'skill',
    source: 'remote',
    downloadUrl: `${REGISTRY}/v1/packages/${PKG_ID}/versions/1.0.0/download`,
    ...(sha256 ? { sha256 } : {})
  }
}

/** Run a registry install against a mocked catalog entry with the given digest. */
async function installFromRegistry(sha256?: string) {
  const catalogMod = await import('@main/marketplace/catalog')
  vi.spyOn(catalogMod, 'refreshRemoteCatalog').mockResolvedValue({
    schemaVersion: 1,
    packages: []
  })
  vi.spyOn(catalogMod, 'browseCatalog').mockResolvedValue([catalogEntry(sha256)])
  const { installMarketplacePackage } = await import('@main/marketplace/install')
  return installMarketplacePackage({ source: 'registry', target: PKG_ID })
}

describe('assertRegistryDownloadUrl https gate', () => {
  it('rejects a plain-http registry URL', async () => {
    const { assertRegistryDownloadUrl } = await import('@main/marketplace/install')
    expect(() =>
      assertRegistryDownloadUrl(
        'http://registry.example/v1/packages/a/versions/1/download',
        'http://registry.example'
      )
    ).toThrow(/must use https/i)
  })

  it('rejects an http download URL against an https registry', async () => {
    const { assertRegistryDownloadUrl } = await import('@main/marketplace/install')
    expect(() =>
      assertRegistryDownloadUrl('http://registry.example/pkg.zip', REGISTRY)
    ).toThrow(/match the configured registry origin/i)
  })

  it('accepts a download URL on the configured https registry origin', async () => {
    const { assertRegistryDownloadUrl } = await import('@main/marketplace/install')
    expect(
      assertRegistryDownloadUrl(`${REGISTRY}/v1/packages/a/versions/1/download`, REGISTRY)
    ).toMatch(/registry\.example/)
  })
})

describe('MarketplaceCatalogEntrySchema sha256 field', () => {
  it('accepts a 64-char lowercase hex digest and rejects anything else', async () => {
    const { MarketplaceCatalogEntrySchema } = await import('@shared/ipc')
    const base = {
      id: 'demo',
      name: 'Demo',
      version: '1.0.0',
      kind: 'skill' as const
    }
    expect(
      MarketplaceCatalogEntrySchema.safeParse({ ...base, sha256: 'a'.repeat(64) }).success
    ).toBe(true)
    expect(
      MarketplaceCatalogEntrySchema.safeParse({ ...base, sha256: 'not-hex' }).success
    ).toBe(false)
    expect(
      MarketplaceCatalogEntrySchema.safeParse({ ...base, sha256: 'A'.repeat(64) }).success
    ).toBe(false)
  })
})

describe('registry install sha256 verification', () => {
  it('aborts the install when the downloaded archive digest does not match', async () => {
    await expect(installFromRegistry('0'.repeat(64))).rejects.toThrow(/sha256 mismatch/i)
    expect(downloadMock).toHaveBeenCalledTimes(1)
    // Temp tree (including the downloaded archive) is cleaned up on abort.
    const destPath = downloadMock.mock.calls[0]?.[1] as string
    expect(existsSync(destPath)).toBe(false)
  })

  it('proceeds to extract and install when the digest matches', async () => {
    const result = await installFromRegistry(archiveSha256)
    expect(result.item.id).toBe(PKG_ID)
    expect(result.item.kind).toBe('skill')
    expect(result.item.installSource).toBe('registry')
    const pathsMod = await import('@main/marketplace/paths')
    const root = pathsMod.resolveInstalledPackageRoot(result.item.packagePath)
    expect(existsSync(join(root, 'SKILL.md'))).toBe(true)
  })

  it('still installs when the catalog entry carries no sha256 (digest is optional)', async () => {
    const result = await installFromRegistry()
    expect(result.item.id).toBe(PKG_ID)
    expect(result.item.installSource).toBe('registry')
  })
})

describe('refreshRemoteCatalog https gate', () => {
  it('refuses to fetch a plain-http registry and falls back to the cached catalog', async () => {
    getSettingsMock.mockReturnValue({
      marketplace: { registryUrl: 'http://registry.example', remoteInstallAcked: true },
      mcpServers: []
    })
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-registry-integrity-cache-'))
    const cachePath = join(dir, 'cache', 'catalog.json')
    try {
      mkdirSync(dirname(cachePath), { recursive: true })
      writeFileSync(
        cachePath,
        JSON.stringify({
          schemaVersion: 1,
          packages: [{ id: 'cached-skill', name: 'Cached Skill', version: '1.0.0', kind: 'skill' }]
        })
      )
      const pathsMod = await import('@main/marketplace/paths')
      vi.spyOn(pathsMod, 'marketplaceCatalogCachePath').mockReturnValue(cachePath)
      const { refreshRemoteCatalog } = await import('@main/marketplace/catalog')

      const catalog = await refreshRemoteCatalog()

      expect(fetchMock).not.toHaveBeenCalled()
      expect(catalog.packages.map((p) => p.id)).toEqual(['cached-skill'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('archive entry pre-scan', () => {
  it('rejects escaping entry names', async () => {
    const { assertArchiveEntryNameContained } = await import('@main/marketplace/install')
    expect(() => assertArchiveEntryNameContained('../evil.txt')).toThrow(/escaping entry/i)
    expect(() => assertArchiveEntryNameContained('..\\evil.txt')).toThrow(/escaping entry/i)
    expect(() => assertArchiveEntryNameContained('package/../evil.txt')).toThrow(/escaping entry/i)
    expect(() => assertArchiveEntryNameContained('/etc/passwd')).toThrow(/escaping entry/i)
    expect(() => assertArchiveEntryNameContained('C:\\evil.txt')).toThrow(/escaping entry/i)
    expect(() => assertArchiveEntryNameContained('./')).toThrow(/escaping entry/i)
  })

  it('accepts contained entry names', async () => {
    const { assertArchiveEntryNameContained } = await import('@main/marketplace/install')
    expect(() => assertArchiveEntryNameContained('SKILL.md')).not.toThrow()
    expect(() => assertArchiveEntryNameContained('package/SKILL.md')).not.toThrow()
    expect(() => assertArchiveEntryNameContained('./package/SKILL.md')).not.toThrow()
    expect(() => assertArchiveEntryNameContained('sub/dir/')).not.toThrow()
  })

  it('aborts the registry install before extraction when an archive entry escapes destDir', async () => {
    downloadMock.mockImplementation(async (_url: string, destPath: string) => {
      writeFileSync(destPath, hostileArchiveBytes)
    })
    await expect(installFromRegistry()).rejects.toThrow(/rejected escaping entry/i)
    expect(downloadMock).toHaveBeenCalledTimes(1)
    // The pre-scan aborts before tar runs: no extract dir, and no escaped
    // file next to it. installMarketplacePackage does not run the temp-tree
    // cleanup on this abort path (pre-existing behavior, same as post-extract
    // containment aborts), so tidy the leaked temp tree up ourselves.
    const destPath = downloadMock.mock.calls[0]?.[1] as string
    const tmpRoot = dirname(destPath)
    try {
      expect(existsSync(join(tmpRoot, 'evil.txt'))).toBe(false)
      expect(existsSync(join(tmpRoot, 'extract'))).toBe(false)
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  })
})
