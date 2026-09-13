import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const userData = join(tmpdir(), `vyotiq-orphan-${process.pid}-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => join(tmpdir(), 'vyotiq-app'),
    getPath: (name: string) => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    }
  }
}))

import { purgeOrphanMarketplacePackageDirs } from '@main/marketplace/orphanCleanup'
import { writeMarketplaceIndex } from '@main/marketplace/indexStore'
import { marketplacePackagesRoot } from '@main/marketplace/paths'
import type { MarketplaceInstalledItem } from '@shared/ipc'

function installedItem(id: string): MarketplaceInstalledItem {
  return {
    id,
    kind: 'mcp',
    name: id,
    version: '1.0.0',
    description: '',
    enabled: true,
    installSource: 'registry',
    installedAt: '2026-01-01T00:00:00.000Z',
    packagePath: `${id}/1.0.0`
  }
}

function seedIndex(ids: string[]): void {
  writeMarketplaceIndex({ schemaVersion: 1, items: ids.map(installedItem) })
}

describe('purgeOrphanMarketplacePackageDirs', () => {
  beforeEach(() => {
    mkdirSync(userData, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
  })

  it('removes nothing when the packages root does not exist', () => {
    seedIndex([])
    expect(purgeOrphanMarketplacePackageDirs()).toEqual({ removed: 0 })
  })

  it('removes an empty unindexed package dir', () => {
    seedIndex([])
    const orphan = join(marketplacePackagesRoot(), 'accessibility')
    mkdirSync(orphan, { recursive: true })

    expect(purgeOrphanMarketplacePackageDirs()).toEqual({ removed: 1 })
    expect(existsSync(orphan)).toBe(false)
  })

  it('removes dirs that contain only empty nested dirs', () => {
    seedIndex([])
    const orphan = join(marketplacePackagesRoot(), 'nested-empty')
    mkdirSync(join(orphan, '1.0.0', 'deep', 'deeper'), { recursive: true })

    expect(purgeOrphanMarketplacePackageDirs()).toEqual({ removed: 1 })
    expect(existsSync(orphan)).toBe(false)
  })

  it('keeps an unindexed dir that still contains files', () => {
    seedIndex([])
    const kept = join(marketplacePackagesRoot(), 'filesystem')
    mkdirSync(join(kept, '1.0.0'), { recursive: true })
    writeFileSync(join(kept, '1.0.0', 'manifest.json'), '{}', 'utf8')

    expect(purgeOrphanMarketplacePackageDirs()).toEqual({ removed: 0 })
    expect(existsSync(join(kept, '1.0.0', 'manifest.json'))).toBe(true)
  })

  it('keeps an indexed package dir even when it is empty', () => {
    seedIndex(['filesystem'])
    const indexed = join(marketplacePackagesRoot(), 'filesystem')
    mkdirSync(indexed, { recursive: true })

    expect(purgeOrphanMarketplacePackageDirs()).toEqual({ removed: 0 })
    expect(existsSync(indexed)).toBe(true)
  })

  it('ignores non-directory entries in the packages root', () => {
    seedIndex([])
    mkdirSync(marketplacePackagesRoot(), { recursive: true })
    const stray = join(marketplacePackagesRoot(), 'partial-download.tmp')
    writeFileSync(stray, 'x', 'utf8')

    expect(purgeOrphanMarketplacePackageDirs()).toEqual({ removed: 0 })
    expect(existsSync(stray)).toBe(true)
  })

  it('sweeps only the empty unindexed dirs from a mixed packages root', () => {
    seedIndex(['indexed-pkg'])
    const root = marketplacePackagesRoot()
    mkdirSync(join(root, 'empty-orphan'), { recursive: true })
    mkdirSync(join(root, 'file-orphan'), { recursive: true })
    writeFileSync(join(root, 'file-orphan', 'leftover.txt'), 'x', 'utf8')
    mkdirSync(join(root, 'indexed-pkg'), { recursive: true })

    expect(purgeOrphanMarketplacePackageDirs()).toEqual({ removed: 1 })
    expect(existsSync(join(root, 'empty-orphan'))).toBe(false)
    expect(existsSync(join(root, 'file-orphan', 'leftover.txt'))).toBe(true)
    expect(existsSync(join(root, 'indexed-pkg'))).toBe(true)
  })
})
