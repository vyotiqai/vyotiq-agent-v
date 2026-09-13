import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitStatusResult } from '@shared/ipc'

function okMainStatus(): GitStatusResult {
  return {
    kind: 'ok',
    status: {
      branch: 'main',
      files: [],
      truncated: false,
      fileCount: 0,
      added: 0,
      removed: 0,
      hasRemote: false,
      hasCommits: true
    }
  }
}

const readGitStatus = vi.hoisted(() => vi.fn())

function resetReadGitStatusMock(): void {
  readGitStatus.mockReset()
  readGitStatus.mockResolvedValue(okMainStatus())
}

vi.mock('@main/git/git', () => ({
  readGitStatus,
  readGitDiff: vi.fn()
}))

import {
  invalidateGitStatusCache,
  readGitStatusCached,
  resetGitStatusCacheForTests
} from '@main/git/gitStatusCache'
import { toolGitStatusAsync } from '@main/agent/tools/gitHelpers'

describe('gitStatusCache', () => {
  beforeEach(() => {
    resetGitStatusCacheForTests()
    resetReadGitStatusMock()
  })

  afterEach(() => {
    resetGitStatusCacheForTests()
  })

  it('coalesces overlapping reads into one shell-out', async () => {
    const [a, b] = await Promise.all([
      readGitStatusCached('C:/repo'),
      readGitStatusCached('C:/repo')
    ])
    expect(a.kind === 'ok' && a.status.branch).toBe('main')
    expect(b.kind === 'ok' && b.status.branch).toBe('main')
    expect(readGitStatus).toHaveBeenCalledTimes(1)
  })

  it('serves a short TTL hit without another shell-out', async () => {
    await readGitStatusCached('C:/repo')
    await readGitStatusCached('C:/repo')
    expect(readGitStatus).toHaveBeenCalledTimes(1)
  })

  it('invalidates so the next read shells out again', async () => {
    await readGitStatusCached('C:/repo')
    invalidateGitStatusCache('C:/repo')
    await readGitStatusCached('C:/repo')
    expect(readGitStatus).toHaveBeenCalledTimes(2)
  })

  it('does not re-cache a pre-invalidate inflight result', async () => {
    let resolveFirst!: (value: GitStatusResult) => void
    readGitStatus.mockImplementationOnce(
      () =>
        new Promise<GitStatusResult>((resolve) => {
          resolveFirst = resolve
        })
    )
    readGitStatus.mockResolvedValue({
      kind: 'ok',
      status: {
        branch: 'fresh',
        files: [],
        truncated: false,
        fileCount: 0,
        added: 0,
        removed: 0,
        hasRemote: false,
        hasCommits: true
      }
    })

    const first = readGitStatusCached('C:/repo')
    invalidateGitStatusCache('C:/repo')
    const second = readGitStatusCached('C:/repo')
    resolveFirst({
      kind: 'ok',
      status: {
        branch: 'stale',
        files: [],
        truncated: false,
        fileCount: 0,
        added: 0,
        removed: 0,
        hasRemote: false,
        hasCommits: true
      }
    })
    await first
    const fresh = await second
    expect(fresh.kind === 'ok' && fresh.status.branch).toBe('fresh')
    await expect(readGitStatusCached('C:/repo')).resolves.toMatchObject({
      kind: 'ok',
      status: { branch: 'fresh' }
    })
    expect(readGitStatus).toHaveBeenCalledTimes(2)
  })
})

describe('toolGitStatusAsync cache coalesce', () => {
  beforeEach(() => {
    resetGitStatusCacheForTests()
    resetReadGitStatusMock()
  })

  afterEach(() => {
    resetGitStatusCacheForTests()
  })

  it('coalesces overlapping agent git_status and refetches after invalidate', async () => {
    const [a, b] = await Promise.all([
      toolGitStatusAsync('C:/repo'),
      toolGitStatusAsync('C:/repo')
    ])
    expect(a).toContain('branch: main')
    expect(b).toContain('branch: main')
    expect(readGitStatus).toHaveBeenCalledTimes(1)

    invalidateGitStatusCache('C:/repo')
    await toolGitStatusAsync('C:/repo')
    expect(readGitStatus).toHaveBeenCalledTimes(2)
  })
})
