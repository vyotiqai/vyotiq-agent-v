/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { PrPanel } from '@renderer/features/chat/components/PrPanel'

const items = [
  { kind: 'message', id: 'user-0', role: 'user', content: 'Fix the swap', at: 1 },
  { kind: 'message', id: 'a1', role: 'assistant', content: 'The watcher now closes before the swap.', at: 2 }
] as never

function stubBridge(gitBranchDiff: ReturnType<typeof vi.fn> | undefined): void {
  Object.defineProperty(window, 'vyotiq', {
    configurable: true,
    writable: true,
    value: {
      prView: vi.fn().mockResolvedValue({ ok: true, data: null }),
      prCreate: vi.fn(),
      githubAuthStatus: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          ghAvailable: true,
          ghAuthenticated: true,
          hasAppToken: false,
          pending: false,
          userCode: null,
          verificationUri: null,
          error: null
        }
      }),
      onGithubAuthStatus: vi.fn(() => () => {}),
      readRunArtifact: vi.fn().mockResolvedValue({ ok: true, data: { exists: false, content: '' } }),
      shellOpenExternal: vi.fn().mockResolvedValue({ ok: true, data: true }),
      ...(gitBranchDiff ? { gitBranchDiff } : {})
    }
  })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('PrPanel new pull request', () => {
  beforeEach(() => {
    stubBridge(
      vi.fn().mockResolvedValue({
        ok: true,
        data: { content: '', branch: 'fix/swap', base: 'origin/main', commits: 2 }
      })
    )
  })

  it('names the branch and the base it would go into above the form', async () => {
    render(<PrPanel workspacePath="/ws" runId="run-1" items={items} taskTitle="Fix the swap" />)
    await screen.findByRole('textbox', { name: 'Pull request title' })
    const line = await waitFor(() => {
      const el = document.querySelector('[data-new-pr-branches]')
      expect(el).toBeTruthy()
      return el!
    })
    // The remote's prefix is git's, not the base GitHub names.
    expect(line.textContent).toBe('fix/swap → main')
    expect(line.className).toContain('text-muted')
    expect(line.className).toContain('font-mono')
    expect(window.vyotiq.gitBranchDiff).toHaveBeenCalledWith('/ws')
  })

  it('names only the branch when git finds no base to compare with', async () => {
    stubBridge(vi.fn().mockResolvedValue({ ok: true, data: { content: '', branch: 'main', base: null, commits: 0 } }))
    render(<PrPanel workspacePath="/ws" runId="run-1" items={items} taskTitle="Fix the swap" />)
    await waitFor(() => expect(document.querySelector('[data-new-pr-branches]')?.textContent).toBe('main'))
  })

  it('shows no line when the branch cannot be read, and the form still works', async () => {
    stubBridge(vi.fn().mockResolvedValue({ ok: false, error: 'Not a git repository' }))
    render(<PrPanel workspacePath="/ws" runId="run-1" items={items} taskTitle="Fix the swap" />)
    await screen.findByRole('textbox', { name: 'Pull request title' })
    await waitFor(() => expect(window.vyotiq.gitBranchDiff).toHaveBeenCalled())
    expect(document.querySelector('[data-new-pr-branches]')).toBeNull()
  })

  it('does not read the branch while a pull request exists', async () => {
    const gitBranchDiff = vi.fn()
    stubBridge(gitBranchDiff)
    ;(window.vyotiq.prView as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: {
        number: 10,
        title: 'feat: panels',
        url: 'https://github.com/ex/repo/pull/10',
        state: 'OPEN',
        baseRefName: 'main',
        headRefName: 'feat/panels',
        baseRefOid: 'aaa',
        headRefOid: 'bbb',
        body: '',
        additions: 0,
        deletions: 0,
        files: [],
        commits: [],
        checks: [],
        reviews: [],
        latestReviews: [],
        reviewDecision: '',
        reviewRequests: [],
        isDraft: false,
        mergeStateStatus: 'CLEAN'
      }
    })
    render(<PrPanel workspacePath="/ws" runId="run-1" items={items} taskTitle="Fix the swap" />)
    await screen.findByRole('heading', { level: 3, name: 'feat: panels #10' })
    expect(gitBranchDiff).not.toHaveBeenCalled()
  })
})
