/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ChangesPanel } from '@renderer/features/chat/components/ChangesPanel'

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
/** The Changes tab as ChatView mounts it on a git scope. */
function renderGit(extra: Record<string, unknown> = {}) {
  return render(
    <ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} preferredScope="uncommitted" {...extra} />
  )
}

async function chooseScope(name: string): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Change scope' }))
  fireEvent.click(await screen.findByRole('option', { name }))
}

const row = (path: string): HTMLElement => document.querySelector(`[data-change-row="${path}"]`) as HTMLElement

/** Start composing a commit with the chosen intent from the footer's Commit menu. */
async function compose(intent: RegExp): Promise<HTMLInputElement> {
  fireEvent.click(screen.getByRole('button', { name: /^Commit$/ }))
  fireEvent.click(await screen.findByRole('menuitem', { name: intent }))
  return (await screen.findByRole('textbox', { name: /Commit message/i })) as HTMLInputElement
}

/** One finished edit the agent made, as the transcript records it. */
const agentEdit = (path: string) => [
  { kind: 'message' as const, id: 'u1', role: 'user' as const, content: 'edit', at: 1 },
  {
    kind: 'tool' as const,
    id: 'e1',
    at: 2,
    tool: {
      toolCallId: 'e1',
      name: 'edit',
      status: 'done' as const,
      summary: path,
      argsPreview: JSON.stringify({ path, contents: 'hello\n' })
    }
  }
]

/** One settled replacement: one line added above an unchanged one. */
const agentReplace = (path: string) => [
  { kind: 'message' as const, id: 'u1', role: 'user' as const, content: 'fix', at: 1 },
  {
    kind: 'tool' as const,
    id: 'r1',
    at: 2,
    tool: {
      toolCallId: 'r1',
      name: 'str_replace',
      status: 'done' as const,
      summary: path,
      argsPreview: JSON.stringify({
        path,
        old_string: '  await rename(staged, target)',
        new_string: '  await closeStagingWatcher()\n  await rename(staged, target)'
      })
    }
  }
]

const SWAP_DIFF = [
  '--- a/src/swap.ts',
  '+++ b/src/swap.ts',
  '@@ -1,4 +1,5 @@',
  ' export async function swapStaged() {',
  '   await prepare()',
  '+  await closeStagingWatcher()',
  '   await rename(staged, target)',
  ' }',
  ''
].join('\n')

