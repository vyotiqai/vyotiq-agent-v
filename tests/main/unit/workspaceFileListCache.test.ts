import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { WalkedFile } from '@main/agent/tools/walk'

// A real walk of a real directory, counted.
vi.mock('@main/agent/tools/walk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/tools/walk')>()
  return { ...actual, collectWorkspaceFiles: vi.fn(actual.collectWorkspaceFiles) }
})

vi.mock('@main/git/git', () => ({
  readGitStatus: vi.fn()
}))

import { collectWorkspaceFiles } from '@main/agent/tools/walk'
import { invalidateGitStatusCache } from '@main/git/gitStatusCache'
import {
  FILE_LIST_MAX_WORKSPACES,
  FILE_LIST_REVALIDATE_AFTER_MS,
  invalidateWorkspaceFileListCache,
  readWorkspaceFileListCached
} from '@main/workspace/fileListCache'

const walk = vi.mocked(collectWorkspaceFiles)

/** readdir order is the platform's; the pickers sort after filtering. */
function sorted(files: readonly string[]): string[] {
  return [...files].sort()
}

describe('workspace file list cache', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vyotiq-file-list-'))
    writeFileSync(join(root, 'alpha.ts'), '')
    invalidateWorkspaceFileListCache()
    walk.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    invalidateWorkspaceFileListCache()
    rmSync(root, { recursive: true, force: true })
  })

  it('walks once for two queries, even when the second arrives mid-walk', async () => {
    const [first, second] = await Promise.all([
      readWorkspaceFileListCached(root),
      readWorkspaceFileListCached(root)
    ])
    expect(first).toEqual(['alpha.ts'])
    expect(second).toBe(first)
    expect(await readWorkspaceFileListCached(root)).toBe(first)
    expect(walk).toHaveBeenCalledTimes(1)
  })

  it('shows the next query a file once a change is reported', async () => {
    expect(await readWorkspaceFileListCached(root)).toEqual(['alpha.ts'])
    writeFileSync(join(root, 'beta.ts'), '')
    // Unreported, the walk above still answers — that is the walk saved.
    expect(await readWorkspaceFileListCached(root)).toEqual(['alpha.ts'])

    // What agent writes, terminal commands, rewind, Undo and in-app git report.
    invalidateGitStatusCache(root)

    expect(sorted(await readWorkspaceFileListCached(root))).toEqual(['alpha.ts', 'beta.ts'])
    expect(walk).toHaveBeenCalledTimes(2)
  })

  it('does not keep a walk that was already running when the change was reported', async () => {
    let finishStaleWalk!: (files: WalkedFile[]) => void
    walk.mockImplementationOnce(
      () =>
        new Promise<WalkedFile[]>((resolve) => {
          finishStaleWalk = resolve
        })
    )
    const stale = readWorkspaceFileListCached(root)
    writeFileSync(join(root, 'beta.ts'), '')
    invalidateGitStatusCache(root)
    const next = readWorkspaceFileListCached(root)
    // The report starts a walk of its own rather than joining the one running.
    expect(walk).toHaveBeenCalledTimes(2)
    const fresh = await next

    finishStaleWalk([{ full: join(root, 'alpha.ts'), rel: 'alpha.ts' }])
    // Whoever asked before the change still gets their answer…
    expect(await stale).toEqual(['alpha.ts'])
    // …but it never replaces the list walked after it.
    expect(sorted(fresh)).toEqual(['alpha.ts', 'beta.ts'])
    expect(await readWorkspaceFileListCached(root)).toBe(fresh)
    expect(walk).toHaveBeenCalledTimes(2)
  })

  it('serves a list past its age once, and walks again behind it', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const first = await readWorkspaceFileListCached(root)
    // Another editor, or the integrated terminal: nothing reports this.
    writeFileSync(join(root, 'beta.ts'), '')

    now.mockReturnValue(1_000_000 + FILE_LIST_REVALIDATE_AFTER_MS - 1)
    expect(await readWorkspaceFileListCached(root)).toBe(first)
    expect(walk).toHaveBeenCalledTimes(1)

    now.mockReturnValue(1_000_000 + FILE_LIST_REVALIDATE_AFTER_MS)
    expect(await readWorkspaceFileListCached(root)).toBe(first)
    expect(walk).toHaveBeenCalledTimes(2)

    await vi.waitFor(async () => {
      expect(sorted(await readWorkspaceFileListCached(root))).toEqual(['alpha.ts', 'beta.ts'])
    })
    expect(walk).toHaveBeenCalledTimes(2)
  })

  it('does not keep a failed walk', async () => {
    const later = join(root, 'later')
    await expect(readWorkspaceFileListCached(later)).rejects.toThrow()
    mkdirSync(later)
    writeFileSync(join(later, 'gamma.ts'), '')
    expect(await readWorkspaceFileListCached(later)).toEqual(['gamma.ts'])
  })

  it(`holds ${FILE_LIST_MAX_WORKSPACES} lists, dropping the one searched longest ago`, async () => {
    const others = Array.from({ length: FILE_LIST_MAX_WORKSPACES }, () =>
      mkdtempSync(join(tmpdir(), 'vyotiq-file-list-'))
    )
    try {
      await readWorkspaceFileListCached(root)
      for (const dir of others.slice(0, -1)) await readWorkspaceFileListCached(dir)
      await readWorkspaceFileListCached(root)
      await readWorkspaceFileListCached(others[others.length - 1]!)
      const walks = walk.mock.calls.length

      await readWorkspaceFileListCached(root)
      expect(walk).toHaveBeenCalledTimes(walks)
      await readWorkspaceFileListCached(others[0]!)
      expect(walk).toHaveBeenCalledTimes(walks + 1)
    } finally {
      for (const dir of others) rmSync(dir, { recursive: true, force: true })
    }
  })
})
