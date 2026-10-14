/**
 * resolveEffectiveMcpServers is asked with and without workspace overrides in
 * alternation (the run's step catalog vs every MCP invoke). Both answers must
 * come from cache until settings or the marketplace index change.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { cpSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'

const { USER_DATA, reads } = vi.hoisted(() => {
  const { mkdtempSync } = require('fs') as typeof import('fs')
  const { join: j } = require('path') as typeof import('path')
  const { tmpdir } = require('os') as typeof import('os')
  return { USER_DATA: mkdtempSync(j(tmpdir(), 'vyotiq-resolve-cache-')), reads: { manifests: 0 } }
})

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const readFileSync = ((path: unknown, ...rest: unknown[]) => {
    if (String(path).endsWith('vyotiq.mcp.json')) reads.manifests++
    return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest)
  }) as typeof actual.readFileSync
  return { ...actual, default: { ...actual, readFileSync }, readFileSync }
})
vi.mock('electron', () => ({
  app: { getPath: () => USER_DATA, getAppPath: () => process.cwd(), isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8')
  }
}))
vi.mock('@main/app/window', () => ({ getMainWindow: () => null }))
vi.mock('@main/marketplace/indexStore', () => ({
  readMarketplaceIndex: () => ({
    schemaVersion: 1,
    items: [
      { id: 'context7', kind: 'mcp', enabled: true, version: '1.0.0', packagePath: 'context7/1.0.0' }
    ]
  })
}))

import { invalidateMcpResolveCache, resolveEffectiveMcpServers } from '@main/marketplace/resolve'

beforeAll(() => {
  mkdirSync(join(USER_DATA, 'marketplace', 'packages', 'context7'), { recursive: true })
  cpSync(
    join(process.cwd(), 'resources', 'marketplace', 'packages', 'context7'),
    join(USER_DATA, 'marketplace', 'packages', 'context7', '1.0.0'),
    { recursive: true }
  )
})

afterAll(() => {
  rmSync(USER_DATA, { recursive: true, force: true })
})

describe('resolveEffectiveMcpServers cache', () => {
  it('serves both the with- and without-overrides view from cache', () => {
    invalidateMcpResolveCache()
    reads.manifests = 0
    const overrides = { mcp: { context7: false } }
    for (let i = 0; i < 10; i++) {
      expect(resolveEffectiveMcpServers(overrides).find((s) => s.id === 'context7')?.enabled).toBe(
        false
      )
      expect(resolveEffectiveMcpServers().find((s) => s.id === 'context7')?.enabled).toBe(true)
    }
    // One build per view, not one per call.
    expect(reads.manifests).toBe(2)
  })
})
