/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ChangesPanel } from '@renderer/features/chat/components/ChangesPanel'
import { diffFingerprint, hunkIdentity, parseUnifiedHunks } from '@shared/utils/hunkPatch'
import type { GitChangedFile } from '@shared/ipc'

function file(path: string, status: GitChangedFile['status'], staged: boolean, unstaged: boolean): GitChangedFile {
  return {
    path,
    status,
    added: 2,
    removed: 2,
    addedStaged: staged ? 2 : 0,
    removedStaged: staged ? 2 : 0,
    addedUnstaged: unstaged ? 2 : 0,
    removedUnstaged: unstaged ? 2 : 0,
    binary: false,
    staged,
    unstaged
  }
}

const TWO_HUNKS = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  '-old',
  '+new',
  ' same',
  '@@ -10,2 +10,2 @@',
  '-x',
  '+y',
  ' z'
].join('\n')

const HEAD = 'a'.repeat(40)
const STASH = 'b'.repeat(40)

let api: Record<string, ReturnType<typeof vi.fn>>

function mount(files: GitChangedFile[] = [file('src/a.ts', 'modified', true, true)], status: Record<string, unknown> = {}): void {
  api = {
    gitStatus: vi.fn().mockResolvedValue({
      ok: true,
      data: {
        kind: 'ok',
        status: {
          branch: 'main',
          files,
          truncated: false,
          fileCount: files.length,
          added: 2,
          removed: 2,
          hasRemote: true,
          hasCommits: true,
          upstream: 'origin/main',
          ahead: 1,
          behind: 0,
          ...status
        }
      }
    }),
    gitGenerateCommitMessage: vi.fn().mockResolvedValue({ ok: true, data: { message: 'chore: drafted', source: 'agent' } }),
    gitBranches: vi.fn().mockResolvedValue({ ok: true, data: [{ name: 'main', current: true }, { name: 'feature', current: false }] }),
    gitLog: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    gitDiff: vi.fn().mockResolvedValue({ ok: true, data: { content: TWO_HUNKS } }),
    gitCheckout: vi.fn().mockResolvedValue({ ok: true, data: { detail: 'Checked out feature. Your changes stay on main', stashed: true } }),
    gitBranchStash: vi.fn().mockResolvedValue({ ok: true, data: null }),
    gitStashRestore: vi.fn().mockResolvedValue({ ok: true, data: { detail: 'Restored the changes left on main', conflicted: false } }),
    gitStashDrop: vi.fn().mockResolvedValue({ ok: true, data: { detail: 'Dropped the changes left on main' } }),
    gitStageHunk: vi.fn().mockResolvedValue({ ok: true, data: { detail: 'Staged the hunk at line 10 of src/a.ts' } }),
    gitLastCommit: vi.fn().mockResolvedValue({ ok: true, data: { sha: HEAD, message: 'feat: first try\n\nbody', pushed: false, amendable: true } }),
    gitAmend: vi.fn().mockResolvedValue({ ok: true, data: { committed: true, pushed: false, detail: 'Amended aaaaaaa' } }),
    gitFetch: vi.fn().mockResolvedValue({ ok: true, data: { detail: 'Fetched a moment ago', skipped: true } }),
    gitStagePaths: vi.fn(),
    gitUnstagePaths: vi.fn(),
    githubAuthStatus: vi.fn().mockResolvedValue({ ok: true, data: { ghAvailable: true, ghAuthenticated: true, hasAppToken: false, pending: false } }),
    onGithubAuthStatus: vi.fn(() => () => {})
  }
  Object.defineProperty(window, 'vyotiq', { configurable: true, writable: true, value: api })
}

beforeEach(() => mount())

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

async function chooseScope(name: string): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Change scope' }))
  fireEvent.click(await screen.findByRole('option', { name }))
}

async function pickBranch(name: string): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Switch branch' }))
  fireEvent.click(await screen.findByRole('option', { name }))
}

