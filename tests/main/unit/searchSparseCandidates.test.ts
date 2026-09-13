import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const queryIndexCandidates = vi.fn()

vi.mock('@main/agent/codeindex', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/codeindex')>()
  return {
    ...actual,
    queryIndexCandidates: (...args: unknown[]) => queryIndexCandidates(...args)
  }
})

vi.mock('@main/agent/tools/walk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/tools/walk')>()
  return {
    ...actual,
    collectWorkspaceFilesPage: async (root: string) => ({
      files: [{ full: join(root, 'prefix.ts'), rel: 'prefix.ts' }],
      lastRel: 'prefix.ts',
      exhausted: true,
      cursorMissing: false
    })
  }
})

import { toolSearch } from '@main/agent/tools/search'

describe('toolSearch index candidates', () => {
  let root: string

  afterEach(() => {
    queryIndexCandidates.mockReset()
    if (existsSync(root)) rmSync(root, { recursive: true, force: true })
  })

  it('content-searches index hits even when they are outside the filename walk prefix', async () => {
    root = mkdtempSync(join(tmpdir(), 'vyotiq-search-sparse-'))
    writeFileSync(join(root, 'prefix.ts'), 'export const prefixOnly = 1\n', 'utf8')
    mkdirSync(join(root, 'deep'), { recursive: true })
    writeFileSync(join(root, 'deep', 'hit.ts'), 'export const uniqueSparseMarker = 1\n', 'utf8')
    queryIndexCandidates.mockResolvedValue({
      lookup: { ok: true, paths: ['deep/hit.ts'], mode: 'trigram' },
      fileCount: 2,
      syncComplete: true
    })
    const out = await toolSearch(root, 'uniqueSparseMarker', 10)
    expect(out).toMatch(/deep\/hit\.ts/)
    expect(out).toMatch(/index=trigram/)
  })

  it('live-scans content when the trigram prune returns no candidates', async () => {
    root = mkdtempSync(join(tmpdir(), 'vyotiq-search-sparse-empty-'))
    writeFileSync(join(root, 'prefix.ts'), 'export const prefixOnly = 1\n', 'utf8')
    queryIndexCandidates.mockResolvedValue({
      lookup: { ok: true, paths: [], mode: 'trigram' },
      fileCount: 1,
      syncComplete: true
    })
    const out = await toolSearch(root, 'prefixOnly', 10)
    expect(out).toMatch(/prefix\.ts/)
    expect(out).toMatch(/index=live/)
  })
})
