/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { GitStatus } from '@shared/ipc'
import { useGitChrome, type GitChrome } from '@renderer/features/chat/components/GitChrome'
import { GitSyncControls } from '@renderer/features/chat/components/GitSyncControls'

afterEach(() => {
  cleanup()
})

function makeStatus(patch: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: 'main',
    files: [],
    truncated: false,
    fileCount: 0,
    added: 0,
    removed: 0,
    hasRemote: true,
    hasCommits: true,
    ...patch
  }
}

function makeChrome(status: GitStatus, patch: Partial<GitChrome> = {}): GitChrome {
  return {
    status,
    result: { kind: 'ok', status },
    error: null,
    ready: true,
    loading: false,
    busy: false,
    notice: null,
    noticeFailed: false,
    refresh: vi.fn(),
    commit: vi.fn(async () => false as const),
    createPr: vi.fn(async () => false as const),
    stageAll: vi.fn(async () => true),
    stagePaths: vi.fn(async () => true),
    unstagePaths: vi.fn(async () => true),
    reportNotice: vi.fn(),
    syncing: null,
    fetch: vi.fn(async () => true),
    pull: vi.fn(async () => ({ kind: 'pulled' as const, detail: 'Pulled' })),
    push: vi.fn(async () => true),
    createBranch: vi.fn(async () => true),
    ...patch
  }
}

const openMenu = (): void => {
  fireEvent.click(screen.getByRole('button', { name: /^Sync/ }))
}

describe('GitSyncControls', () => {
  it('shows ahead/behind as counts beside arrows, only for the sides that moved', () => {
    const { container, rerender } = render(
      <GitSyncControls chrome={makeChrome(makeStatus({ upstream: 'origin/main', ahead: 2, behind: 3 }))} />
    )
    const trigger = screen.getByRole('button', { name: 'Sync — 2 to push · 3 to pull' })
    expect(container.querySelector('[data-git-ahead]')?.textContent).toBe('2')
    expect(container.querySelector('[data-git-behind]')?.textContent).toBe('3')
    // Muted: the counts are context, not the thing to look at.
    expect(trigger.classList.contains('text-muted')).toBe(true)

    rerender(<GitSyncControls chrome={makeChrome(makeStatus({ upstream: 'origin/main', ahead: 1, behind: 0 }))} />)
    expect(container.querySelector('[data-git-ahead]')?.textContent).toBe('1')
    expect(container.querySelector('[data-git-behind]')).toBeNull()

    rerender(<GitSyncControls chrome={makeChrome(makeStatus({ upstream: 'origin/main', ahead: 0, behind: 0 }))} />)
    expect(screen.getByRole('button', { name: 'Sync — Up to date with origin/main' })).toBeTruthy()
    expect(container.querySelector('[data-git-ahead]')).toBeNull()
  })

  it('offers Publish branch, not Push, when the branch has no upstream', () => {
    const chrome = makeChrome(makeStatus({ branch: 'feature' }))
    render(<GitSyncControls chrome={chrome} />)
    expect(screen.getByRole('button', { name: 'Sync — Not published' })).toBeTruthy()
    openMenu()
    const labels = screen.getAllByRole('menuitem').map((item) => item.textContent ?? '')
    expect(labels.some((l) => l.startsWith('Publish branch'))).toBe(true)
    expect(labels.some((l) => l.startsWith('Push'))).toBe(false)
    const pull = screen.getAllByRole('menuitem').find((item) => item.textContent?.startsWith('Pull'))
    expect(pull?.getAttribute('aria-disabled')).toBe('true')

    fireEvent.click(screen.getByRole('menuitem', { name: /^Publish branch/ }))
    expect(chrome.push).toHaveBeenCalledTimes(1)
  })

  it('pushes and pulls through the chrome when the branch tracks an upstream', () => {
    const chrome = makeChrome(makeStatus({ upstream: 'origin/main', ahead: 1, behind: 2 }))
    render(<GitSyncControls chrome={chrome} />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /^Push/ }))
    expect(chrome.push).toHaveBeenCalledTimes(1)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /^Pull/ }))
    expect(chrome.pull).toHaveBeenCalledWith(undefined)
  })

  it('disables every remote action with no remote', () => {
    render(<GitSyncControls chrome={makeChrome(makeStatus({ hasRemote: false }))} />)
    openMenu()
    for (const name of [/^Fetch/, /^Pull/, /^Publish branch/]) {
      expect(screen.getByRole('menuitem', { name }).getAttribute('aria-disabled')).toBe('true')
    }
    expect(screen.getByRole('menuitem', { name: /^New branch/ }).getAttribute('aria-disabled')).toBeNull()
  })

  it('holds Pull and New branch while a run is live in the checkout', () => {
    render(<GitSyncControls chrome={makeChrome(makeStatus({ upstream: 'origin/main', ahead: 0, behind: 1 }))} running />)
    openMenu()
    expect(screen.getByRole('menuitem', { name: /^Pull/ }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('menuitem', { name: /^New branch/ }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('menuitem', { name: /^Fetch/ }).getAttribute('aria-disabled')).toBeNull()
    expect(screen.getByRole('menuitem', { name: /^Push/ }).getAttribute('aria-disabled')).toBeNull()
  })

  it('asks rebase or merge when a pull finds the branch diverged', async () => {
    const pull = vi.fn(async (strategy?: string) =>
      strategy
        ? { kind: 'pulled' as const, detail: 'Rebased' }
        : { kind: 'diverged' as const, detail: 'main and origin/main have diverged', ahead: 1, behind: 1, upstream: 'origin/main' }
    )
    render(<GitSyncControls chrome={makeChrome(makeStatus({ upstream: 'origin/main', ahead: 1, behind: 1 }), { pull })} />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /^Pull/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Branch has diverged' })
    expect(dialog.textContent).toContain('main and origin/main have diverged')
    fireEvent.click(screen.getByRole('button', { name: 'Rebase' }))
    await waitFor(() => expect(pull).toHaveBeenLastCalledWith('rebase'))
    expect(screen.queryByRole('dialog', { name: 'Branch has diverged' })).toBeNull()
  })

  it('names a new branch inline, validating as it is typed', async () => {
    const createBranch = vi.fn(async () => true)
    const { container } = render(<GitSyncControls chrome={makeChrome(makeStatus({ upstream: 'origin/main' }), { createBranch })} />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /^New branch/ }))
    const input = screen.getByRole('textbox', { name: 'New branch name' })
    expect(document.activeElement).toBe(input)

    fireEvent.change(input, { target: { value: 'bad name' } })
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.classList.contains('border-danger')).toBe(true)
    expect(input.classList.contains('border-border')).toBe(false)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(createBranch).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: 'feat/login' } })
    expect(input.getAttribute('aria-invalid')).toBeNull()
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(createBranch).toHaveBeenCalledWith('feat/login')
    await waitFor(() => expect(container.querySelector('[data-git-new-branch]')).toBeNull())
  })

  it('puts the menu back on Escape', () => {
    render(<GitSyncControls chrome={makeChrome(makeStatus({ upstream: 'origin/main' }))} />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /^New branch/ }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'New branch name' }), { key: 'Escape' })
    expect(screen.getByRole('button', { name: /^Sync/ })).toBeTruthy()
  })

  it('spins while a sync runs', () => {
    const { container } = render(
      <GitSyncControls chrome={makeChrome(makeStatus({ upstream: 'origin/main', ahead: 2 }), { syncing: 'push' })} />
    )
    const trigger = screen.getByRole('button', { name: /^Sync/ })
    expect(trigger.getAttribute('aria-busy')).toBe('true')
    expect(container.querySelector('[data-git-ahead]')).toBeNull()
  })
})