describe('ChangesPanel: switching with uncommitted changes', () => {
  it('asks, and "Leave them on main" stashes them on the way out', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} preferredScope="uncommitted" />)
    await screen.findByText('a.ts')
    await pickBranch('feature')
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Switch to feature')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Leave them on main' }))
    await waitFor(() => expect(api.gitCheckout).toHaveBeenCalledWith('/ws', 'feature', { leaveChanges: true }))
    expect(await screen.findByText('Checked out feature. Your changes stay on main')).toBeTruthy()
  })

  it('"Bring them along" is a plain switch, and Cancel switches nothing', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} preferredScope="uncommitted" />)
    await screen.findByText('a.ts')
    await pickBranch('feature')
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    await new Promise((r) => setTimeout(r, 20))
    expect(api.gitCheckout).not.toHaveBeenCalled()
    await pickBranch('feature')
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Bring them along' }))
    await waitFor(() => expect(api.gitCheckout).toHaveBeenCalledWith('/ws', 'feature', undefined))
  })

  it('a clean tree switches without asking', async () => {
    mount([])
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} preferredScope="uncommitted" />)
    await waitFor(() => expect(api.gitBranches).toHaveBeenCalled())
    await pickBranch('feature')
    await waitFor(() => expect(api.gitCheckout).toHaveBeenCalledWith('/ws', 'feature', undefined))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('offers back changes left on this branch, and restores them', async () => {
    api.gitBranchStash!.mockResolvedValue({ ok: true, data: { sha: STASH, branch: 'main', files: 3, createdAt: null } })
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} preferredScope="uncommitted" />)
    const rowEl = await waitFor(() => {
      const el = document.querySelector('[data-branch-stash]')
      if (!el) throw new Error('no stash row yet')
      return el as HTMLElement
    })
    expect(rowEl.textContent).toMatch(/Changes you left on main · 3 files/)
    fireEvent.click(within(rowEl).getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(api.gitStashRestore).toHaveBeenCalledWith({ workspacePath: '/ws', sha: STASH }))
    expect(await screen.findByText('Restored the changes left on main')).toBeTruthy()
    await waitFor(() => expect(document.querySelector('[data-branch-stash]')).toBeNull())
  })

  it('shows them on "This task" too, where the tab opens: a clean tree there gives no other hint', async () => {
    api.gitBranchStash!.mockResolvedValue({ ok: true, data: { sha: STASH, branch: 'main', files: 2, createdAt: null } })
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} />)
    const rowEl = await waitFor(() => {
      const el = document.querySelector('[data-branch-stash]')
      if (!el) throw new Error('no stash row yet')
      return el as HTMLElement
    })
    expect(rowEl.textContent).toMatch(/Changes you left on main · 2 files/)
    expect(within(rowEl).getByRole('button', { name: 'Restore' })).toBeTruthy()
  })
})

describe('ChangesPanel: background fetch', () => {
  it('asks main quietly once Changes is on screen, and shows what a fetch brought in', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    api.gitFetch!.mockResolvedValue({ ok: true, data: { detail: 'Fetched · 1 new commit on origin/main', ahead: 1, behind: 1 } })
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} preferredScope="uncommitted" />)
    await screen.findByText('a.ts')
    expect(document.querySelector('[data-git-behind]')).toBeNull()
    api.gitStatus!.mockResolvedValue({
      ok: true,
      data: {
        kind: 'ok',
        status: {
          branch: 'main',
          files: [file('src/a.ts', 'modified', true, true)],
          truncated: false,
          fileCount: 1,
          added: 2,
          removed: 2,
          hasRemote: true,
          hasCommits: true,
          upstream: 'origin/main',
          ahead: 1,
          behind: 1
        }
      }
    })
    await waitFor(() => expect(api.gitFetch).toHaveBeenCalledWith({ workspacePath: '/ws', background: true }), { timeout: 5000 })
    await waitFor(() => expect(document.querySelector('[data-git-behind]')?.textContent).toBe('1'), { timeout: 5000 })
    // Quiet: no notice for a fetch nobody clicked.
    expect(screen.queryByText(/Fetched · 1 new commit/)).toBeNull()
  })

  it('a skipped background fetch reads nothing again', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} preferredScope="uncommitted" />)
    await screen.findByText('a.ts')
    await waitFor(() => expect(api.gitFetch).toHaveBeenCalled(), { timeout: 5000 })
    const reads = api.gitStatus!.mock.calls.length
    await new Promise((r) => setTimeout(r, 200))
    expect(api.gitStatus!.mock.calls.length).toBe(reads)
  })

  it('a skip because another worktree of the repository just fetched reads the counts again', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    api.gitFetch!.mockResolvedValue({ ok: true, data: { detail: 'Fetched a moment ago', skipped: true, refsMoved: true } })
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} preferredScope="uncommitted" />)
    await screen.findByText('a.ts')
    const reads = api.gitStatus!.mock.calls.length
    await waitFor(() => expect(api.gitFetch).toHaveBeenCalled(), { timeout: 5000 })
    await waitFor(() => expect(api.gitStatus!.mock.calls.length).toBeGreaterThan(reads))
  })
})

