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
