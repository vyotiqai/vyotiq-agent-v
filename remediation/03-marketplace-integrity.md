# Remediation 03 — Marketplace registry integrity (finding H3)

Scope: enforce `https:` for network package registries (catalog fetch + package download) and add
optional `sha256` digest verification of the downloaded archive before extraction. Also corrects
the stale tar containment comment. No new dependencies; all changes are minimal, in-repo-style
`old_string → new_string` pairs (each `old_string` is unique in its file).

## 1. registryUrl configuration/usage — end-to-end trace (evidence)

**Configuration surface (schema + default)**

- `src/shared/ipc/schemas/marketplace.ts:251` — `MarketplaceSettingsSchema.registryUrl:
  z.string().default('')`; `src/shared/ipc/schemas/marketplace.ts:257` —
  `DEFAULT_MARKETPLACE_SETTINGS.registryUrl: ''` (empty by default: no remote registry).
- `src/main/settings/settings.ts:616-623` — `setSettings` merge logic: changing `registryUrl`
  clears `remoteInstallAcked`, so a new endpoint can never reuse a prior install consent.
- Renderer input: `src/renderer/src/features/marketplace/RegistrySettingsPanel.tsx:18,56-78` —
  the only UI that writes `registryUrl`; validated by `isValidHttpUrl`
  (`src/renderer/src/features/settings/utils/settingsHelpers.ts:4-7`), which currently accepts
  **both `http:` and `https:`** (main-process gate below is the enforcement boundary).

**Consumers of `registryUrl` (all of them)**

- Catalog fetch: `src/main/marketplace/catalog.ts:51-55` — `refreshRemoteCatalog()` builds
  `` `${registryUrl}/v1/catalog` `` and calls `fetchPublicResponse` (`catalog.ts:59`).
- Package download: `src/main/marketplace/install.ts:588` — registry branch of
  `materializeToTemp` reads `getSettings().marketplace?.registryUrl`; `install.ts:594` builds the
  default `{registryUrl}/v1/packages/{id}/versions/{version}/download` URL; `install.ts:600` is the
  **sole call site** of `assertRegistryDownloadUrl` (verified by grep — one occurrence).
- Browse gating: `src/main/marketplace/catalog.ts:99-105` — `browseCatalog` only consults the
  remote catalog when `registryUrl` is non-empty.
- Renderer refresh trigger: `src/renderer/src/features/marketplace/useMarketplaceController.ts:187-198`.

**No non-network scheme exists — http must be rejected outright**

- The only download/fetch implementation is `src/main/agent/tools/webFetch.ts`:
  `downloadPublicUrlToFile` (`webFetch.ts:760-764`, 100 MB cap) and `fetchPublicResponse`
  (`webFetch.ts:714`) both go through the SSRF-safe request path that accepts **only `http:`/`https:`**
  (`webFetch.ts:80-82` — `Unsupported protocol ... use http(s)`; `webFetch.ts:143`).
- There is no `file://`/local-path registry anywhere in the flow (bundled packages bypass the
  network entirely via `entry.bundledPath`, `install.ts:580-586`).
- Conclusion: every registry path is networked, so the gate requires `https:` outright. Nothing
  legitimate is lost.

**Digest precedent (existing crypto pattern)**

- `src/main/agent/checkpoints.ts:88` — `createHash('sha256').update(readFileSync(path)).digest('hex')`
  is the repo's established file-digest idiom; `downloadPublicUrlToFile` caps downloads at
  100 MB (`webFetch.ts:764`), so a whole-file read is bounded and acceptable.
- Hex-digest schema precedent: `src/shared/ipc/schemas/files.ts:55` —
  `sha256: z.string().regex(/^[a-f0-9]{64}$/)`.

---

## 2. Fix pairs (grouped by file)

### 2.1 `src/shared/ipc/schemas/marketplace.ts` — optional `sha256` on catalog entries

Anchor at lines 170-172 (`MarketplaceCatalogEntrySchema`, `downloadUrl` at :171). `old_string` is
unique — `downloadUrl:` appears once in this file.

