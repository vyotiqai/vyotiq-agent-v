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
describe('ChangesPanel', () => {
  it('renders git dirty files from gitStatus', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} />)
    expect((await screen.findAllByText('a.ts')).length).toBeGreaterThan(0)
    expect(screen.getByText(/Commit & Push/)).toBeTruthy()
  })

  it('includes deleted files in Staged scope and excludes untracked', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} />)
    await screen.findAllByText('a.ts')
    fireEvent.click(screen.getByRole('button', { name: /Uncommitted/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Staged/i }))
    expect((await screen.findAllByText('gone.ts')).length).toBeGreaterThan(0)
    expect(screen.queryByText('new.ts')).toBeNull()
  })

  it('passes staged:true to gitDiff when expanded under Staged scope', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} />)
    await screen.findAllByText('a.ts')
    fireEvent.click(screen.getByRole('button', { name: /Uncommitted/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Staged/i }))
    fireEvent.click(await screen.findByRole('button', { name: 'Show diff for src/a.ts' }))
    await waitFor(() => {
      expect(window.vyotiq.gitDiff).toHaveBeenCalledWith({
        workspacePath: '/ws',
        path: 'src/a.ts',
        staged: true,
        ignoreWhitespace: false,
        sha: undefined
      })
    })
  })

  it('shows a single-column files list', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} />)
    await screen.findAllByText('a.ts')
    expect(screen.queryByText('Tree')).toBeNull()
    expect(screen.getByText(/Files Changed/i)).toBeTruthy()
  })

  it('opens the workspace editor when a change row name is clicked', async () => {
    const onOpenFile = vi.fn()
    render(
      <ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} onOpenFile={onOpenFile} />
    )
    fireEvent.click((await screen.findAllByText('a.ts'))[0]!)
    expect(onOpenFile).toHaveBeenCalledWith('src/a.ts')
  })

  it('exposes Layout, Ignore Whitespace, and Find in the more menu', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} />)
    await screen.findAllByText('a.ts')
    fireEvent.click(screen.getByRole('button', { name: /More changes actions/i }))
    expect(screen.getByText(/Layout/i)).toBeTruthy()
    expect(screen.getByRole('switch', { name: /Ignore Whitespace/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Find in Changes/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Find in Changes/i }))
    expect(screen.getByRole('searchbox', { name: /Find in changes/i })).toBeTruthy()
  })

  it('lists commits from gitLog under Commits scope', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} />)
    await screen.findAllByText('a.ts')
    fireEvent.click(screen.getByRole('button', { name: /Uncommitted/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Commits/i }))
    expect(await screen.findByText('first')).toBeTruthy()
    expect(window.vyotiq.gitLog).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /All Commits/i })).toBeTruthy()
    expect(screen.queryByText(/Working tree changes will appear/i)).toBeNull()
  })

  it('shows files changed in a selected commit', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} />)
    await screen.findAllByText('a.ts')
    fireEvent.click(screen.getByRole('button', { name: /Uncommitted/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Commits/i }))
    fireEvent.click(await screen.findByRole('button', { name: /first/i }))
    await waitFor(() => {
      expect(window.vyotiq.gitCommitFiles).toHaveBeenCalledWith({
        workspacePath: '/ws',
        sha: 'abc1234567890'
      })
    })
    expect(await screen.findByText(/File Changed/i)).toBeTruthy()
    expect(screen.queryByText(/Working tree changes will appear/i)).toBeNull()
    expect(screen.queryByText(/No changes yet/i)).toBeNull()
  })

  it('after a successful commit opens that commit’s files', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} />)
    await screen.findAllByText('a.ts')
    fireEvent.click(screen.getByRole('button', { name: /Commit & Push/i }))
    const input = await screen.findByRole('textbox', { name: /Commit message/i })
    fireEvent.change(input, { target: { value: 'ship it' } })
    fireEvent.click(screen.getByRole('button', { name: /^Commit & Push$/i }))
    await waitFor(() => {
      expect(window.vyotiq.gitCommit).toHaveBeenCalledWith('/ws', 'ship it', true, 'all')
    })
    await waitFor(() => {
      expect(window.vyotiq.gitCommitFiles).toHaveBeenCalled()
    })
    expect(screen.getAllByText('abc1234').length).toBeGreaterThan(0)
    expect(await screen.findByText(/File Changed/i)).toBeTruthy()
  })

  it('populates the commit field with the agent-generated subject', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} />)
    await screen.findAllByText('a.ts')
    fireEvent.click(screen.getByRole('button', { name: /Commit & Push/i }))
    const input = await screen.findByRole('textbox', { name: /Commit message/i })
    await waitFor(() => {
      expect((input as HTMLInputElement).value).toBe('feat: improve generated commit messages')
    })
    expect(window.vyotiq.gitGenerateCommitMessage).toHaveBeenCalledWith({
      workspacePath: '/ws',
      mode: 'all'
    })
  })

  it('primary Commit & Push sends push:true after composing', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} />)
    await screen.findAllByText('a.ts')
    fireEvent.click(screen.getByRole('button', { name: /Commit & Push/i }))
    const input = await screen.findByRole('textbox', { name: /Commit message/i })
    fireEvent.change(input, { target: { value: 'ship it' } })
    fireEvent.click(screen.getByRole('button', { name: /^Commit & Push$/i }))
    await waitFor(() => {
      expect(window.vyotiq.gitCommit).toHaveBeenCalledWith('/ws', 'ship it', true, 'all')
    })
  })

  it('commits and creates a draft PR through the end-to-end action', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} />)
    await screen.findAllByText('a.ts')
    fireEvent.click(screen.getByRole('button', { name: /Commit & Push/i }))
    const input = await screen.findByRole('textbox', { name: /Commit message/i })
    fireEvent.change(input, { target: { value: 'ship it' } })
    fireEvent.click(screen.getByRole('button', { name: /^Commit & Create PR$/i }))
    await waitFor(() => {
      expect(window.vyotiq.prCreate).toHaveBeenCalledWith('/ws', {
        message: 'ship it',
        mode: 'all',
        draft: true
      })
    })
  })

  it('collapsed split-button menu runs Commit & Create PR with the generated message', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} />)
    await screen.findAllByText('a.ts')
    fireEvent.click(screen.getByRole('button', { name: /More commit options/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Commit & Create PR$/i }))
    await waitFor(() => {
      expect(window.vyotiq.prCreate).toHaveBeenCalledWith('/ws', {
        message: 'feat: improve generated commit messages',
        mode: 'all',
        draft: true
      })
    })
  })

  it('installs GitHub CLI automatically before creating a PR', async () => {
    ;(window.vyotiq.githubAuthStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: {
        ghAvailable: false,
        ghAuthenticated: true,
        hasAppToken: true,
        pending: false,
        userCode: null,
        verificationUri: null,
        error: null
      }
    })
    const install = window.vyotiq.githubCliInstall as ReturnType<typeof vi.fn>
    const prCreate = window.vyotiq.prCreate as ReturnType<typeof vi.fn>
    let releaseInstall!: () => void
    const installReady = new Promise<void>((resolve) => {
      releaseInstall = resolve
    })
    install.mockReturnValue(
      installReady.then(() => ({
        ok: true,
        data: {
          installed: true,
          detail: 'GitHub CLI installed with winget.',
          ghAvailable: true
        }
      }))
    )
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} />)
    await screen.findAllByText('a.ts')
    fireEvent.click(screen.getByRole('button', { name: /Commit & Push/i }))
    const input = await screen.findByRole('textbox', { name: /Commit message/i })
    fireEvent.change(input, { target: { value: 'install and ship' } })
    fireEvent.click(screen.getByRole('button', { name: /^Commit & Create PR$/i }))
    await waitFor(() => {
      expect(install).toHaveBeenCalled()
    })
    expect(prCreate).not.toHaveBeenCalled()
    releaseInstall()
    await waitFor(() => {
      expect(prCreate).toHaveBeenCalledWith('/ws', {
        message: 'install and ship',
        mode: 'all',
        draft: true
      })
    })
  })

  it('offers PR setup before a repository remote exists', async () => {
    ;(window.vyotiq.gitStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: {
        kind: 'ok',
        status: {
          branch: 'main',
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
              unstaged: true
            }
          ],
          truncated: false,
          fileCount: 1,
          added: 1,
          removed: 0,
          hasRemote: false,
          hasCommits: true
        }
      }
    })
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} />)
    await screen.findAllByText('a.ts')
    fireEvent.click(screen.getByRole('button', { name: /^Commit$/i }))
    const input = await screen.findByRole('textbox', { name: /Commit message/i })
    fireEvent.change(input, { target: { value: 'connect and ship' } })
    fireEvent.click(screen.getByRole('button', { name: /^Commit & Create PR$/i }))
    await waitFor(() => {
      expect(window.vyotiq.prCreate).toHaveBeenCalledWith('/ws', {
        message: 'connect and ship',
        mode: 'all',
        draft: true
      })
    })
  })

  it('commits without pushing when Enter submits the commit message', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} />)
    await screen.findAllByText('a.ts')
    fireEvent.click(screen.getByRole('button', { name: /Commit & Push/i }))
    const input = await screen.findByRole('textbox', { name: /Commit message/i })
    fireEvent.change(input, { target: { value: 'commit only' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => {
      expect(window.vyotiq.gitCommit).toHaveBeenCalledWith('/ws', 'commit only', false, 'all')
    })
  })

  it('selects and expands the requested file from preferredSelectedPath', async () => {
    render(
      <ChangesPanel
        items={[]}
        workspacePath="/ws"
        gitRevision={1}
        preferredSelectedPath="src/a.ts"
        preferredSelectedPathToken={1}
      />
    )
    await screen.findAllByText('a.ts')
    await waitFor(() => {
      expect(window.vyotiq.gitDiff).toHaveBeenCalledWith(
        expect.objectContaining({ workspacePath: '/ws', path: 'src/a.ts' })
      )
    })
  })

  it('Staged scope commits without staging all', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} />)
    await screen.findAllByText('a.ts')
    fireEvent.click(screen.getByRole('button', { name: /Uncommitted/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Staged/i }))
    fireEvent.click(screen.getByRole('button', { name: /Commit & Push/i }))
    const input = await screen.findByRole('textbox', { name: /Commit message/i })
    fireEvent.change(input, { target: { value: 'staged only' } })
    fireEvent.click(screen.getByRole('button', { name: /^Commit$/i }))
    await waitFor(() => {
      expect(window.vyotiq.gitCommit).toHaveBeenCalledWith('/ws', 'staged only', false, 'staged')
    })
  })

  it('Unstaged scope exposes Stage All', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} />)
    await screen.findAllByText('a.ts')
    fireEvent.click(screen.getByRole('button', { name: /Uncommitted/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Unstaged/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Stage All$/i }))
    await waitFor(() => {
      expect(window.vyotiq.gitStageAll).toHaveBeenCalledWith('/ws')
    })
  })

  it('shows not-a-repo empty state when gitStatus is not_repo', async () => {
    ;(window.vyotiq.gitStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: { kind: 'not_repo' }
    })
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} />)
    expect(await screen.findByText('Not a git repository')).toBeTruthy()
  })

  it('prefers agent ChangeSummary when not_repo and agent edits exist', async () => {
    ;(window.vyotiq.gitStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: { kind: 'not_repo' }
    })
    const items = [
      { kind: 'message' as const, id: 'u1', role: 'user' as const, content: 'edit', at: 1 },
      {
        kind: 'tool' as const,
        id: 'e1',
        at: 2,
        tool: {
          toolCallId: 'e1',
          name: 'edit',
          status: 'done' as const,
          summary: 'agent-only.ts',
          argsPreview: JSON.stringify({ path: 'agent-only.ts', contents: 'hello\n' })
        }
      }
    ]
    render(<ChangesPanel items={items} workspacePath="/ws" gitRevision={1} />)
    expect(await screen.findByText('agent-only.ts')).toBeTruthy()
    expect(screen.getByText(/1 File Changed/i)).toBeTruthy()
    expect(screen.queryByText('Not a git repository')).toBeNull()
    expect(screen.queryByText(/Agent edits/i)).toBeNull()
    expect(screen.getByRole('button', { name: /Last Agent Turn/i })).toBeTruthy()
  })

  it('shows git-not-found empty state when git is unavailable', async () => {
    ;(window.vyotiq.gitStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: { kind: 'unavailable', detail: 'Git is not installed or not on PATH' }
    })
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} />)
    expect(await screen.findByText('Git not found')).toBeTruthy()
    expect(screen.getByText(/not on PATH/i)).toBeTruthy()
  })

  it('shows agent empty state when Last Agent Turn has no edits', async () => {
    render(
      <ChangesPanel
        items={[]}
        workspacePath="/ws"
        gitRevision={1}
        preferredScope="agent"
        preferredScopeToken={1}
      />
    )
    expect(await screen.findByText('No agent edits')).toBeTruthy()
    expect(
      screen.getByText(/Agent edits will appear here with Keep \/ Discard when available/i)
    ).toBeTruthy()
  })

  it('applies preferredScope agent when preferredScopeToken bumps', async () => {
    const { rerender } = render(
      <ChangesPanel
        items={[]}
        workspacePath="/ws"
        gitRevision={1}
        preferredScope="uncommitted"
        preferredScopeToken={0}
      />
    )
    await screen.findAllByText('a.ts')
    expect(screen.getByRole('button', { name: /Uncommitted/i })).toBeTruthy()
    rerender(
      <ChangesPanel
        items={[]}
        workspacePath="/ws"
        gitRevision={1}
        preferredScope="agent"
        preferredScopeToken={1}
      />
    )
    expect(await screen.findByRole('button', { name: /Last Agent Turn/i })).toBeTruthy()
  })

  it('requests vsHead diffs for Uncommitted mixed files', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Show diff for src/a.ts' }))
    await waitFor(() => {
      expect(window.vyotiq.gitDiff).toHaveBeenCalledWith({
        workspacePath: '/ws',
        path: 'src/a.ts',
        staged: false,
        ignoreWhitespace: false,
        sha: undefined,
        vsHead: true
      })
    })
  })

  it('surfaces checkout failure as a notice', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    window.vyotiq.gitBranches = vi.fn().mockResolvedValue({
      ok: true,
      data: [
        { name: 'main', current: true },
        { name: 'feat', current: false }
      ]
    })
    window.vyotiq.gitCheckout = vi.fn().mockResolvedValue({
      ok: false,
      error: 'local changes would be overwritten by checkout'
    })
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} />)
    await screen.findAllByText('a.ts')
    fireEvent.click(screen.getByRole('button', { name: 'main' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /^feat$/i }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toMatch(/overwritten/i)
  })

  it('does not open find when an editable field is focused', async () => {
    render(
      <div>
        <textarea aria-label="Composer draft" />
        <ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} active />
      </div>
    )
    await screen.findAllByText('a.ts')
    const composer = screen.getByRole('textbox', { name: /composer draft/i })
    composer.focus()
    fireEvent.keyDown(composer, { key: 'f', ctrlKey: true })
    expect(screen.queryByRole('searchbox', { name: /Find in changes/i })).toBeNull()
  })

  it('opens find with Ctrl+F when the composer is not focused', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} active />)
    await screen.findAllByText('a.ts')
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    expect(screen.getByRole('searchbox', { name: /Find in changes/i })).toBeTruthy()
  })
})