describe('ChangesPanel: the full-width review', () => {
  it('Unstaged: stages a hunk, and the file header discards the file, as the side panel does', async () => {
    api.gitDiscardPaths = vi.fn().mockResolvedValue({ ok: true, data: { detail: 'Discarded changes to src/a.ts' } })
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} preferredScope="unstaged" variant="review" reviewTitle="Review" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Stage the hunk at line 10' }))
    const hunk = hunkIdentity(parseUnifiedHunks(TWO_HUNKS)[1]!)
    await waitFor(() =>
      expect(api.gitStageHunk).toHaveBeenCalledWith({ workspacePath: '/ws', path: 'src/a.ts', hunk, diffHash: diffFingerprint(TWO_HUNKS) })
    )
    const header = document.querySelector('[data-review-file]') as HTMLElement
    expect(within(header).getByRole('button', { name: 'Stage src/a.ts' })).toBeTruthy()
    fireEvent.click(within(header).getByRole('button', { name: 'Discard changes to src/a.ts' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(api.gitDiscardPaths).toHaveBeenCalledWith({ workspacePath: '/ws', paths: ['src/a.ts'], scope: 'worktree' }))
  })

  it('Staged: each hunk has Unstage', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} preferredScope="staged" variant="review" reviewTitle="Review" />)
    expect(await screen.findByRole('button', { name: 'Unstage the hunk at line 1' })).toBeTruthy()
  })

  it('offers Discard all changes in its menu', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} preferredScope="uncommitted" variant="review" reviewTitle="Review" />)
    await screen.findByRole('button', { name: 'Discard changes to src/a.ts' })
    fireEvent.click(screen.getByRole('button', { name: 'Scope, wrap, whitespace, undo all' }))
    expect(await screen.findByRole('menuitem', { name: 'Discard all changes…' })).toBeTruthy()
  })
})

describe('ChangesPanel: staging one hunk', () => {
  it('Unstaged: each hunk has Stage, and it names the hunk on screen', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} preferredScope="unstaged" />)
    // Files open on their diff; the column shows it without a click.
    await screen.findByText('a.ts')
    fireEvent.click(await screen.findByRole('button', { name: 'Stage the hunk at line 10' }))
    const hunk = hunkIdentity(parseUnifiedHunks(TWO_HUNKS)[1]!)
    await waitFor(() =>
      expect(api.gitStageHunk).toHaveBeenCalledWith({ workspacePath: '/ws', path: 'src/a.ts', hunk, diffHash: diffFingerprint(TWO_HUNKS) })
    )
    expect(await screen.findByText('Staged the hunk at line 10 of src/a.ts')).toBeTruthy()
  })

  it('Staged: each hunk has Unstage', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} preferredScope="staged" />)
    // Files open on their diff; the column shows it without a click.
    await screen.findByText('a.ts')
    fireEvent.click(await screen.findByRole('button', { name: 'Unstage the hunk at line 1' }))
    await waitFor(() => expect(api.gitStageHunk).toHaveBeenCalledWith(expect.objectContaining({ path: 'src/a.ts', unstage: true })))
  })

  it('Uncommitted shows the diff without hunk staging', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} preferredScope="uncommitted" />)
    // Files open on their diff; the column shows it without a click.
    await screen.findByText('a.ts')
    await screen.findByText('new')
    expect(screen.queryByRole('button', { name: /^(Stage|Unstage) the hunk/ })).toBeNull()
  })
})

describe('ChangesPanel: the commit box', () => {
  async function openCommit(): Promise<HTMLTextAreaElement> {
    fireEvent.click(screen.getAllByRole('button', { name: 'Commit' }).at(-1)!)
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Commit…' }))
    return (await screen.findByRole('textbox', { name: /commit message/i })) as HTMLTextAreaElement
  }
  const facts = (): string => (document.querySelector('[data-commit-facts]') as HTMLElement).textContent ?? ''

  it('counts every file the commit takes, not the ones the list stops at', async () => {
    mount(undefined, { truncated: true, fileCount: 215 })
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} preferredScope="uncommitted" />)
    await screen.findByText('a.ts')
    await openCommit()
    expect(facts()).toMatch(/Commit to main · 215 files/)
  })

  it('a staged count past the list cap reads as a floor', async () => {
    mount(undefined, { truncated: true, fileCount: 215 })
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} preferredScope="staged" />)
    await screen.findByText('a.ts')
    await openCommit()
    expect(facts()).toMatch(/Commit to main · 1\+ files/)
  })

  it('on "This task" it says the commit takes every uncommitted file', async () => {
    mount(undefined, { fileCount: 215 })
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} />)
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Commit' }).length).toBeGreaterThan(0))
    await openCommit()
    expect(facts()).toMatch(/Commit to main · all 215 uncommitted files/)
  })

  it('fills in the drafted subject and body, and says it was drafted', async () => {
    api.gitGenerateCommitMessage!.mockResolvedValue({
      ok: true,
      data: { message: 'feat(git): read every changed file\n\n- list all files\n- skip lockfiles', source: 'agent' }
    })
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} preferredScope="uncommitted" />)
    await screen.findByText('a.ts')
    const field = await openCommit()
    await waitFor(() => expect(field.value).toBe('feat(git): read every changed file\n\n- list all files\n- skip lockfiles'))
    expect(facts()).toMatch(/Drafted from the diff · edit freely/)
    // Shown with git's own line breaks: a 72-column body is not wrapped again.
    expect(field.getAttribute('wrap')).toBe('off')
  })
})

