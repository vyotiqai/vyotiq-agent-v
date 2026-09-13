import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getAppPath: () => process.cwd(),
    isPackaged: false
  }
}))

import {
  DEFAULT_SETTINGS,
  type MarketplaceCatalog,
  type MarketplaceCatalogEntry
} from '@shared/ipc'

function entry(partial: Partial<MarketplaceCatalogEntry> & { id: string }): MarketplaceCatalogEntry {
  return {
    name: partial.id,
    version: '1.0.0',
    description: '',
    kind: 'skill',
    source: 'remote',
    ...partial
  }
}

describe('remote marketplace catalog', () => {
  let dir: string
  let cachePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-catalog-'))
    cachePath = join(dir, 'cache', 'catalog.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  async function setup(registryUrl: string) {
    const settingsMod = await import('@main/settings/settings')
    const pathsMod = await import('@main/marketplace/paths')
    const webFetchMod = await import('@main/agent/tools/webFetch')
    vi.spyOn(settingsMod, 'getSettings').mockReturnValue({
      ...DEFAULT_SETTINGS,
      marketplace: { ...DEFAULT_SETTINGS.marketplace, registryUrl }
    })
    vi.spyOn(pathsMod, 'marketplaceCatalogCachePath').mockReturnValue(cachePath)
    const fetchSpy = vi.spyOn(webFetchMod, 'fetchPublicResponse')
    const catalog = await import('@main/marketplace/catalog')
    return { fetchSpy, ...catalog }
  }

  function okFetchPayload(catalog: unknown): {
    response: Response
    finalUrl: URL
    body: Buffer
  } {
    return {
      response: new Response(null, { status: 200 }),
      finalUrl: new URL('https://registry.example/v1/catalog'),
      body: Buffer.from(JSON.stringify(catalog))
    }
  }

  function seedCache(catalog: unknown): void {
    mkdirSync(dirname(cachePath), { recursive: true })
    writeFileSync(cachePath, JSON.stringify(catalog))
  }

  it('fetches {registryUrl}/v1/catalog, stamps source remote, and writes the cache', async () => {
    const { fetchSpy, refreshRemoteCatalog } = await setup('https://registry.example/')
    fetchSpy.mockResolvedValue(
      okFetchPayload({
        schemaVersion: 1,
        packages: [{ id: 'remote-skill', name: 'Remote Skill', version: '2.0.0', kind: 'skill' }]
      })
    )

    const catalog = await refreshRemoteCatalog()

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0]?.[0].href).toBe('https://registry.example/v1/catalog')
    expect(catalog.packages).toHaveLength(1)
    expect(catalog.packages[0]).toMatchObject({ id: 'remote-skill', source: 'remote' })

    const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as MarketplaceCatalog
    expect(cached.packages[0]).toMatchObject({ id: 'remote-skill', source: 'remote' })
  })

  it('falls back to the cached catalog when the fetch rejects', async () => {
    const { fetchSpy, refreshRemoteCatalog } = await setup('https://registry.example')
    seedCache({
      schemaVersion: 1,
      packages: [{ id: 'cached-mcp', name: 'Cached MCP', version: '1.0.0', kind: 'mcp' }]
    })
    fetchSpy.mockRejectedValue(new Error('network down'))

    const catalog = await refreshRemoteCatalog()
    expect(catalog.packages.map((p) => p.id)).toEqual(['cached-mcp'])
  })

  it('falls back to the cached catalog on a non-OK HTTP status', async () => {
    const { fetchSpy, refreshRemoteCatalog } = await setup('https://registry.example')
    seedCache({
      schemaVersion: 1,
      packages: [{ id: 'cached-plugin', name: 'Cached Plugin', version: '1.0.0', kind: 'plugin' }]
    })
    fetchSpy.mockResolvedValue({
      response: new Response(null, { status: 503 }),
      finalUrl: new URL('https://registry.example/v1/catalog'),
      body: Buffer.from('')
    })

    const catalog = await refreshRemoteCatalog()
    expect(catalog.packages.map((p) => p.id)).toEqual(['cached-plugin'])
  })

  it('does not fetch without a registryUrl; empty when no cache exists', async () => {
    const { fetchSpy, refreshRemoteCatalog } = await setup('')
    const catalog = await refreshRemoteCatalog()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(catalog.packages).toEqual([])
  })

  it('mergeCatalogs prefers bundled entries on id conflict and stamps sources', async () => {
    const { mergeCatalogs } = await setup('')
    const merged = mergeCatalogs(
      { schemaVersion: 1, packages: [entry({ id: 'a', name: 'Bundled A', source: 'bundled' })] },
      {
        schemaVersion: 1,
        packages: [entry({ id: 'a', name: 'Remote A' }), entry({ id: 'b', name: 'Remote B' })]
      }
    )

    expect(merged.map((e) => e.id)).toEqual(['a', 'b'])
    expect(merged[0]).toMatchObject({ name: 'Bundled A', source: 'bundled' })
    expect(merged[1]).toMatchObject({ name: 'Remote B', source: 'remote' })
  })
})
