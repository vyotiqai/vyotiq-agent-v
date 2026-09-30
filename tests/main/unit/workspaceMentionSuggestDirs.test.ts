import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// A real walk of a real directory, counted: one pass has to serve both lists.
vi.mock('@main/agent/tools/walk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/tools/walk')>()
  return { ...actual, collectWorkspaceEntries: vi.fn(actual.collectWorkspaceEntries) }
})

vi.mock('@main/git/git', () => ({ readGitStatus: vi.fn() }))

import { collectWorkspaceEntries } from '@main/agent/tools/walk'
import {
  invalidateWorkspaceFileListCache,
  readWorkspaceEntriesCached,
  readWorkspaceFileListCached
} from '@main/workspace/fileListCache'
import { rankSuggestPaths } from '@main/workspace/suggestPaths'

const walk = vi.mocked(collectWorkspaceEntries)

describe('mention suggest: folders come from the same walk', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vyotiq-suggest-dirs-'))
    mkdirSync(join(root, 'src', 'components'), { recursive: true })
    writeFileSync(join(root, 'src', 'components', 'Composer.tsx'), '')
    mkdirSync(join(root, 'notes'))
    writeFileSync(join(root, 'notes', 'index.md'), '')
    // Never listed, whatever the picker asks for.
    mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'left-pad', 'pad.ts'), '')
    mkdirSync(join(root, 'clone', '.git'), { recursive: true })
    writeFileSync(join(root, 'clone', 'nested.ts'), '')
    invalidateWorkspaceFileListCache()
    walk.mockClear()
  })

  afterEach(() => {
    invalidateWorkspaceFileListCache()
    rmSync(root, { recursive: true, force: true })
  })

  it('returns the directories it descended into next to the files', async () => {
    const { files, dirs } = await collectWorkspaceEntries(root, 100)
    expect(files.map((f) => f.rel).sort()).toEqual([
      'notes/index.md',
      'src/components/Composer.tsx'
    ])
    // Root is not a row, and neither is anything the walk never descends:
    // `node_modules` is ignored outright, `clone` holds its own .git.
    expect([...dirs].sort()).toEqual(['notes', 'src', 'src/components'])
  })

  it('serves files and dirs from one shared walk', async () => {
    const [first, second] = await Promise.all([
      readWorkspaceEntriesCached(root),
      readWorkspaceEntriesCached(root)
    ])
    expect(first.dirs).toEqual(second.dirs)
    expect(await readWorkspaceEntriesCached(root)).toBe(first)
    // The file-only reader is the same list, not a walk of its own.
    expect(await readWorkspaceFileListCached(root)).toBe(first.files)
    expect(walk).toHaveBeenCalledTimes(1)
  })
})

describe('rankSuggestPaths', () => {
  const files = ['src/app/AppShell.tsx', 'src/applyPatch.ts', 'docs/apply.md']
  const dirs = ['src/app', 'src/apply', 'src/applyPatch']

  it('ranks folders the same way as files', () => {
    const result = rankSuggestPaths(files, dirs, 'apply', 24)
    // Both match on a whole segment, so name order decides — as it did before
    // folders existed.
    expect(result.paths).toEqual(['docs/apply.md', 'src/applyPatch.ts'])
    expect(result.dirs).toEqual(['src/apply', 'src/applyPatch'])
  })

  it('puts a path whose segment starts with the query ahead of one that merely contains it', () => {
    const result = rankSuggestPaths(
      // Name order alone would put aardvarkApply first; the query starts a
      // segment in applyOne, and only there.
      ['src/aardvarkApply.ts', 'src/applyOne.ts'],
      ['src/deep/aapply', 'src/apply'],
      'apply',
      24
    )
    expect(result.paths).toEqual(['src/applyOne.ts', 'src/aardvarkApply.ts'])
    expect(result.dirs).toEqual(['src/apply', 'src/deep/aapply'])
  })

  it('folds case and backslashes in the query', () => {
    // A Windows-typed query is read as a path, and case never matters.
    expect(
      rankSuggestPaths(
        ['src/components/Composer.tsx', 'src/components/deep/Other.tsx', 'src/other/index.ts'],
        ['src/components', 'src/other'],
        '  SRC\\Components ',
        24
      )
    ).toEqual({
      paths: ['src/components/Composer.tsx', 'src/components/deep/Other.tsx'],
      dirs: ['src/components'],
      total: 2
    })
  })

  it('counts only file matches in total, so paging is unchanged', () => {
    expect(rankSuggestPaths(files, dirs, 'apply', 24).total).toBe(2)
    expect(rankSuggestPaths(files, dirs, undefined, 24)).toEqual({
      paths: [...files].sort((a, b) => a.localeCompare(b)),
      dirs: [...dirs].sort((a, b) => a.localeCompare(b)),
      total: 3
    })
  })

  it('drops paths that are not workspace-relative', () => {
    const result = rankSuggestPaths(
      ['../outside.ts', '/etc/passwd', 'C:/win.ts', 'src/ok.ts'],
      ['../elsewhere', 'src/ok'],
      undefined,
      24
    )
    expect(result.paths).toEqual(['src/ok.ts'])
    expect(result.dirs).toEqual(['src/ok'])
    expect(result.total).toBe(1)
  })

  it('caps both lists at maxResults', () => {
    const many = Array.from({ length: 10 }, (_, i) => `src/file-${i}.ts`)
    const result = rankSuggestPaths(many, ['src/one', 'src/two'], 'src', 3)
    expect(result.paths).toHaveLength(3)
    expect(result.dirs).toEqual(['src/one', 'src/two'])
    expect(result.total).toBe(10)
  })
})