**old_string**

```ts
  kind: MarketplaceKindSchema,
  downloadUrl: z.string().optional(),
  bundledPath: MarketplaceRelPathSchema.optional(),
```

**new_string**

```ts
  kind: MarketplaceKindSchema,
  downloadUrl: z.string().optional(),
  /** Optional hex sha256 digest of the version archive — verified before extraction. */
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  bundledPath: MarketplaceRelPathSchema.optional(),
```

### 2.2 `src/main/marketplace/install.ts` — crypto import

Anchor at line 16. `old_string` is unique.

**old_string**

```ts
import { randomBytes } from 'crypto'
```

**new_string**

```ts
import { createHash, randomBytes } from 'crypto'
```

### 2.3 `src/main/marketplace/install.ts` — HTTPS gate in `assertRegistryDownloadUrl`

Anchor at lines 90-93. `old_string` is unique (`return downloadUrl` occurs once). With the
registry forced to `https:`, the existing origin check at :90 also rejects any `http:` download
(protocol inequality), so no separate download-scheme check is needed.

**old_string**

```ts
  if (download.protocol !== registry.protocol || download.host !== registry.host) {
    throw new Error('Catalog download URL must match the configured registry origin')
  }
  return downloadUrl
```

**new_string**

```ts
  // Network registries must be https only. The download helper is http(s)-only
  // (no file:// registry exists), so plain http is rejected outright.
  if (registry.protocol !== 'https:') {
    throw new Error('Marketplace registry URL must use https: (plain http is not allowed)')
  }
  if (download.protocol !== registry.protocol || download.host !== registry.host) {
    throw new Error('Catalog download URL must match the configured registry origin')
  }
  return downloadUrl
```

### 2.4 `src/main/marketplace/install.ts` — verify archive digest before extraction

Anchor at lines 600-603 (registry branch of `materializeToTemp`: `assertRegistryDownloadUrl` call
at :600, download at :602). `old_string` is unique. On mismatch, `cleanup()` removes the temp
tree (including the downloaded archive) before throwing — matching the existing abort convention
in this branch (e.g. `install.ts:597-599`). `readFileSync` is already imported (`install.ts:7`);
`createHash` comes from pair 2.2; `entry.sha256` exists via pair 2.1.

**old_string**

```ts
    assertRegistryDownloadUrl(downloadUrl, registryUrl)
    const archivePath = join(tmp, 'pkg.zip')
    await downloadToFile(downloadUrl, archivePath)
    const extractDir = join(tmp, 'extract')
```

**new_string**

```ts
    assertRegistryDownloadUrl(downloadUrl, registryUrl)
    const archivePath = join(tmp, 'pkg.zip')
    await downloadToFile(downloadUrl, archivePath)
    // Verify the archive digest before extraction when the catalog provides one.
    if (entry.sha256) {
      const actual = createHash('sha256').update(readFileSync(archivePath)).digest('hex')
      if (actual !== entry.sha256.toLowerCase()) {
        cleanup()
        throw new Error(
          `Archive sha256 mismatch for ${entry.id}: expected ${entry.sha256}, got ${actual}`
        )
      }
    }
    const extractDir = join(tmp, 'extract')
```

### 2.5 `src/main/marketplace/install.ts` — correct the tar containment comment

Anchor at lines 187-188. Probe evidence: tar/libarchive **refuses `..` entries** but **sanitizes
absolute entries** (drive letter stripped, contained under `-C destDir`), and `assertExtractContained`
(`install.ts:158-178`) is the post-extract backstop. `old_string` is unique.

**old_string**

```ts
  // Prefer tar/libarchive for zip and tgz — it refuses `..` / absolute entry paths.
  // Avoid Expand-Archive / unzip which do not enforce zip-slip containment.
```

**new_string**

```ts
  // Prefer tar/libarchive for zip and tgz — it refuses `..` entry paths and sanitizes
  // absolute entries (drive letter stripped, contained under destDir); the
  // assertExtractContained call below is the post-extract backstop.
  // Avoid Expand-Archive / unzip which do not enforce zip-slip containment.
```