describe('ChangesPanel', () => {
  it('opens on this task, and says so when it has changed nothing yet', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} />)
    expect(screen.getByRole('button', { name: 'Change scope' }).textContent).toContain('This task')
    expect(await screen.findByText('No changes yet')).toBeTruthy()
    expect(screen.getByText('Edits the agent makes land here as it makes them.')).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: 'Show uncommitted instead' }))
    expect(await screen.findByText('a.ts')).toBeTruthy()
  })

  it('lists git dirty files, one row each, with the counts in the toolbar', async () => {
    renderGit()
    expect(await screen.findByText('a.ts')).toBeTruthy()
    expect(row('src/a.ts').textContent).toContain('src')
    const toolbar = document.querySelector('[data-changes-toolbar]') as HTMLElement
    expect(toolbar.textContent).toContain('3 files')
    expect(within(toolbar).getByText('+5')).toBeTruthy()
    expect(within(toolbar).getByText('−5')).toBeTruthy()
  })

  it('includes deleted files in Staged scope and excludes untracked', async () => {
    renderGit()
    await screen.findByText('a.ts')
    await chooseScope('Staged')
    expect(await screen.findByText('gone.ts')).toBeTruthy()
    expect(screen.queryByText('new.ts')).toBeNull()
  })

  it('shows the selected file’s diff below the list, staged under Staged scope', async () => {
    renderGit()
    await screen.findByText('a.ts')
    await chooseScope('Staged')
    fireEvent.click(screen.getByRole('button', { name: 'src/a.ts, modified' }))
    await waitFor(() => {
      expect(window.vyotiq.gitDiff).toHaveBeenCalledWith({
        workspacePath: '/ws',
        path: 'src/a.ts',
        staged: true,
        ignoreWhitespace: false,
        sha: undefined
      })
    })
    const diff = document.querySelector('[data-change-diff]') as HTMLElement
    expect(within(diff).getByText('src/a.ts')).toBeTruthy()
    expect(await within(diff).findByText('new')).toBeTruthy()
  })

  it('requests vsHead diffs for Uncommitted mixed files', async () => {
    renderGit()
    fireEvent.click(await screen.findByRole('button', { name: 'src/a.ts, modified' }))
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

  it('steps to the next and previous file from the diff header', async () => {
    renderGit()
    await screen.findByText('a.ts')
    fireEvent.click(screen.getByRole('button', { name: 'gone.ts, deleted' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Next file' }))
    expect(row('new.ts').getAttribute('class')).toContain('bg-surface-2')
    fireEvent.click(screen.getByRole('button', { name: 'Previous file' }))
    expect(row('gone.ts').getAttribute('class')).toContain('bg-surface-2')
  })

  it('opens the file in the editor from its row', async () => {
    const onOpenFile = vi.fn()
    renderGit({ onOpenFile })
    await screen.findByText('a.ts')
    fireEvent.click(within(row('src/a.ts')).getByRole('button', { name: 'Open a.ts' }))
    expect(onOpenFile).toHaveBeenCalledWith('src/a.ts')
    // A deleted file has nothing to open.
    expect(within(row('gone.ts')).queryByRole('button', { name: 'Open gone.ts' })).toBeNull()
  })

  it('stages and unstages from the row', async () => {
    renderGit()
    await screen.findByText('a.ts')
    fireEvent.click(within(row('new.ts')).getByRole('button', { name: 'Stage new.ts' }))
    await waitFor(() => {
      expect(window.vyotiq.gitStagePaths).toHaveBeenCalledWith({ workspacePath: '/ws', paths: ['new.ts'] })
    })
    fireEvent.click(within(row('gone.ts')).getByRole('button', { name: 'Unstage gone.ts' }))
    await waitFor(() => {
      expect(window.vyotiq.gitUnstagePaths).toHaveBeenCalledWith({ workspacePath: '/ws', paths: ['gone.ts'] })
    })
  })

  it('switches between unified and split diffs', async () => {
    renderGit()
    await screen.findByText('a.ts')
    const layout = screen.getByRole('radiogroup', { name: 'Diff layout' })
    expect(within(layout).getByRole('radio', { name: 'Unified' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(within(layout).getByRole('radio', { name: 'Split' }))
    expect(within(layout).getByRole('radio', { name: 'Split' }).getAttribute('aria-checked')).toBe('true')
  })

  it('keeps wrap, whitespace and find in the more menu', async () => {
    renderGit()
    await screen.findByText('a.ts')
    fireEvent.click(screen.getByRole('button', { name: 'More changes actions' }))
    expect(await screen.findByRole('menuitemcheckbox', { name: 'Word wrap' })).toBeTruthy()
    expect(screen.getByRole('menuitemcheckbox', { name: 'Ignore whitespace' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Find in changes' }))
    expect(screen.getByRole('searchbox', { name: /Find in changes/i })).toBeTruthy()
  })

  it('lists commits from gitLog under Commits scope', async () => {
    renderGit()
    await screen.findByText('a.ts')
    await chooseScope('Commits')
    expect(await screen.findByText('first')).toBeTruthy()
    expect(window.vyotiq.gitLog).toHaveBeenCalled()
    expect(screen.queryByText(/Working tree changes will appear/i)).toBeNull()
  })

  it('shows files changed in a selected commit, and goes back to the list', async () => {
    renderGit()
    await screen.findByText('a.ts')
    await chooseScope('Commits')
    fireEvent.click(await screen.findByRole('button', { name: /first/i }))
    await waitFor(() => {
      expect(window.vyotiq.gitCommitFiles).toHaveBeenCalledWith({
        workspacePath: '/ws',
        sha: 'abc1234567890'
      })
    })
    expect(await screen.findByText('a.ts')).toBeTruthy()
    expect(screen.getAllByText('abc1234').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Back to commits' }))
    expect(await screen.findByRole('list', { name: 'Commits' })).toBeTruthy()
  })

  it('composes a commit with the agent-written message, then commits without pushing', async () => {
    renderGit()
    await screen.findByText('a.ts')
    const input = await compose(/^Commit…$/)
    await waitFor(() => {
      expect(input.value).toBe('feat: improve generated commit messages')
    })
    expect(window.vyotiq.gitGenerateCommitMessage).toHaveBeenCalledWith({ workspacePath: '/ws', mode: 'all' })
    fireEvent.click(screen.getByRole('button', { name: /^Commit$/ }))
    await waitFor(() => {
      expect(window.vyotiq.gitCommit).toHaveBeenCalledWith(
        '/ws',
        'feat: improve generated commit messages',
        false,
        'all'
      )
    })
    // A commit opens that commit's files.
    await waitFor(() => {
      expect(window.vyotiq.gitCommitFiles).toHaveBeenCalled()
    })
  })

  it('says why the agent wrote no message, and puts a plain one in its place', async () => {
    vi.mocked(window.vyotiq.gitGenerateCommitMessage).mockResolvedValueOnce({
      ok: true,
      data: { message: '', source: 'fallback', reason: 'No model is set up' }
    })
    renderGit()
    await screen.findByText('a.ts')
    const input = await compose(/^Commit…$/)
    await waitFor(() => {
      expect(input.value).toBe('Update 3 files')
    })
    const notice = screen.getByText(/No agent message: No model is set up/)
    expect(notice.getAttribute('aria-live')).toBe('polite')
    expect(screen.getByRole('button', { name: /^Commit$/ }).hasAttribute('disabled')).toBe(false)
  })

  it('commits and pushes when that was the choice', async () => {
    renderGit()
    await screen.findByText('a.ts')
    const input = await compose(/^Commit & Push…$/)
    fireEvent.change(input, { target: { value: 'ship it' } })
    fireEvent.click(screen.getByRole('button', { name: /^Commit & Push$/ }))
    await waitFor(() => {
      expect(window.vyotiq.gitCommit).toHaveBeenCalledWith('/ws', 'ship it', true, 'all')
    })
  })

  it('commits on Enter, and Esc drops the commit without touching the run', async () => {
    renderGit()
    await screen.findByText('a.ts')
    let input = await compose(/^Commit…$/)
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: /Commit message/i })).toBeNull()

    input = await compose(/^Commit…$/)
    fireEvent.change(input, { target: { value: 'commit only' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => {
      expect(window.vyotiq.gitCommit).toHaveBeenCalledWith('/ws', 'commit only', false, 'all')
    })
  })

  it('commits and creates a draft PR through the end-to-end action', async () => {
    renderGit()
    await screen.findByText('a.ts')
    const input = await compose(/^Commit & Create PR…$/)
    fireEvent.change(input, { target: { value: 'ship it' } })
    fireEvent.click(screen.getByRole('button', { name: /^Commit & Create PR$/ }))
    await waitFor(() => {
      expect(window.vyotiq.prCreate).toHaveBeenCalledWith('/ws', {
        message: 'ship it',
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
        data: { installed: true, detail: 'GitHub CLI installed with winget.', ghAvailable: true }
      }))
    )
    renderGit()
    await screen.findByText('a.ts')
    const input = await compose(/^Commit & Create PR…$/)
    fireEvent.change(input, { target: { value: 'install and ship' } })
    fireEvent.click(screen.getByRole('button', { name: /^Commit & Create PR$/ }))
    await waitFor(() => {
      expect(install).toHaveBeenCalled()
    })
    expect(prCreate).not.toHaveBeenCalled()
    releaseInstall()
    await waitFor(() => {
      expect(prCreate).toHaveBeenCalledWith('/ws', { message: 'install and ship', mode: 'all', draft: true })
    })
  })

  it('offers only a plain commit before a repository remote exists', async () => {
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
    renderGit()
    await screen.findByText('a.ts')
    fireEvent.click(screen.getByRole('button', { name: /^Commit$/ }))
    expect(await screen.findByRole('menuitem', { name: /^Commit…$/ })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: /Push/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /Create PR/ })).toBeNull()
  })

  it('selects the requested file from preferredSelectedPath and loads its diff', async () => {
    renderGit({ preferredSelectedPath: 'src/a.ts', preferredSelectedPathToken: 1 })
    await screen.findByText('a.ts')
    await waitFor(() => {
      expect(window.vyotiq.gitDiff).toHaveBeenCalledWith(
        expect.objectContaining({ workspacePath: '/ws', path: 'src/a.ts' })
      )
    })
    expect(row('src/a.ts').getAttribute('class')).toContain('bg-surface-2')
  })

  it('Staged scope commits only what is staged', async () => {
    renderGit()
    await screen.findByText('a.ts')
    await chooseScope('Staged')
    const input = await compose(/^Commit…$/)
    fireEvent.change(input, { target: { value: 'staged only' } })
    fireEvent.click(screen.getByRole('button', { name: /^Commit$/ }))
    await waitFor(() => {
      expect(window.vyotiq.gitCommit).toHaveBeenCalledWith('/ws', 'staged only', false, 'staged')
    })
  })

  it('Unstaged scope offers Stage all in the more menu', async () => {
    renderGit()
    await screen.findByText('a.ts')
    await chooseScope('Unstaged')
    fireEvent.click(screen.getByRole('button', { name: 'More changes actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Stage all' }))
    await waitFor(() => {
      expect(window.vyotiq.gitStageAll).toHaveBeenCalledWith('/ws')
    })
  })

  it('shows the not-a-repo state with Initialise repository', async () => {
    ;(window.vyotiq.gitStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: { kind: 'not_repo' }
    })
    renderGit()
    expect(await screen.findByText('Not a git repository')).toBeTruthy()
    // Undo points are the app's own copies, not git — only git's views need it.
    expect(screen.getByText('Uncommitted changes, commits and PRs need git. Initialise one here — nothing else changes.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Initialise repository' })).toBeTruthy()
  })

  it('shows this task’s edits when there is no git repository to list', async () => {
    ;(window.vyotiq.gitStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: { kind: 'not_repo' }
    })
    render(<ChangesPanel items={agentEdit('agent-only.ts')} workspacePath="/ws" gitRevision={1} preferredScope="uncommitted" />)
    expect(await screen.findByText('agent-only.ts')).toBeTruthy()
    expect(screen.queryByText('Not a git repository')).toBeNull()
    expect(screen.getByRole('button', { name: 'Change scope' }).textContent).toContain('This task')
  })

  it('says a task with no edits in a non-git workspace needs git, and offers to set it up', async () => {
    ;(window.vyotiq.gitStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: { kind: 'not_repo' }
    })
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} />)
    expect(await screen.findByText('Not a git repository')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Initialise repository' })).toBeTruthy()
  })

  it('shows git-not-found empty state when git is unavailable', async () => {
    ;(window.vyotiq.gitStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: { kind: 'unavailable', detail: 'Git is not installed or not on PATH' }
    })
    renderGit()
    expect(await screen.findByText('Git not found')).toBeTruthy()
    expect(screen.getByText(/not on PATH/i)).toBeTruthy()
  })

  it('applies preferredScope agent when preferredScopeToken bumps', async () => {
    const { rerender } = renderGit({ preferredScopeToken: 0 })
    await screen.findByText('a.ts')
    expect(screen.getByRole('button', { name: 'Change scope' }).textContent).toContain('Uncommitted')
    rerender(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} preferredScope="agent" preferredScopeToken={1} />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Change scope' }).textContent).toContain('This task')
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
    renderGit()
    await screen.findByText('a.ts')
    fireEvent.click(await screen.findByRole('button', { name: 'Switch branch' }))
    fireEvent.click(await screen.findByRole('option', { name: 'feat' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toMatch(/overwritten/i)
  })

  it('keeps the branch select out of this task’s view', async () => {
    render(<ChangesPanel items={agentEdit('src/a.ts')} workspacePath="/ws" gitRevision={1} />)
    await screen.findByText('a.ts')
    expect(screen.queryByRole('button', { name: 'Switch branch' })).toBeNull()
  })

  it('keeps and undoes this task’s edits, per file and all at once', async () => {
    const onKeepWriteFile = vi.fn()
    const onDiscardWriteFile = vi.fn()
    const onKeepAllWrites = vi.fn()
    const onDiscardAllWrites = vi.fn()
    render(
      <ChangesPanel
        items={agentEdit('src/a.ts')}
        workspacePath="/ws"
        gitRevision={1}
        canResolve
        resolvablePaths={new Set(['src/a.ts'])}
        onKeepWriteFile={onKeepWriteFile}
        onDiscardWriteFile={onDiscardWriteFile}
        onKeepAllWrites={onKeepAllWrites}
        onDiscardAllWrites={onDiscardAllWrites}
      />
    )
    await screen.findByText('a.ts')
    fireEvent.click(within(row('src/a.ts')).getByRole('button', { name: 'Keep a.ts' }))
    expect(onKeepWriteFile).toHaveBeenCalledWith('src/a.ts')
    fireEvent.click(within(row('src/a.ts')).getByRole('button', { name: 'Undo a.ts' }))
    expect(onDiscardWriteFile).toHaveBeenCalledWith('src/a.ts')
    const footer = document.querySelector('[data-changes-footer]') as HTMLElement
    fireEvent.click(within(footer).getByRole('button', { name: 'Keep all' }))
    expect(onKeepAllWrites).toHaveBeenCalled()
    fireEvent.click(within(footer).getByRole('button', { name: 'Undo all' }))
    expect(onDiscardAllWrites).toHaveBeenCalled()
  })

  it('says what was decided in place of the counts', async () => {
    render(
      <ChangesPanel
        items={agentEdit('src/a.ts')}
        workspacePath="/ws"
        gitRevision={1}
        canResolve
        resolvablePaths={new Set(['src/a.ts'])}
        writeFileResolutions={new Map([['src/a.ts', 'kept' as const]])}
        onKeepAllWrites={vi.fn()}
      />
    )
    await screen.findByText('a.ts')
    expect(row('src/a.ts').textContent).toContain('Kept')
    expect(within(row('src/a.ts')).queryByRole('button', { name: 'Keep a.ts' })).toBeNull()
    // Nothing left to decide, so the footer offers no Keep all.
    expect(screen.queryByRole('button', { name: 'Keep all' })).toBeNull()
  })

  it('holds Commit and Keep/Undo while the run is live, with Stop at hand', async () => {
    const onStopRun = vi.fn()
    render(
      <ChangesPanel
        items={agentEdit('src/a.ts')}
        workspacePath="/ws"
        gitRevision={1}
        running
        onStopRun={onStopRun}
        canResolve
        resolvablePaths={new Set(['src/a.ts'])}
        resolveBlockedReason="Stop the run to Keep/Discard agent writes."
        onKeepAllWrites={vi.fn()}
        onKeepWriteFile={vi.fn()}
      />
    )
    await screen.findByText('a.ts')
    const footer = document.querySelector('[data-changes-footer]') as HTMLElement
    expect(footer.textContent).toContain('Commit and Keep/Undo unlock when the run stops.')
    expect(within(footer).queryByRole('button', { name: /^Commit$/ })).toBeNull()
    fireEvent.click(within(footer).getByRole('button', { name: 'Stop run' }))
    expect(onStopRun).toHaveBeenCalled()
    expect((within(row('src/a.ts')).getByRole('button', { name: 'Keep a.ts' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('does not open find when an editable field is focused', async () => {
    render(
      <div>
        <textarea aria-label="Composer draft" />
        <ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} preferredScope="uncommitted" active />
      </div>
    )
    await screen.findByText('a.ts')
    const composer = screen.getByRole('textbox', { name: /composer draft/i })
    composer.focus()
    fireEvent.keyDown(composer, { key: 'f', ctrlKey: true })
    expect(screen.queryByRole('searchbox', { name: /Find in changes/i })).toBeNull()
  })

  it('opens find with Ctrl+F when the composer is not focused, and filters the list', async () => {
    renderGit({ active: true })
    await screen.findByText('a.ts')
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    const find = screen.getByRole('searchbox', { name: /Find in changes/i })
    fireEvent.change(find, { target: { value: 'gone' } })
    expect(screen.getByText('gone.ts')).toBeTruthy()
    expect(screen.queryByText('a.ts')).toBeNull()
  })
})

describe('This task — counts and diffs from the task’s checkpoints', () => {
  it('counts a replacement by what it changed, not its old and new text wholesale', async () => {
    render(<ChangesPanel items={agentReplace('src/swap.ts')} workspacePath="/ws" gitRevision={1} />)
    await waitFor(() => expect(row('src/swap.ts')).toBeTruthy())
    // One line added. The arguments hold one old line and two new ones.
    expect(row('src/swap.ts').textContent).toContain('+1')
    expect(row('src/swap.ts').textContent).not.toContain('−1')
    expect(row('src/swap.ts').textContent).not.toContain('+2')
  })

  it('asks the checkpoints first, and shows no numbers it cannot stand behind', async () => {
    window.vyotiq.taskFileStats = vi.fn().mockResolvedValue({
      ok: true,
      data: { files: [{ path: 'src/swap.ts', action: 'modified' }] }
    })
    render(<ChangesPanel items={agentReplace('src/swap.ts')} workspacePath="/ws" gitRevision={1} runId="run-1" />)
    await waitFor(() => expect(window.vyotiq.taskFileStats).toHaveBeenCalledWith({ workspacePath: '/ws', runId: 'run-1' }))
    await waitFor(() => expect(row('src/swap.ts').textContent).not.toContain('+1'))
    const toolbar = document.querySelector('[data-changes-toolbar]') as HTMLElement
    expect(toolbar.textContent).toContain('1 file')
    expect(toolbar.textContent).not.toMatch(/[+−]\d/)
  })

  it('shows the task’s diff with real line numbers under its hunk header', async () => {
    window.vyotiq.taskFileStats = vi.fn().mockResolvedValue({
      ok: true,
      data: { files: [{ path: 'src/swap.ts', action: 'modified', add: 1, del: 0 }] }
    })
    window.vyotiq.taskFileDiff = vi.fn().mockResolvedValue({
      ok: true,
      data: { path: 'src/swap.ts', action: 'modified', diff: SWAP_DIFF, add: 1, del: 0 }
    })
    render(<ChangesPanel items={agentReplace('src/swap.ts')} workspacePath="/ws" gitRevision={1} runId="run-1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'src/swap.ts, modified' }))
    const table = await waitFor(() => {
      const el = document.querySelector('[data-review-diff]')
      expect(el).toBeTruthy()
      return el as HTMLElement
    })
    expect(window.vyotiq.taskFileDiff).toHaveBeenCalledWith({ workspacePath: '/ws', runId: 'run-1', path: 'src/swap.ts' })
    expect(table.textContent).toContain('@@ -1,4 +1,5 @@')
    const added = table.querySelector('[data-diff-line="add"]') as HTMLElement
    expect(added.textContent).toContain('3')
    expect(added.textContent).toContain('+')
    expect(added.textContent).toContain('await closeStagingWatcher()')
  })

  it('falls back to git against HEAD for a file the task’s writes did not record', async () => {
    window.vyotiq.taskFileDiff = vi.fn().mockResolvedValue({
      ok: true,
      data: { path: 'src/swap.ts', action: null, diff: null, reason: 'not_in_task' }
    })
    render(<ChangesPanel items={agentReplace('src/swap.ts')} workspacePath="/ws" gitRevision={1} runId="run-1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'src/swap.ts, modified' }))
    await waitFor(() =>
      expect(window.vyotiq.gitDiff).toHaveBeenCalledWith({ workspacePath: '/ws', path: 'src/swap.ts', vsHead: true })
    )
  })
})

describe('ChangesPanel review', () => {
  afterEach(() => localStorage.clear())

  it('opens on the first file, side by side, under the task’s name', async () => {
    const onReviewBack = vi.fn()
    renderGit({ variant: 'review', reviewTitle: 'Regroup Settings', onReviewBack })
    expect(screen.getByRole('region', { name: 'Review' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Regroup Settings' })).toBeTruthy()
    const header = await waitFor(() => {
      const el = document.querySelector('[data-review-file]')
      expect(el?.textContent).toContain('a.ts')
      return el as HTMLElement
    })
    expect(header.textContent).toContain('src/')
    await waitFor(() => expect(document.querySelector('[data-review-diff="split"]')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Back to the record' }))
    expect(onReviewBack).toHaveBeenCalledTimes(1)
  })

  it('counts what you have marked viewed, and keeps it', async () => {
    const first = renderGit({ variant: 'review' })
    const progress = (): string => (document.querySelector('[data-review-progress]') as HTMLElement).textContent ?? ''
    await waitFor(() => expect(progress()).toContain('0 of 3 viewed'))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Viewed gone.ts' }))
    expect(progress()).toContain('1 of 3 viewed')
    // The open file's own box says the same thing.
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Viewed' }))
    expect(progress()).toContain('2 of 3 viewed')
    first.unmount()

    renderGit({ variant: 'review' })
    await waitFor(() => expect(progress()).toContain('2 of 3 viewed'))
    expect(screen.getByRole('checkbox', { name: 'Viewed gone.ts' }).getAttribute('aria-checked')).toBe('true')
  })

  it('asks the agent about a line, naming the file and the line', async () => {
    const onAskAboutLine = vi.fn()
    renderGit({ variant: 'review', onAskAboutLine })
    // Role queries over the whole diff table are slow under a full-suite load.
    fireEvent.click(await screen.findByRole('button', { name: 'Ask about line 1' }, { timeout: 5000 }))
    const input = await screen.findByRole('textbox', { name: 'Ask the agent about line 1' }, { timeout: 5000 })
    fireEvent.change(input, { target: { value: 'Why was this renamed?' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onAskAboutLine).toHaveBeenCalledWith(
      ['In `src/a.ts`, line 1:', '```', 'new', '```', '', 'Why was this renamed?'].join('\n')
    )
    expect(await screen.findByRole('status')).toBeTruthy()
  })

  it('says a removed line is the old version when asking about it', async () => {
    const onAskAboutLine = vi.fn()
    renderGit({ variant: 'review', onAskAboutLine })
    fireEvent.click(await screen.findByRole('button', { name: 'Ask about line 1 before the change' }, { timeout: 5000 }))
    const input = await screen.findByRole('textbox', { name: 'Ask the agent about line 1 before the change' }, { timeout: 5000 })
    fireEvent.change(input, { target: { value: 'Keep this?' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onAskAboutLine.mock.calls[0]![0]).toContain('line 1 as it was before the change (removed)')
  })

  it('undoes the open file when the task can still take it back', async () => {
    const onDiscardWriteFile = vi.fn()
    window.vyotiq.taskFileDiff = vi.fn().mockResolvedValue({
      ok: true,
      data: { path: 'src/swap.ts', action: 'modified', diff: SWAP_DIFF, add: 1, del: 0 }
    })
    render(
      <ChangesPanel
        items={agentReplace('src/swap.ts')}
        workspacePath="/ws"
        gitRevision={1}
        runId="run-1"
        variant="review"
        canResolve
        resolvablePaths={new Set(['src/swap.ts'])}
        onDiscardWriteFile={onDiscardWriteFile}
      />
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Undo this file' }))
    expect(onDiscardWriteFile).toHaveBeenCalledWith('src/swap.ts')
  })
})
