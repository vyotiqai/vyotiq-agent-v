/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useWorkspaceGitSummaries } from '@renderer/features/home/useWorkspaceGitSummaries'
import type { GitChangedFile, GitStatus, GitStatusResult } from '@shared/ipc/schemas/git'
import type { IpcResult } from '@shared/ipc/schemas/agent'

function changedFile(path: string, status: GitChangedFile['status']): GitChangedFile {
  return {
    path,
    status,
    added: 1,
    removed: 1,
    addedStaged: 0,
    removedStaged: 0,
    addedUnstaged: 1,
    removedUnstaged: 1,
    binary: false,
    staged: false,
    unstaged: true
  }
}

function okStatus(overrides: Partial<GitStatus>): GitStatus {
  return {
    branch: 'main',
    files: [changedFile('src/a.ts', 'modified'), changedFile('src/b.ts', 'untracked')],
    truncated: false,
    fileCount: 2,
    added: 2,
    removed: 2,
    hasRemote: true,
    hasCommits: true,
    ...overrides
  }
}

function okIpc(status: GitStatus): IpcResult<GitStatusResult> {
  return { ok: true, data: { kind: 'ok', status } }
}

const gitStatus = vi.fn()

describe('useWorkspaceGitSummaries', () => {
  beforeEach(() => {
    // @ts-expect-error test bridge
    window.vyotiq = { gitStatus }
  })

  afterEach(() => {
    // @ts-expect-error test bridge
    delete window.vyotiq
    gitStatus.mockReset()
  })

  it('makes zero bridge calls and returns an empty record when disabled', () => {
    const { result } = renderHook(() => useWorkspaceGitSummaries(['/w/a', '/w/b'], false))
    expect(result.current).toEqual({})
    expect(gitStatus).not.toHaveBeenCalled()
  })

  it('fetches once per path and maps branch and changed files', async () => {
    gitStatus.mockImplementation((path: string) => {
      if (path === '/w/a') {
        return Promise.resolve(okIpc(okStatus({ branch: 'main' })))
      }
      return Promise.resolve(okIpc(okStatus({ branch: 'feat/x', files: [changedFile('c.ts', 'added')], fileCount: 1 })))
    })

    const { result } = renderHook(() => useWorkspaceGitSummaries(['/w/a', '/w/b'], true))
    await waitFor(() => expect(Object.keys(result.current)).toHaveLength(2))

    expect(gitStatus).toHaveBeenCalledTimes(2)
    expect(gitStatus).toHaveBeenCalledWith('/w/a')
    expect(gitStatus).toHaveBeenCalledWith('/w/b')
    expect(result.current['/w/a']).toEqual({ branch: 'main', changedFiles: 2 })
    expect(result.current['/w/b']).toEqual({ branch: 'feat/x', changedFiles: 1 })
  })

  it('uses fileCount when the file list is truncated', async () => {
    gitStatus.mockResolvedValue(okIpc(okStatus({ truncated: true, fileCount: 42 })))

    const { result } = renderHook(() => useWorkspaceGitSummaries(['/w/capped'], true))
    await waitFor(() => expect(result.current['/w/capped']).toBeDefined())

    expect(result.current['/w/capped']).toEqual({ branch: 'main', changedFiles: 42 })
  })

  it('omits failing paths and keeps the successful ones', async () => {
    gitStatus.mockImplementation((path: string) => {
      if (path === '/w/reject') return Promise.reject(new Error('ipc gone'))
      if (path === '/w/err') return Promise.resolve({ ok: false, error: 'boom' })
      if (path === '/w/notrepo') return Promise.resolve({ ok: true, data: { kind: 'not_repo' } })
      return Promise.resolve(okIpc(okStatus({ branch: 'release' })))
    })

    const { result } = renderHook(() =>
      useWorkspaceGitSummaries(['/w/reject', '/w/err', '/w/notrepo', '/w/ok'], true)
    )
    await waitFor(() => expect(result.current['/w/ok']).toBeDefined())

    expect(Object.keys(result.current)).toEqual(['/w/ok'])
    expect(result.current['/w/ok']).toEqual({ branch: 'release', changedFiles: 2 })
  })

  it('refetches for a new path set and drops removed paths', async () => {
    gitStatus.mockResolvedValue(okIpc(okStatus({ branch: 'main' })))

    const { result, rerender } = renderHook(
      ({ paths }: { paths: string[] }) => useWorkspaceGitSummaries(paths, true),
      { initialProps: { paths: ['/w/a', '/w/b'] } }
    )
    await waitFor(() => expect(Object.keys(result.current)).toHaveLength(2))
    expect(gitStatus).toHaveBeenCalledTimes(2)

    rerender({ paths: ['/w/a', '/w/c'] })
    await waitFor(() => expect(result.current['/w/c']).toBeDefined())

    expect(gitStatus).toHaveBeenCalledTimes(4)
    expect(gitStatus).toHaveBeenCalledWith('/w/c')
    expect(Object.keys(result.current).sort()).toEqual(['/w/a', '/w/c'])
  })

  it('does not refetch when the paths array identity changes but content stays the same', async () => {
    gitStatus.mockResolvedValue(okIpc(okStatus({ branch: 'main' })))

    const { result, rerender } = renderHook(
      ({ paths }: { paths: string[] }) => useWorkspaceGitSummaries(paths, true),
      { initialProps: { paths: ['/w/a'] } }
    )
    await waitFor(() => expect(result.current['/w/a']).toBeDefined())
    expect(gitStatus).toHaveBeenCalledTimes(1)

    rerender({ paths: [...['/w/a']] })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(gitStatus).toHaveBeenCalledTimes(1)
    expect(result.current['/w/a']).toEqual({ branch: 'main', changedFiles: 2 })
  })

  it('refetches when the window regains focus', async () => {
    gitStatus.mockResolvedValue(okIpc(okStatus({ branch: 'main' })))

    const { result } = renderHook(() => useWorkspaceGitSummaries(['/w/a'], true))
    await waitFor(() => expect(result.current['/w/a']).toBeDefined())
    expect(gitStatus).toHaveBeenCalledTimes(1)

    window.dispatchEvent(new Event('focus'))
    await waitFor(() => expect(gitStatus).toHaveBeenCalledTimes(2))
  })

  it('does not refetch on focus while disabled', () => {
    renderHook(() => useWorkspaceGitSummaries(['/w/a'], false))
    window.dispatchEvent(new Event('focus'))
    expect(gitStatus).not.toHaveBeenCalled()
  })
})