### 2.6 `src/main/marketplace/catalog.ts` — HTTPS gate on the catalog fetch

Anchor at lines 55-56 (`refreshRemoteCatalog`). `old_string` is unique. Placing the check inside
the existing `try` keeps the function's never-throw contract: a plain-http registry is logged via
the existing `logger.warn` catch (`catalog.ts:70-74`) and degrades to the cached catalog, exactly
like any other fetch failure — no new control-flow style.

**old_string**

```ts
  const url = `${registryUrl}/v1/catalog`
  try {
```

**new_string**

```ts
  const url = `${registryUrl}/v1/catalog`
  try {
    // Network registries must be https; plain http is refused here and falls
    // through to the cached catalog below (same as any fetch failure).
    if (new URL(url).protocol !== 'https:') {
      throw new Error('Marketplace registry URL must use https: (plain http is not allowed)')
    }
```

### Not included (optional follow-up, not required for the fix)

- `src/renderer/src/features/settings/utils/settingsHelpers.ts:4-7` — `isValidHttpUrl` still
  accepts `http:` for the Registry URL input field (`RegistrySettingsPanel.tsx:59,66-78`). The
  main-process gate (pairs 2.3/2.6) is the security boundary; tightening the renderer hint is a
  cosmetic UX nicety and was left out to keep this change minimal.

---

## 3. Tests — `tests/main/unit/marketplaceRegistryIntegrity.test.ts` (new file, full contents)

Conventions followed: vitest explicit imports (`globals: false`), node environment
(`vitest.config.ts:18-19`), electron/settings `vi.mock` pattern from
`tests/main/unit/marketplaceInstallSecurity.test.ts:16-42`, module `vi.spyOn` pattern from
`tests/main/unit/marketplaceCatalog.test.ts:44-58`, SKILL.md fixture shape from
`tests/main/unit/marketplace.test.ts:232-247`.

```ts
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
```

Existing tests that keep covering adjacent behavior (no edits needed — current expectations remain
true after the pairs): `tests/main/unit/marketplaceInstallSecurity.test.ts:141-151` (origin-match
guard uses `https://`), `tests/main/unit/marketplaceCatalog.test.ts:76-94` (https registry fetch),
`tests/main/unit/marketplaceSafePath.test.ts:78+` (schema path fields).

---

## 4. Parent verification checklist

Apply the six pairs in order 2.1 → 2.2 → 2.3 → 2.4 → 2.5 → 2.6, drop the test file in place, then:

1. **Targeted suites** (fast signal):
   `pnpm vitest run tests/main/unit/marketplaceRegistryIntegrity.test.ts tests/main/unit/marketplaceInstallSecurity.test.ts tests/main/unit/marketplaceCatalog.test.ts tests/main/unit/marketplace.test.ts tests/main/unit/marketplaceSafePath.test.ts tests/shared/marketplaceIconUrl.test.ts`
   - New file must pass: http registry rejected; http download vs https registry rejected; https
     origin accepted; sha256 schema accepts hex / rejects non-hex; digest mismatch aborts with
     temp cleanup; digest match installs; digest-less entry installs; http registry never fetched.
2. **Renderer marketplace suites** (touched settings surface is shared):
   `pnpm vitest run tests/renderer/marketplace/`
3. **Settings ack regression** (registryUrl change clears ack — untouched but adjacent):
   `pnpm vitest run tests/main/unit/settingsMcpAck.test.ts tests/main/unit/mcpImport.test.ts`
4. **Typecheck**: `pnpm typecheck` (pairs touch `src/shared/ipc/schemas/marketplace.ts` consumed by
   both node and web tsconfigs).
5. **Lint**: `pnpm lint` (convention match for the touched files).
6. Full gate when convenient: `pnpm test`.

Expected residual risk: none of the pairs changes behavior for `https:` registries or bundled
installs; the only behavioral changes are (a) plain-http registries now fail catalog fetch
(graceful cache fallback) and hard-fail downloads, and (b) entries that publish a `sha256` now
require an exact digest match before extraction.