describe('ChangesPanel: amending the last commit', () => {
  it('offers Amend while the last commit is unpushed, starting from its own message', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} preferredScope="uncommitted" />)
    await screen.findByText('a.ts')
    await waitFor(() => expect(api.gitLastCommit).toHaveBeenCalled())
    fireEvent.click(screen.getAllByRole('button', { name: 'Commit' }).at(-1)!)
    fireEvent.click(await screen.findByRole('menuitem', { name: /Amend last commit…/ }))
    const field = (await screen.findByRole('textbox', { name: /commit message/i })) as HTMLTextAreaElement
    expect(field.value).toBe('feat: first try\n\nbody')
    expect(screen.getByText(/Amends aaaaaaa · not pushed yet/)).toBeTruthy()
    fireEvent.change(field, { target: { value: 'feat: first try, with the file I forgot' } })
    fireEvent.click(screen.getByRole('button', { name: 'Amend' }))
    await waitFor(() =>
      expect(api.gitAmend).toHaveBeenCalledWith({
        workspacePath: '/ws',
        message: 'feat: first try, with the file I forgot',
        sha: HEAD,
        mode: 'all'
      })
    )
    expect(api.gitGenerateCommitMessage).not.toHaveBeenCalledWith(expect.objectContaining({ force: true }))
  })

  it('offers no Amend once the commit is pushed', async () => {
    api.gitLastCommit!.mockResolvedValue({ ok: true, data: { sha: HEAD, message: 'x', pushed: true, amendable: true } })
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} preferredScope="uncommitted" />)
    await screen.findByText('a.ts')
    await waitFor(() => expect(api.gitLastCommit).toHaveBeenCalled())
    fireEvent.click(screen.getAllByRole('button', { name: 'Commit' }).at(-1)!)
    await screen.findByRole('menuitem', { name: 'Commit…' })
    expect(screen.queryByRole('menuitem', { name: /Amend/ })).toBeNull()
  })
})

