/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  checkState,
  checksPassedCount,
  mergeSummary,
  prMergeBlockedReason,
  PrPanel
} from '@renderer/features/chat/components/PrPanel'
import type { PrView } from '@shared/ipc'

beforeEach(() => {
  Object.defineProperty(window, 'vyotiq', {
    configurable: true,
    writable: true,
    value: {
      gitStatus: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          kind: 'ok',
          status: {
          branch: 'main',
          files: [
            {
              path: 'src/a.ts',
              status: 'modified',
              added: 3,
              removed: 1,
              addedStaged: 2,
              removedStaged: 0,
              addedUnstaged: 1,
              removedUnstaged: 1,
              binary: false,
              staged: true,
              unstaged: true
            },
            {
              path: 'gone.ts',
              status: 'deleted',
              added: 0,
              removed: 4,
              addedStaged: 0,
              removedStaged: 4,
              addedUnstaged: 0,
              removedUnstaged: 0,
              binary: false,
              staged: true,
              unstaged: false
            },
            {
              path: 'new.ts',
              status: 'untracked',
              added: 2,
              removed: 0,
              addedStaged: 0,
              removedStaged: 0,
              addedUnstaged: 2,
              removedUnstaged: 0,
              binary: false,
              staged: false,
              unstaged: true
            }
          ],
          truncated: false,
          fileCount: 3,
          added: 5,
          removed: 5,
          hasRemote: true,
          hasCommits: true
          }
        }
      }),
      gitGenerateCommitMessage: vi.fn().mockResolvedValue({
        ok: true,
        data: { message: 'feat: improve generated commit messages', source: 'agent' }
      }),
      gitCommit: vi.fn().mockResolvedValue({
        ok: true,
        data: { committed: true, pushed: true, detail: 'pushed' }
      }),
      gitStageAll: vi.fn().mockResolvedValue({
        ok: true,
        data: { staged: true, detail: 'Staged all changes' }
      }),
      gitStagePaths: vi.fn().mockResolvedValue({
        ok: true,
        data: { staged: true, detail: 'Staged path' }
      }),
      gitUnstagePaths: vi.fn().mockResolvedValue({
        ok: true,
        data: { unstaged: true, detail: 'Unstaged path' }
      }),
      gitBranches: vi.fn().mockResolvedValue({
        ok: true,
        data: [{ name: 'main', current: true }]
      }),
      gitCheckout: vi.fn().mockResolvedValue({ ok: true, data: { detail: 'Checked out main' } }),
      gitLog: vi.fn().mockResolvedValue({
        ok: true,
        data: [
          {
            sha: 'abc1234567890',
            shortSha: 'abc1234',
            subject: 'first',
            author: 'dev',
            relativeDate: '1 day ago'
          }
        ]
      }),
      gitCommitFiles: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          files: [
            {
              path: 'src/a.ts',
              status: 'modified',
              added: 1,
              removed: 0,
              addedStaged: 0,
              removedStaged: 0,
              addedUnstaged: 1,
              removedUnstaged: 0,
              binary: false,
              staged: false,
              unstaged: false
            }
          ]
        }
      }),
      gitDiff: vi.fn().mockResolvedValue({
        ok: true,
        data: { content: '@@ -1 +1 @@\n-old\n+new\n' }
      }),
      prView: vi.fn().mockResolvedValue({
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
          body: 'Hello',
          additions: 10,
          deletions: 2,
          files: [{ path: 'a.ts', additions: 10, deletions: 2, changeType: 'MODIFIED' }],
          commits: [{ oid: 'abc1234', messageHeadline: 'feat', authors: ['dev'] }],
          checks: [{ name: 'ci', state: 'SUCCESS', conclusion: 'SUCCESS' }],
          reviews: [],
          latestReviews: [],
          reviewDecision: '',
          reviewRequests: [],
          isDraft: false,
          mergeStateStatus: 'CLEAN'
        }
      }),
      prCreate: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          url: 'https://github.com/ex/repo/pull/11',
          branch: 'vyotiq/changes-abc',
          baseBranch: 'main',
          draft: true,
          detail: 'Draft pull request created'
        }
      }),
      prMerge: vi.fn().mockResolvedValue({ ok: true, data: { detail: 'merged' } }),
      prDiff: vi.fn().mockResolvedValue({
        ok: true,
        data: { content: '@@ -1 +1 @@\n-old\n+new\n' }
      }),
      prClose: vi.fn().mockResolvedValue({ ok: true, data: { detail: 'closed' } }),
      prEditTitle: vi.fn().mockResolvedValue({ ok: true, data: { title: 'feat: panels' } }),
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
      githubAuthStart: vi.fn(),
      githubAuthCancel: vi.fn(),
      githubAuthLogout: vi.fn(),
      onGithubAuthStatus: vi.fn(() => () => {}),
      githubCliInstall: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          installed: true,
          detail: 'GitHub CLI installed with winget.',
          ghAvailable: true
        }
      }),
      shellOpenExternal: vi.fn().mockResolvedValue({ ok: true, data: true })
    }
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
describe('PrPanel', () => {
  it('renders PR metadata from gh view', async () => {
    const onPrMeta = vi.fn()
    render(<PrPanel workspacePath="/ws" onPrMeta={onPrMeta} />)
    expect(await screen.findByRole('heading', { level: 3, name: 'feat: panels #10' })).toBeTruthy()
    expect(document.querySelector('[data-pr-header]')?.textContent).toContain('feat/panels → main')
    // Checks first, like the redesign.
    expect(screen.getByRole('tab', { name: /^Checks/ }).getAttribute('aria-selected')).toBe('true')
    expect(onPrMeta).toHaveBeenCalledWith({ number: 10, title: 'feat: panels' })
  })

  it('creates a draft PR from an already-pushed topic branch', async () => {
    ;(window.vyotiq.prView as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: null })
    render(<PrPanel workspacePath="/ws" />)
    fireEvent.click(await screen.findByRole('button', { name: /Create a draft PR/i }))
    await waitFor(() => {
      expect(window.vyotiq.prCreate).toHaveBeenCalledWith('/ws', { draft: true })
    })
  })

  it('writes a new PR from the task’s result and checks, editable, instead of --fill', async () => {
    ;(window.vyotiq.prView as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: null })
    const readRunArtifact = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        exists: true,
        content: JSON.stringify({
          checks: [
            { id: 'c1', text: 'Tests pass', source: 'brief', verdict: 'met', evidence: 'pnpm test: 4 passed', createdAt: '2026-09-30T10:00:00.000Z' }
          ]
        })
      }
    })
    ;(window.vyotiq as unknown as Record<string, unknown>).readRunArtifact = readRunArtifact
    const items = [
      { kind: 'message', id: 'user-0', role: 'user', content: 'Fix the swap', at: 1 },
      { kind: 'message', id: 'a1', role: 'assistant', content: 'The watcher now closes before the swap.', at: 2 }
    ] as never
    render(<PrPanel workspacePath="/ws" runId="run-1" items={items} taskTitle="Fix the swap" />)
    const body = (await screen.findByRole('textbox', { name: 'Pull request description' })) as HTMLTextAreaElement
    await waitFor(() => expect(body.value).toContain('- [x] Tests pass'))
    expect(body.value.startsWith('The watcher now closes before the swap.')).toBe(true)
    const title = screen.getByRole('textbox', { name: 'Pull request title' }) as HTMLInputElement
    expect(title.value).toBe('Fix the swap')
    fireEvent.change(title, { target: { value: 'Close the watcher first' } })
    fireEvent.click(screen.getByRole('button', { name: /Create a draft PR/i }))
    await waitFor(() => {
      expect(window.vyotiq.prCreate).toHaveBeenCalledWith('/ws', {
        draft: true,
        title: 'Close the watcher first',
        body: expect.stringContaining('Evidence: pnpm test: 4 passed')
      })
    })
  })

  it('does not re-fetch when only onPrMeta identity changes', async () => {
    const { rerender } = render(
      <PrPanel workspacePath="/ws" onPrMeta={() => undefined} />
    )
    await screen.findByText(/feat: panels/)
    const calls = (window.vyotiq.prView as ReturnType<typeof vi.fn>).mock.calls.length
    rerender(<PrPanel workspacePath="/ws" onPrMeta={() => undefined} />)
    await waitFor(() => {
      expect((window.vyotiq.prView as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls)
    })
  })

  it('reloads when gitRevision bumps', async () => {
    const { rerender } = render(<PrPanel workspacePath="/ws" gitRevision={0} />)
    await screen.findByText(/feat: panels/)
    const calls = (window.vyotiq.prView as ReturnType<typeof vi.fn>).mock.calls.length
    rerender(<PrPanel workspacePath="/ws" gitRevision={1} />)
    await waitFor(() => {
      expect((window.vyotiq.prView as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
        calls
      )
    })
  })

  it('titles empty state for missing GitHub CLI', async () => {
    ;(window.vyotiq.prView as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: 'GitHub CLI (gh) is not installed or not on PATH'
    })
    render(<PrPanel workspacePath="/ws" />)
    expect(await screen.findByText('GitHub CLI not found')).toBeTruthy()
  })

  it('asks for a new sign-in, not a draft PR, when gh is signed in but GitHub rejects it', async () => {
    ;(window.vyotiq.prView as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: 'HTTP 401: Bad credentials (https://api.github.com/graphql)'
    })
    ;(window.vyotiq.githubAuthStart as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: {
        ghAvailable: true,
        ghAuthenticated: false,
        hasAppToken: false,
        pending: true,
        userCode: 'ABCD-1234',
        verificationUri: 'https://github.com/login/device',
        error: null
      }
    })
    render(<PrPanel workspacePath="/ws" />)
    expect(await screen.findByText('GitHub sign-in expired')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Create a draft PR/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))
    await waitFor(() => {
      expect(window.vyotiq.githubAuthStart).toHaveBeenCalledWith({ fresh: true })
    })
  })

  it('offers automatic GitHub repository setup when no remote exists', async () => {
    ;(window.vyotiq.prView as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: 'Command failed: gh pr view\nno git remotes found'
    })
    render(<PrPanel workspacePath="/ws" />)
    expect(await screen.findByText('GitHub repository not configured')).toBeTruthy()
    expect(
      screen.getByText(/connect the matching GitHub repository or create a private one/i)
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: /Create a draft PR/i })).toBeTruthy()
  })

  it('titles empty state when the repository has no initial commit', async () => {
    ;(window.vyotiq.prView as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error:
        'The repository has no initial commit yet. Commit changes first, then create a pull request.'
    })
    render(<PrPanel workspacePath="/ws" />)
    expect(await screen.findByText('No commits yet')).toBeTruthy()
    expect(screen.getByText(/empty git history cannot be published/i)).toBeTruthy()
  })

  it('shows the create-PR error when the repository has no commits', async () => {
    ;(window.vyotiq.prView as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: null })
    ;(window.vyotiq.prCreate as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error:
        'The repository has no initial commit yet. Commit changes first, then create a pull request.'
    })
    render(<PrPanel workspacePath="/ws" />)
    fireEvent.click(await screen.findByRole('button', { name: /Create a draft PR/i }))
    expect(await screen.findByText(/no initial commit/i)).toBeTruthy()
  })

  it('offers one-click GitHub CLI install when gh is missing', async () => {
    ;(window.vyotiq.prView as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: 'GitHub CLI (gh) is not installed or not on PATH'
    })
    ;(window.vyotiq.githubAuthStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: {
        ghAvailable: false,
        ghAuthenticated: false,
        hasAppToken: false,
        pending: false,
        userCode: null,
        verificationUri: null,
        error: null
      }
    })
    render(<PrPanel workspacePath="/ws" />)
    const installBtn = await screen.findByRole('button', { name: /Install GitHub CLI/i })
    fireEvent.click(installBtn)
    await waitFor(() => {
      expect(window.vyotiq.githubCliInstall).toHaveBeenCalled()
    })
    expect(await screen.findByText(/GitHub CLI installed with winget/i)).toBeTruthy()
  })

  it('skips prView when GitHub CLI is installed but not signed in', async () => {
    ;(window.vyotiq.prView as ReturnType<typeof vi.fn>).mockClear()
    ;(window.vyotiq.githubAuthStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: {
        ghAvailable: true,
        ghAuthenticated: false,
        hasAppToken: false,
        pending: false,
        userCode: null,
        verificationUri: null,
        error: null
      }
    })
    render(<PrPanel workspacePath="/ws" />)
    expect(await screen.findByRole('button', { name: /Connect GitHub/i })).toBeTruthy()
    await waitFor(() => {
      expect(window.vyotiq.prView).not.toHaveBeenCalled()
    })
  })

  it('shows in-panel GitHub auth pipeline when sign-in is pending', async () => {
    ;(window.vyotiq.prView as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: 'To get started with GitHub CLI, please run: gh auth login'
    })
    ;(window.vyotiq.githubAuthStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: {
        ghAvailable: true,
        ghAuthenticated: false,
        hasAppToken: false,
        pending: true,
        userCode: 'WXYZ-9876',
        verificationUri: 'https://github.com/login/device',
        error: null
      }
    })
    render(<PrPanel workspacePath="/ws" />)
    expect(await screen.findByText('WXYZ-9876')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Open GitHub/i })).toBeTruthy()
    expect(screen.getByText(/Waiting for authorisation/i)).toBeTruthy()
    expect(screen.queryByText(/^Complete authorization in your browser\.$/)).toBeNull()
  })

  it('starts GitHub auth from the panel and shows the pending pipeline', async () => {
    ;(window.vyotiq.prView as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: 'auth required'
    })
    ;(window.vyotiq.githubAuthStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: {
        ghAvailable: true,
        ghAuthenticated: false,
        hasAppToken: false,
        pending: false,
        userCode: null,
        verificationUri: null,
        error: null
      }
    })
    ;(window.vyotiq.githubAuthStart as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: {
        ghAvailable: true,
        ghAuthenticated: false,
        hasAppToken: false,
        pending: true,
        userCode: 'ABCD-1234',
        verificationUri: 'https://github.com/login/device',
        error: null
      }
    })
    render(<PrPanel workspacePath="/ws" />)
    fireEvent.click(await screen.findByRole('button', { name: /Connect GitHub/i }))
    expect(await screen.findByText(/Waiting for authorisation/i)).toBeTruthy()
    await waitFor(() => {
      expect(window.vyotiq.githubAuthStart).toHaveBeenCalled()
    })
    expect(await screen.findByText('ABCD-1234')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Open GitHub/i })).toBeTruthy()
    expect(screen.queryByText(/^Complete authorization in your browser\.$/)).toBeNull()
  })

  it('loads the pull request when GitHub sign-in succeeds', async () => {
    let push: ((status: {
      ghAvailable: boolean
      ghAuthenticated: boolean
      hasAppToken: boolean
      pending: boolean
      userCode: string | null
      verificationUri: string | null
      error: string | null
    }) => void) | undefined
    ;(window.vyotiq.onGithubAuthStatus as ReturnType<typeof vi.fn>).mockImplementation(
      (handler) => {
        push = handler
        return () => {}
      }
    )
    const pendingStatus = {
      ghAvailable: true,
      ghAuthenticated: false,
      hasAppToken: false,
      pending: true,
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      error: null
    }
    ;(window.vyotiq.githubAuthStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: pendingStatus
    })
    ;(window.vyotiq.prView as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: 'To get started with GitHub CLI, please run:  gh auth login'
    })
    render(<PrPanel workspacePath="/ws" />)
    expect(await screen.findByText('ABCD-1234')).toBeTruthy()

    const signedIn = {
      ghAvailable: true,
      ghAuthenticated: true,
      hasAppToken: true,
      pending: false,
      userCode: null,
      verificationUri: null,
      error: null
    }
    ;(window.vyotiq.githubAuthStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: signedIn
    })
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
        body: 'Hello',
        additions: 10,
        deletions: 2,
        files: [{ path: 'a.ts', additions: 10, deletions: 2, changeType: 'MODIFIED' }],
        commits: [{ oid: 'abc1234', messageHeadline: 'feat', authors: ['dev'] }],
        checks: [{ name: 'ci', state: 'SUCCESS', conclusion: 'SUCCESS' }],
        reviews: [],
        latestReviews: [],
        reviewDecision: '',
        reviewRequests: [],
        isDraft: false
      }
    })
    push?.(signedIn)

    expect(await screen.findByText(/feat: panels/)).toBeTruthy()
    expect(window.vyotiq.prView).toHaveBeenCalled()
  })

  it('merges with the method chosen, after confirmation', async () => {
    const nativeConfirm = vi.spyOn(window, 'confirm')
    render(<PrPanel workspacePath="/ws" />)
    await screen.findByText(/feat: panels/)
    expect(screen.getByText('Open')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Squash and merge/ }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Squash and merge' }))
    // The app's own dialog, not the browser's.
    const dialog = await screen.findByRole('dialog', { name: 'Squash and merge' })
    expect(nativeConfirm).not.toHaveBeenCalled()
    expect(window.vyotiq.prMerge).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Squash and merge' }))
    await waitFor(() => {
      expect(window.vyotiq.prMerge).toHaveBeenCalledWith('/ws', 'squash', 10)
    })
  })

  it('skips prMerge when confirmation is cancelled', async () => {
    render(<PrPanel workspacePath="/ws" />)
    await screen.findByText(/feat: panels/)
    fireEvent.click(screen.getByRole('button', { name: /Squash and merge/ }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rebase and merge' }))
    const dialog = await screen.findByRole('dialog', { name: 'Rebase and merge' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    expect(window.vyotiq.prMerge).not.toHaveBeenCalled()
  })

  it('closes the pull request only after confirming', async () => {
    render(<PrPanel workspacePath="/ws" />)
    await screen.findByText(/feat: panels/)
    fireEvent.click(screen.getByRole('button', { name: 'PR actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close pull request' }))
    const dialog = await screen.findByRole('dialog', { name: 'Close pull request' })
    expect(window.vyotiq.prClose).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close pull request' }))
    await waitFor(() => {
      expect(window.vyotiq.prClose).toHaveBeenCalledWith('/ws', 10)
    })
  })

  it('starts with a 40px row and shows Issues as the current view', async () => {
    window.vyotiq.githubIssuesList = vi.fn().mockResolvedValue({ ok: true, data: { issues: [] } })
    render(<PrPanel workspacePath="/ws" />)
    await screen.findByText(/feat: panels/)
    const firstRow = document.querySelector('[data-pr-header]')?.firstElementChild as HTMLElement
    expect(firstRow.classList.contains('h-10')).toBe(true)
    expect(firstRow.textContent).toContain('feat/panels → main')
    fireEvent.click(screen.getByRole('button', { name: 'PR actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Issues' }))
    expect(screen.getByRole('tab', { name: 'Issues' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: /^Checks/ }).getAttribute('aria-selected')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Back to checks' }))
    expect(screen.getByRole('tab', { name: /^Checks/ }).getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByRole('tab', { name: 'Issues' })).toBeNull()
  })

  it('lists files with the selected one’s diff below, and marks files viewed', async () => {
    render(<PrPanel workspacePath="/ws" />)
    await screen.findByText(/feat: panels/)
    expect(screen.getByRole('tab', { name: /^Reviews/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: /^Files/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'a.ts, modified' }))
    await waitFor(() => {
      expect(window.vyotiq.prDiff).toHaveBeenCalledWith({
        workspacePath: '/ws',
        path: 'a.ts',
        ignoreWhitespace: false,
        number: 10
      })
    })
    const row = document.querySelector('[data-change-row="a.ts"]') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Mark a.ts as viewed' }))
    expect(row.textContent).toContain('Viewed')
    expect(within(row).getByRole('button', { name: 'Mark a.ts as not viewed' })).toBeTruthy()
  })

  it('keeps filter, title, issues, close and hide in the PR menu', async () => {
    const onUnlink = vi.fn()
    render(<PrPanel workspacePath="/ws" onUnlink={onUnlink} />)
    await screen.findByText(/feat: panels/)
    expect(screen.getByRole('button', { name: 'Open on GitHub' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'PR actions' }))
    expect(await screen.findByRole('menuitem', { name: 'Filter files' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Edit title' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Issues' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Close pull request' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide panel' }))
    expect(onUnlink).toHaveBeenCalled()
  })

  it('shows each check’s state, time and run link, and hands a failure to the agent', async () => {
    const onHandToAgent = vi.fn()
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
        additions: 1,
        deletions: 0,
        files: [],
        commits: [],
        checks: [
          {
            name: 'typecheck',
            state: 'COMPLETED',
            conclusion: 'SUCCESS',
            url: 'https://github.com/ex/repo/actions/runs/1',
            startedAt: '2026-01-01T00:00:00Z',
            completedAt: '2026-01-01T00:00:38Z'
          },
          {
            name: 'e2e (windows)',
            state: 'COMPLETED',
            conclusion: 'FAILURE',
            url: 'https://github.com/ex/repo/actions/runs/2',
            startedAt: '2026-01-01T00:00:00Z',
            completedAt: '2026-01-01T00:04:12Z',
            description: '1 test failed'
          },
          { name: 'lint', state: 'IN_PROGRESS', conclusion: null }
        ],
        reviews: [],
        latestReviews: [],
        reviewDecision: '',
        reviewRequests: [],
        isDraft: false,
        mergeStateStatus: 'BLOCKED'
      }
    })
    render(<PrPanel workspacePath="/ws" onHandToAgent={onHandToAgent} />)
    await screen.findByText(/feat: panels/)
    expect(screen.getByRole('tab', { name: /^Checks/ }).textContent).toContain('1/3')
    const checks = screen.getByRole('list', { name: 'Checks' })
    const rows = Array.from(checks.querySelectorAll('li'))
    expect(rows.map((r) => r.getAttribute('data-check-state'))).toEqual(['review', 'failed', 'running'])
    expect(rows[0]!.textContent).toContain('38s')
    expect(rows[1]!.textContent).toContain('1 test failed')
    fireEvent.click(within(rows[1]!).getByRole('button', { name: 'Open the e2e (windows) run' }))
    expect(window.vyotiq.shellOpenExternal).toHaveBeenCalledWith('https://github.com/ex/repo/actions/runs/2')
    fireEvent.click(within(rows[1]!).getByRole('button', { name: /Hand to the agent/ }))
    expect(onHandToAgent).toHaveBeenCalledWith(
      'The “e2e (windows)” check failed on pull request #10 (1 test failed). Read its log at https://github.com/ex/repo/actions/runs/2, find the cause and fix it.'
    )
    // The merge section says what GitHub reports, no more.
    expect(screen.getByText('1 check failing and 1 still running. Branch protection blocks the merge.')).toBeTruthy()
  })

  it('marks a draft ready for review', async () => {
    window.vyotiq.prReady = vi.fn().mockResolvedValue({ ok: true, data: { detail: 'Marked ready for review' } })
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
        additions: 1,
        deletions: 0,
        files: [],
        commits: [],
        checks: [],
        reviews: [],
        latestReviews: [],
        reviewDecision: '',
        reviewRequests: [],
        isDraft: true,
        mergeStateStatus: 'DRAFT'
      }
    })
    render(<PrPanel workspacePath="/ws" />)
    await screen.findByText(/feat: panels/)
    expect(screen.getByText('Draft')).toBeTruthy()
    expect((screen.getByRole('button', { name: /Squash and merge/ }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Mark ready for review' }))
    await waitFor(() => {
      expect(window.vyotiq.prReady).toHaveBeenCalledWith('/ws', 10)
    })
  })

  it('hides merge controls for a closed PR', async () => {
    window.vyotiq.prView = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        number: 10,
        title: 'feat: panels',
        url: 'https://github.com/ex/repo/pull/10',
        state: 'CLOSED',
        baseRefName: 'main',
        headRefName: 'feat/panels',
        baseRefOid: 'aaa',
        headRefOid: 'bbb',
        body: 'Hello',
        additions: 10,
        deletions: 2,
        files: [{ path: 'a.ts', additions: 10, deletions: 2, changeType: 'MODIFIED' }],
        commits: [],
        checks: [],
        reviews: [],
        latestReviews: [],
        reviewDecision: '',
        reviewRequests: [],
        isDraft: false
      }
    })
    render(<PrPanel workspacePath="/ws" />)
    await screen.findByText(/feat: panels/)
    expect(screen.getByText('Closed')).toBeTruthy()
    expect(screen.getByText('Closed without merging.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Squash and merge/ })).toBeNull()
  })

  it('does not treat bare COMPLETED check state as passed', () => {
    expect(
      checksPassedCount({
        number: 1,
        title: 't',
        url: 'u',
        state: 'OPEN',
        baseRefName: 'main',
        headRefName: 'f',
        baseRefOid: 'a',
        headRefOid: 'b',
        body: '',
        additions: 0,
        deletions: 0,
        files: [],
        commits: [],
        checks: [
          { name: 'ci', state: 'COMPLETED', conclusion: null },
          { name: 'lint', state: 'SUCCESS', conclusion: 'SUCCESS' },
          { name: 'old', state: 'PASSED', conclusion: null }
        ],
        reviews: [],
        latestReviews: [],
        reviewDecision: '',
        reviewRequests: [],
        isDraft: false
      })
    ).toBe(2)
  })

  it('keeps PR content visible across quiet gitRevision reload', async () => {
    const { rerender } = render(<PrPanel workspacePath="/ws" gitRevision={0} />)
    await screen.findByText(/feat: panels/)
    const callsBefore = (window.vyotiq.prView as ReturnType<typeof vi.fn>).mock.calls.length
    rerender(<PrPanel workspacePath="/ws" gitRevision={1} />)
    await waitFor(() => {
      expect((window.vyotiq.prView as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
        callsBefore
      )
    })
    // Quiet reload must not swap the body to a bare Loading… empty state.
    expect(screen.getByText(/feat: panels/)).toBeTruthy()
    expect(screen.queryByText('Loading…')).toBeNull()
  })

  it('keeps the last PR title when a quiet prView fails', async () => {
    const { rerender } = render(<PrPanel workspacePath="/ws" gitRevision={0} />)
    await screen.findByText(/feat: panels/)
    ;(window.vyotiq.prView as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: 'GitHub is down'
    })
    rerender(<PrPanel workspacePath="/ws" gitRevision={1} />)
    await waitFor(() => {
      expect((window.vyotiq.prView as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1)
    })
    expect(screen.getByText(/feat: panels/)).toBeTruthy()
    expect(screen.queryByText('GitHub is down')).toBeNull()
  })

  it('does not call prView on gitRevision while inactive', async () => {
    const { rerender } = render(
      <PrPanel workspacePath="/ws" gitRevision={0} active={false} />
    )
    await waitFor(() => {
      expect(window.vyotiq.prView).not.toHaveBeenCalled()
    })
    rerender(<PrPanel workspacePath="/ws" gitRevision={1} active={false} />)
    await waitFor(() => {
      expect(window.vyotiq.prView).not.toHaveBeenCalled()
    })
  })

  it('shows Disconnect in the PR menu when an app token is present', async () => {
    window.vyotiq.githubAuthStatus = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        ghAvailable: true,
        ghAuthenticated: true,
        hasAppToken: true,
        pending: false,
        userCode: null,
        verificationUri: null,
        error: null
      }
    })
    render(<PrPanel workspacePath="/ws" />)
    await screen.findByText(/feat: panels/)
    fireEvent.click(screen.getByRole('button', { name: 'PR actions' }))
    expect(await screen.findByRole('menuitem', { name: 'Disconnect GitHub' })).toBeTruthy()
  })
})

