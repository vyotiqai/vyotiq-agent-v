/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useWorkspaceGitSummaries } from '@renderer/features/home/useWorkspaceGitSummaries'

const gitStatus = vi.fn()

function status(path = 'src/a.ts') {
  return {
    ok: true as const,
    data: {
      kind: 'ok' as const,
      status: {
        branch: 'main',
        files: [{
          path,
          status: 'modified' as const,
          added: 3,
          removed: 1,
          addedStaged: 0,
          removedStaged: 0,
          addedUnstaged: 3,
          removedUnstaged: 1,
          binary: false,
          staged: false,
          unstaged: true
        }],
        truncated: false,
        fileCount: 1,
        added: 3,
        removed: 1,
        hasRemote: true,
        hasCommits: true,
        ahead: 2,
        behind: 1
      }
    }
  }
}

describe('useWorkspaceGitSummaries', () => {
  beforeEach(() => {
    gitStatus.mockResolvedValue(status())
    // @ts-expect-error test bridge
    window.vyotiq = { gitStatus }
  })

  afterEach(() => {
    delete (window as { vyotiq?: unknown }).vyotiq
    gitStatus.mockReset()
  })

  it('returns honest loading, data, freshness, and git details', async () => {
    const { result } = renderHook(() => useWorkspaceGitSummaries(['/repo'], true))
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.data['/repo']).toEqual({
      branch: 'main',
      changedFiles: 1,
      ahead: 2,
      behind: 1,
      topFiles: [{ path: 'src/a.ts', lines: 4 }]
    })
    expect(result.current.errors).toEqual({})
    expect(result.current.updatedAt).toBeTruthy()
  })

  it('keeps failures separate from data and supports manual retry', async () => {
    gitStatus.mockResolvedValueOnce({ ok: false, error: 'git unavailable' })
    const { result } = renderHook(() => useWorkspaceGitSummaries(['/repo'], true))
    await waitFor(() => expect(result.current.errors['/repo']).toBe('git unavailable'))

    gitStatus.mockResolvedValue(status('src/recovered.ts'))
    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.data['/repo']?.topFiles?.[0]?.path).toBe('src/recovered.ts'))
    expect(result.current.errors).toEqual({})
  })

  it('refetches on focus and refreshVersion changes', async () => {
    const { result, rerender } = renderHook(
      ({ version }) => useWorkspaceGitSummaries(['/repo'], true, version),
      { initialProps: { version: 0 } }
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(gitStatus).toHaveBeenCalledTimes(1)

    window.dispatchEvent(new Event('focus'))
    await waitFor(() => expect(gitStatus).toHaveBeenCalledTimes(2))
    rerender({ version: 1 })
    await waitFor(() => expect(gitStatus).toHaveBeenCalledTimes(3))
  })

  it('makes no bridge calls while disabled', () => {
    const { result } = renderHook(() => useWorkspaceGitSummaries(['/repo'], false))
    expect(result.current.data).toEqual({})
    expect(result.current.loading).toBe(false)
    expect(gitStatus).not.toHaveBeenCalled()
  })
})