describe('ChangesPanel: after the audit', () => {
  const stashRow = (): Promise<HTMLElement> =>
    waitFor(() => {
      const el = document.querySelector('[data-branch-stash]')
      if (!el) throw new Error('no stash row yet')
      return el as HTMLElement
    })

  const statusWith = (extra: Record<string, unknown>) => ({
    ok: true,
    data: {
      kind: 'ok',
      status: {
        branch: 'main',
        files: [file('src/a.ts', 'modified', true, true)],
        truncated: false,
        fileCount: 1,
        added: 2,
        removed: 2,
        hasRemote: true,
        hasCommits: true,
        upstream: 'origin/main',
        ahead: 1,
        behind: 0,
        ...extra
      }
    }
  })

  it('a restore with conflicts keeps the row, now to drop the stash once they are resolved', async () => {
    api.gitBranchStash!.mockResolvedValue({ ok: true, data: { sha: STASH, branch: 'main', files: 1, createdAt: null } })
    api.gitStashRestore!.mockResolvedValue({
      ok: true,
      data: { detail: '1 file came back with conflicts; the stash is kept', conflicted: true }
    })
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} preferredScope="uncommitted" />)
    fireEvent.click(within(await stashRow()).getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect((document.querySelector('[data-branch-stash]') as HTMLElement).textContent).toMatch(/Restored with conflicts/))
    // The notice says what happened; only the row says what to do next.
    expect(await screen.findByText('1 file came back with conflicts; the stash is kept')).toBeTruthy()
    expect(document.body.textContent?.match(/resolve them, then drop/g)).toHaveLength(1)
    expect(within(await stashRow()).queryByRole('button', { name: 'Restore' })).toBeNull()
    // Its changes are in the files now: dropping it asks nothing.
    fireEvent.click(within(await stashRow()).getByRole('button', { name: 'Drop stash' }))
    await waitFor(() => expect(api.gitStashDrop).toHaveBeenCalledWith({ workspacePath: '/ws', sha: STASH }))
    await waitFor(() => expect(document.querySelector('[data-branch-stash]')).toBeNull())
  })

  it('dropping changes that were never restored asks first', async () => {
    api.gitBranchStash!.mockResolvedValue({ ok: true, data: { sha: STASH, branch: 'main', files: 2, createdAt: null } })
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} preferredScope="uncommitted" />)
    fireEvent.click(within(await stashRow()).getByRole('button', { name: 'Drop these changes…' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toMatch(/will be deleted from the stash, not restored/)
    expect(api.gitStashDrop).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Drop' }))
    await waitFor(() => expect(api.gitStashDrop).toHaveBeenCalledWith({ workspacePath: '/ws', sha: STASH }))
  })

  it('Amend amends the commit it was opened on, even when another is the latest by the time it is sent', async () => {
    const view = render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} preferredScope="uncommitted" />)
    await screen.findByText('a.ts')
    await waitFor(() => expect(api.gitLastCommit).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getAllByRole('button', { name: 'Commit' }).at(-1)!)
    fireEvent.click(await screen.findByRole('menuitem', { name: /Amend last commit…/ }))
    await screen.findByText(/Amends aaaaaaa · not pushed yet/)
    // A commit lands from a terminal while the box is open; the panel reads it.
    api.gitLastCommit!.mockResolvedValue({ ok: true, data: { sha: 'c'.repeat(40), message: 'from the terminal', pushed: false, amendable: true } })
    view.rerender(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={2} preferredScope="uncommitted" />)
    await waitFor(() => expect(api.gitLastCommit).toHaveBeenCalledTimes(2))
    // Still the commit whose message is in the box; main refuses it, as it is no longer HEAD.
    expect(screen.getByText(/Amends aaaaaaa · not pushed yet/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Amend' }))
    await waitFor(() => expect(api.gitAmend).toHaveBeenCalledWith(expect.objectContaining({ sha: HEAD })))
  })

  it('Amend offers no Rewrite: a drafted message would describe only what is being added', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} preferredScope="uncommitted" />)
    await screen.findByText('a.ts')
    await waitFor(() => expect(api.gitLastCommit).toHaveBeenCalled())
    fireEvent.click(screen.getAllByRole('button', { name: 'Commit' }).at(-1)!)
    fireEvent.click(await screen.findByRole('menuitem', { name: /Amend last commit…/ }))
    await screen.findByText(/Amends aaaaaaa/)
    expect(screen.queryByRole('button', { name: 'Rewrite' })).toBeNull()
  })

  it('reads the last commit again when HEAD moves under the same ahead count', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    api.gitStatus!.mockResolvedValue(statusWith({ head: HEAD }))
    // A background fetch that ran reads the status again; by then a pull with rebase moved HEAD.
    api.gitFetch!.mockResolvedValue({ ok: true, data: { detail: 'Fetched', ahead: 1, behind: 0 } })
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} preferredScope="uncommitted" />)
    await screen.findByText('a.ts')
    await waitFor(() => expect(api.gitLastCommit).toHaveBeenCalledTimes(1))
    api.gitStatus!.mockResolvedValue(statusWith({ head: 'd'.repeat(40) }))
    await waitFor(() => expect(api.gitLastCommit).toHaveBeenCalledTimes(2), { timeout: 5000 })
  })

  it('while a task runs here: no Discard, and the branch menu waits', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} preferredScope="uncommitted" running />)
    await screen.findByText('a.ts')
    expect(screen.queryByRole('button', { name: 'Discard changes to src/a.ts' })).toBeNull()
    expect((screen.getByRole('button', { name: 'Switch branch' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('coming back to the window asks for a background fetch', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} preferredScope="uncommitted" />)
    await screen.findByText('a.ts')
    await waitFor(() => expect(api.gitFetch).toHaveBeenCalledTimes(1), { timeout: 5000 })
    window.dispatchEvent(new Event('focus'))
    await waitFor(() => expect(api.gitFetch).toHaveBeenCalledTimes(2))
  })

  it('a diff main cut short offers no hunk Stage', async () => {
    api.gitDiff!.mockResolvedValue({ ok: true, data: { content: `${TWO_HUNKS}\n[diff truncated]` } })
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} preferredScope="unstaged" />)
    await screen.findByText('a.ts')
    await screen.findByText('new')
    expect(screen.queryByRole('button', { name: /^Stage the hunk/ })).toBeNull()
  })
})