describe('checkState and mergeSummary', () => {
  const base = {
    number: 1,
    title: 't',
    url: 'https://github.com/o/r/pull/1',
    state: 'OPEN',
    baseRefName: 'main',
    headRefName: 'feat',
    baseRefOid: 'a',
    headRefOid: 'b',
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
    mergeStateStatus: ''
  } satisfies PrView

  it('reads both node shapes the rollup mixes', () => {
    expect(checkState({ name: 'a', state: 'COMPLETED', conclusion: 'SUCCESS' }).glyph).toBe('review')
    expect(checkState({ name: 'b', state: 'SUCCESS', conclusion: null }).glyph).toBe('review')
    expect(checkState({ name: 'c', state: 'COMPLETED', conclusion: 'TIMED_OUT' }).glyph).toBe('failed')
    expect(checkState({ name: 'd', state: 'FAILURE', conclusion: null }).glyph).toBe('failed')
    expect(checkState({ name: 'e', state: 'COMPLETED', conclusion: 'CANCELLED' }).glyph).toBe('stopped')
    expect(checkState({ name: 'f', state: 'COMPLETED', conclusion: 'SKIPPED' })).toEqual({ glyph: 'done', word: 'skipped' })
    expect(checkState({ name: 'g', state: 'IN_PROGRESS', conclusion: null }).glyph).toBe('running')
    expect(checkState({ name: 'h', state: 'PENDING', conclusion: null }).glyph).toBe('queued')
  })

  it('holds Merge back only when GitHub would refuse it, and says why', () => {
    expect(prMergeBlockedReason({ ...base, mergeStateStatus: 'CLEAN' })).toBeNull()
    expect(prMergeBlockedReason({ ...base, mergeStateStatus: 'BEHIND' })).toBeNull()
    expect(prMergeBlockedReason({ ...base, mergeStateStatus: 'BLOCKED' })).toBe('Branch protection blocks the merge.')
    expect(prMergeBlockedReason({ ...base, mergeStateStatus: 'DIRTY' })).toBe('The branch conflicts with main.')
    expect(prMergeBlockedReason({ ...base, isDraft: true })).toBe('It is a draft — mark it ready for review to merge.')
    expect(prMergeBlockedReason({ ...base, state: 'MERGED' })).toBe('Already merged.')
  })

  it('claims only what GitHub reports', () => {
    expect(mergeSummary({ ...base, mergeStateStatus: 'CLEAN' })).toBe('Ready to merge.')
    expect(mergeSummary({ ...base, mergeStateStatus: 'DIRTY' })).toBe('The branch conflicts with main.')
    expect(mergeSummary({ ...base, mergeStateStatus: 'BEHIND' })).toBe('The branch is behind main.')
    expect(mergeSummary({ ...base, isDraft: true, mergeStateStatus: 'DRAFT' })).toBe(
      'It is a draft — mark it ready for review to merge.'
    )
    // An older gh with no merge state: nothing is claimed.
    expect(mergeSummary(base)).toBe('')
  })
})
