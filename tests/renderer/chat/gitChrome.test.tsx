/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useGitChrome } from '@renderer/features/chat/components/GitChrome'
import type { GitStatus } from '@shared/ipc'

const dirty: GitStatus = {
  branch: 'main',
  files: [],
  truncated: false,
  fileCount: 2,
  added: 17,
  removed: 4,
  hasRemote: true,
  hasCommits: true
}

function MutationHarness({
  beforeMutation
}: {
  beforeMutation: () => Promise<boolean>
}) {
  const chrome = useGitChrome('/ws', 1, true, undefined, beforeMutation)
  return (
    <>
      <button type="button" onClick={() => void chrome.commit('Commit files', false)}>
        Commit files
      </button>
      {chrome.notice ? <span>{chrome.notice}</span> : null}
    </>
  )
}

function mockApi(overrides: Record<string, unknown> = {}): Record<string, ReturnType<typeof vi.fn>> {
  const api = {
    gitStatus: vi.fn().mockResolvedValue({ ok: true, data: { kind: 'ok', status: dirty } }),
    gitCommit: vi.fn().mockResolvedValue({
      ok: true,
      data: { committed: true, pushed: false, detail: 'Committed' }
    }),
    gitStageAll: vi.fn().mockResolvedValue({
      ok: true,
      data: { staged: true, detail: 'Staged all changes' }
    }),
    ...overrides
  } as Record<string, ReturnType<typeof vi.fn>>
  Object.defineProperty(window, 'vyotiq', { configurable: true, writable: true, value: api })
  return api
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

beforeEach(() => {
  mockApi()
})

describe('git chrome', () => {
  it('flushes pending Files edits before a Git mutation', async () => {
    const api = mockApi()
    const beforeMutation = vi.fn().mockResolvedValue(true)
    render(<MutationHarness beforeMutation={beforeMutation} />)
    fireEvent.click(screen.getByRole('button', { name: 'Commit files' }))
    await waitFor(() => expect(api.gitCommit).toHaveBeenCalled())
    expect(beforeMutation).toHaveBeenCalledTimes(1)
    expect(beforeMutation.mock.invocationCallOrder[0]).toBeLessThan(
      api.gitCommit.mock.invocationCallOrder[0]!
    )
  })

  it('blocks a Git mutation when Files flushing reports a conflict', async () => {
    const api = mockApi()
    const beforeMutation = vi.fn().mockResolvedValue(false)
    render(<MutationHarness beforeMutation={beforeMutation} />)
    fireEvent.click(screen.getByRole('button', { name: 'Commit files' }))
    await waitFor(() =>
      expect(screen.getByText(/File autosave could not complete/i)).toBeTruthy()
    )
    expect(api.gitCommit).not.toHaveBeenCalled()
  })
})
