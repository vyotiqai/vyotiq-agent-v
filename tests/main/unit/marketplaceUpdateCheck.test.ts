import { describe, expect, it, vi } from 'vitest'
import { checkPackageUpdates, npmPackageName } from '@main/marketplace/updateCheck'
import type { MarketplaceInstalledItem } from '@shared/ipc'

const item = (partial: Partial<MarketplaceInstalledItem>): MarketplaceInstalledItem => ({
  id: 'pkg',
  kind: 'mcp',
  name: 'Pkg',
  version: '1.0.0',
  description: '',
  enabled: true,
  installSource: 'npm',
  installedAt: '2026-10-01T00:00:00.000Z',
  packagePath: 'pkg/1.0.0',
  ...partial
})

/** Check for updates: npm latest, a git remote's HEAD, a registry's catalog version. */
describe('checkPackageUpdates', () => {
  it('names the package without a version spec', () => {
    expect(npmPackageName('@scope/name@^1.2')).toBe('@scope/name')
    expect(npmPackageName('name@latest')).toBe('name')
    expect(npmPackageName('@scope/name')).toBe('@scope/name')
  })

  it('finds newer npm, git and registry versions, and skips what it cannot compare', async () => {
    const deps = {
      npmLatest: vi.fn(async () => '1.1.0'),
      gitHead: vi.fn(async () => 'b'.repeat(40)),
      registryVersion: vi.fn(async () => '2.0.0')
    }
    const result = await checkPackageUpdates(
      [
        item({ id: 'n', name: 'N', origin: { target: '@acme/n@1.0.0', ref: '1.0.0' } }),
        item({ id: 'same', name: 'Same', origin: { target: 'same', ref: '1.1.0' } }),
        item({ id: 'g', name: 'G', installSource: 'git', origin: { target: 'https://github.com/a/g', ref: 'a'.repeat(40) } }),
        item({ id: 'r', name: 'R', installSource: 'registry', origin: { target: 'r' } }),
        item({ id: 'old', name: 'Old' }),
        item({ id: 'b', name: 'B', installSource: 'bundled', origin: { target: 'b' } })
      ],
      deps
    )
    expect(result.checked).toBe(4)
    expect(result.failed).toEqual([])
    expect(result.updates).toEqual([
      { id: 'n', name: 'N', source: 'npm', current: '1.0.0', latest: '1.1.0', target: '@acme/n' },
      { id: 'g', name: 'G', source: 'git', current: 'aaaaaaa', latest: 'bbbbbbb', target: 'https://github.com/a/g' },
      { id: 'r', name: 'R', source: 'registry', current: '1.0.0', latest: '2.0.0', target: 'r' }
    ])
    expect(deps.npmLatest).toHaveBeenCalledWith('@acme/n')
  })

  it('lists a package it could not reach as failed, and carries on', async () => {
    const result = await checkPackageUpdates([item({ origin: { target: 'x' } })], {
      npmLatest: async () => {
        throw new Error('offline')
      },
      gitHead: async () => null,
      registryVersion: async () => null
    })
    expect(result).toEqual({ updates: [], checked: 1, failed: ['Pkg'] })
  })
})
