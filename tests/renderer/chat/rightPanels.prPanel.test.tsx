/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createPortal } from 'react-dom'
import { useLayoutEffect, useRef, useState } from 'react'
import { ChangesPanel } from '@renderer/features/chat/components/ChangesPanel'
import { DockTabBar, defaultDockTab } from '@renderer/features/chat/components/DockTabBar'
import { TerminalSessionBar } from '@renderer/features/chat/components/TerminalSessionBar'
import { checksPassedCount, PrPanel } from '@renderer/features/chat/components/PrPanel'

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
          isDraft: false
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
    expect(await screen.findByText(/feat: panels/)).toBeTruthy()
    expect(screen.getByText(/feat\/panels → main/)).toBeTruthy()
    expect(onPrMeta).toHaveBeenCalledWith({ number: 10, title: 'feat: panels' })
  })

  it('creates a draft PR from an already-pushed topic branch', async () => {
    ;(window.vyotiq.prView as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: null })
    render(<PrPanel workspacePath="/ws" />)
    fireEvent.click(await screen.findByRole('button', { name: /Create draft PR/i }))
    await waitFor(() => {
      expect(window.vyotiq.prCreate).toHaveBeenCalledWith('/ws', { draft: true })
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
    expect(screen.getByRole('button', { name: /Create draft PR/i })).toBeTruthy()
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
    fireEvent.click(await screen.findByRole('button', { name: /Create draft PR/i }))
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
    expect(screen.getByText(/Waiting for authorization/i)).toBeTruthy()
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
    expect(await screen.findByText(/Waiting for authorization/i)).toBeTruthy()
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

  it('calls prMerge for Squash & Merge after confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<PrPanel workspacePath="/ws" />)
    await screen.findByText(/feat: panels/)
    expect(screen.getByText('Open')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Squash & Merge/i }))
    expect(confirm).toHaveBeenCalled()
    expect(window.vyotiq.prMerge).toHaveBeenCalledWith('/ws', 'squash', 10)
  })

  it('skips prMerge when confirmation is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<PrPanel workspacePath="/ws" />)
    await screen.findByText(/feat: panels/)
    fireEvent.click(screen.getByRole('button', { name: /Squash & Merge/i }))
    expect(window.vyotiq.prMerge).not.toHaveBeenCalled()
  })

  it('exposes Reviews tab and expandable file diffs with viewed checkbox', async () => {
    render(<PrPanel workspacePath="/ws" />)
    await screen.findByText(/feat: panels/)
    expect(screen.getByRole('button', { name: /^Reviews/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show diff for a.ts' }))
    await waitFor(() => {
      expect(window.vyotiq.prDiff).toHaveBeenCalledWith({
        workspacePath: '/ws',
        path: 'a.ts',
        ignoreWhitespace: false,
        number: 10
      })
    })
    fireEvent.click(screen.getByRole('checkbox', { name: /Mark a\.ts as viewed/i }))
    expect(
      (screen.getByRole('checkbox', { name: /Mark a\.ts as viewed/i }) as HTMLInputElement).checked
    ).toBe(true)
  })

  it('shows Expand All, Filter files, Edit Title, Close PR, Hide panel in ··· menu', async () => {
    const onUnlink = vi.fn()
    render(<PrPanel workspacePath="/ws" onUnlink={onUnlink} />)
    await screen.findByText(/feat: panels/)
    fireEvent.click(screen.getByRole('button', { name: /PR actions/i }))
    expect(screen.getByRole('button', { name: /Expand All Files/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Collapse All/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /View on Web/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Filter files/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Edit Title/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Close PR/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Hide panel/i }))
    expect(onUnlink).toHaveBeenCalled()
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
    expect(screen.queryByRole('button', { name: /Squash & Merge/i })).toBeNull()
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
    fireEvent.click(screen.getByRole('button', { name: /PR actions/i }))
    expect(screen.getByRole('button', { name: /Disconnect/i })).toBeTruthy()
  })
})
