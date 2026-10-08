/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ChangesPanel } from '@renderer/features/chat/components/ChangesPanel'
import type { GitChangedFile } from '@shared/ipc'

function file(path: string, status: GitChangedFile['status'], staged: boolean, unstaged: boolean): GitChangedFile {
  return {
    path,
    status,
    added: 1,
    removed: 1,
    addedStaged: staged ? 1 : 0,
    removedStaged: staged ? 1 : 0,
    addedUnstaged: unstaged ? 1 : 0,
    removedUnstaged: unstaged ? 1 : 0,
    binary: false,
    staged,
    unstaged
  }
}

const FILES = [
  file('src/a.ts', 'modified', true, true),
  file('gone.ts', 'deleted', true, false),
  file('new.ts', 'untracked', false, true),
  file('both.ts', 'conflicted', true, true)
]

let discard: ReturnType<typeof vi.fn>

beforeEach(() => {
  discard = vi.fn().mockResolvedValue({
    ok: true,
    data: { detail: 'Discarded changes to src/a.ts · the old copy is in the trash', discarded: ['src/a.ts'], backedUp: 1 }
  })
  Object.defineProperty(window, 'vyotiq', {
    configurable: true,
    writable: true,
    value: {
      gitStatus: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          kind: 'ok',
          status: { branch: 'main', files: FILES, truncated: false, fileCount: 4, added: 4, removed: 4, hasRemote: true, hasCommits: true }
        }
      }),
      gitDiscardPaths: discard,
      // both.ts is conflicted: Changes puts the conflict resolver under it.
      gitConflictFile: vi.fn().mockResolvedValue({ ok: true, data: { ours: 'a\n', theirs: 'b\n', base: '', working: 'a\n' } }),
      gitGenerateCommitMessage: vi.fn().mockResolvedValue({ ok: true, data: { message: 'chore: x', source: 'agent' } }),
      gitBranches: vi.fn().mockResolvedValue({ ok: true, data: [{ name: 'main', current: true }] }),
      gitLog: vi.fn().mockResolvedValue({ ok: true, data: [] }),
      gitDiff: vi.fn().mockResolvedValue({ ok: true, data: { content: '@@ -1 +1 @@\n-old\n+new\n' } }),
      gitStagePaths: vi.fn(),
      gitUnstagePaths: vi.fn(),
      githubAuthStatus: vi.fn().mockResolvedValue({ ok: true, data: { ghAvailable: true, ghAuthenticated: true, hasAppToken: false, pending: false } }),
      onGithubAuthStatus: vi.fn(() => () => {})
    }
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const row = (path: string): HTMLElement => document.querySelector(`[data-change-row="${path}"]`) as HTMLElement

async function chooseScope(name: string): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Change scope' }))
  fireEvent.click(await screen.findByRole('option', { name }))
}

async function confirmDialog(button: 'Discard' | 'Cancel'): Promise<HTMLElement> {
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: button }))
  return dialog
}

describe('ChangesPanel: discarding your own changes', () => {
  it('Uncommitted: back to HEAD after a confirm, and says where the old copy went', async () => {
    const onGitMutated = vi.fn()
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} preferredScope="uncommitted" onGitMutated={onGitMutated} />)
    await screen.findByText('a.ts')
    fireEvent.click(within(row('src/a.ts')).getByRole('button', { name: 'Discard changes to src/a.ts' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toMatch(/All changes to src\/a\.ts, staged and unstaged, will be thrown away\. A copy of each file as it is now goes to the trash\./)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(discard).toHaveBeenCalledWith({ workspacePath: '/ws', paths: ['src/a.ts'], scope: 'all' }))
    expect(await screen.findByText('Discarded changes to src/a.ts · the old copy is in the trash')).toBeTruthy()
    expect(onGitMutated).toHaveBeenCalled()
  })

  it('says an untracked file goes to the trash', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} preferredScope="uncommitted" />)
    await screen.findByText('new.ts')
    fireEvent.click(within(row('new.ts')).getByRole('button', { name: 'Discard changes to new.ts' }))
    expect((await confirmDialog('Discard')).textContent).toMatch(/new\.ts is not tracked by git\. It will be moved to the trash\./)
    await waitFor(() => expect(discard).toHaveBeenCalledWith({ workspacePath: '/ws', paths: ['new.ts'], scope: 'all' }))
  })

  it('does nothing when the confirm is cancelled', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} preferredScope="uncommitted" />)
    await screen.findByText('a.ts')
    fireEvent.click(within(row('src/a.ts')).getByRole('button', { name: 'Discard changes to src/a.ts' }))
    await confirmDialog('Cancel')
    await new Promise((r) => setTimeout(r, 20))
    expect(discard).not.toHaveBeenCalled()
  })

  it('leaves a conflicted file to the conflict resolver', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} preferredScope="uncommitted" />)
    await screen.findByText('both.ts')
    expect(within(row('both.ts')).queryByRole('button', { name: /^Discard/ })).toBeNull()
  })

  it('Unstaged: drops only what is not staged', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} preferredScope="uncommitted" />)
    await screen.findByText('a.ts')
    await chooseScope('Unstaged')
    fireEvent.click(within(row('src/a.ts')).getByRole('button', { name: 'Discard changes to src/a.ts' }))
    expect((await confirmDialog('Discard')).textContent).toMatch(/The unstaged changes to src\/a\.ts will be thrown away; what is staged stays\./)
    await waitFor(() => expect(discard).toHaveBeenCalledWith({ workspacePath: '/ws', paths: ['src/a.ts'], scope: 'worktree' }))
  })

  it('Staged: offers no discard, only unstage', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} preferredScope="uncommitted" />)
    await screen.findByText('a.ts')
    await chooseScope('Staged')
    await waitFor(() => expect(row('gone.ts')).toBeTruthy())
    expect(within(row('gone.ts')).queryByRole('button', { name: /^Discard/ })).toBeNull()
    expect(within(row('gone.ts')).getByRole('button', { name: 'Unstage gone.ts' })).toBeTruthy()
  })

  it('discards every listed file but the conflicted one from the menu', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} preferredScope="uncommitted" />)
    await screen.findByText('a.ts')
    fireEvent.click(screen.getByRole('button', { name: 'More changes actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Discard all changes…' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Discard changes to 3 files')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard' }))
    await waitFor(() =>
      expect(discard).toHaveBeenCalledWith({ workspacePath: '/ws', paths: ['src/a.ts', 'gone.ts', 'new.ts'], scope: 'all' })
    )
  })

  it('offers no discard on this task’s own edits or on commits', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} preferredScope="uncommitted" />)
    await screen.findByText('a.ts')
    await chooseScope('Commits')
    expect(screen.queryByRole('button', { name: /^Discard changes/ })).toBeNull()
  })
})