function SyncHarness({ beforeMutation }: { beforeMutation: () => Promise<boolean> }) {
  const chrome = useGitChrome('/ws', 1, true, undefined, beforeMutation)
  return (
    <>
      <button type="button" onClick={() => void chrome.fetch()}>
        Fetch
      </button>
      <button type="button" onClick={() => void chrome.pull('merge')}>
        Pull
      </button>
      <button type="button" onClick={() => void chrome.push()}>
        Push
      </button>
      {chrome.notice ? <span data-failed={chrome.noticeFailed ? 'yes' : 'no'}>{chrome.notice}</span> : null}
    </>
  )
}

describe('useGitChrome sync actions', () => {
  const status = makeStatus({ upstream: 'origin/main', ahead: 1, behind: 1 })
  function mockSyncApi(overrides: Record<string, unknown> = {}): Record<string, ReturnType<typeof vi.fn>> {
    const api = {
      gitStatus: vi.fn().mockResolvedValue({ ok: true, data: { kind: 'ok', status } }),
      gitFetch: vi.fn().mockResolvedValue({ ok: true, data: { detail: 'Fetched · up to date with origin/main' } }),
      gitPull: vi.fn().mockResolvedValue({
        ok: true,
        data: { kind: 'conflicted', files: 2, detail: 'Merge stopped on conflicts in 2 files.' }
      }),
      gitPush: vi.fn().mockResolvedValue({
        ok: false,
        error: 'Git could not sign in to the remote. git: fatal: Authentication failed'
      }),
      ...overrides
    } as Record<string, ReturnType<typeof vi.fn>>
    Object.defineProperty(window, 'vyotiq', { configurable: true, writable: true, value: api })
    return api
  }

  it('fetches without saving open files, and reports what it found', async () => {
    const api = mockSyncApi()
    const beforeMutation = vi.fn().mockResolvedValue(true)
    render(<SyncHarness beforeMutation={beforeMutation} />)
    fireEvent.click(screen.getByRole('button', { name: 'Fetch' }))
    await screen.findByText('Fetched · up to date with origin/main')
    expect(api.gitFetch).toHaveBeenCalledWith({ workspacePath: '/ws' })
    expect(beforeMutation).not.toHaveBeenCalled()
  })

  it('saves open files before a pull, and shows a conflicted merge as a failure', async () => {
    const api = mockSyncApi()
    const beforeMutation = vi.fn().mockResolvedValue(true)
    render(<SyncHarness beforeMutation={beforeMutation} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pull' }))
    const notice = await screen.findByText('Merge stopped on conflicts in 2 files.')
    expect(notice.getAttribute('data-failed')).toBe('yes')
    expect(api.gitPull).toHaveBeenCalledWith({ workspacePath: '/ws', strategy: 'merge' })
    expect(beforeMutation.mock.invocationCallOrder[0]).toBeLessThan(api.gitPull.mock.invocationCallOrder[0]!)
  })

  it('shows git’s own message when a push fails', async () => {
    mockSyncApi()
    render(<SyncHarness beforeMutation={vi.fn().mockResolvedValue(true)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Push' }))
    const notice = await screen.findByText(/Authentication failed/)
    expect(notice.getAttribute('data-failed')).toBe('yes')
  })
})
