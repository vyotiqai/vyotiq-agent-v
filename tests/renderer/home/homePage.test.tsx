/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { HomePage } from '@renderer/features/home/HomePage'
import type { RunSummary } from '@shared/ipc'

const ALPHA = 'C:\\repo-alpha'
const BETA = 'C:\\repo-beta'

function run(runId: string, goal: string, status: RunSummary['status'], minutesAgo: number, extra: Partial<RunSummary> = {}): RunSummary {
  return {
    runId,
    goal,
    status,
    updatedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    ...extra
  }
}

const handlers = {
  onNewSessionInWorkspace: vi.fn(),
  onSelectRunInWorkspace: vi.fn(),
  onSwitchWorkspace: vi.fn(),
  onAddWorkspace: vi.fn(),
  onRenameRunInWorkspace: vi.fn(),
  onDeleteRunInWorkspace: vi.fn(),
  onExportRunInWorkspace: vi.fn(),
  onStopRunInWorkspace: vi.fn(async () => {}),
  onReviewChangesInWorkspace: vi.fn(),
  onRefreshWorkspaceRuns: vi.fn(async () => {}),
  onTogglePinnedRun: vi.fn()
}

function renderHome(overrides: Partial<Parameters<typeof HomePage>[0]> = {}) {
  return render(
    <HomePage
      openWorkspaces={[ALPHA, BETA]}
      runsByWorkspacePath={{
        [ALPHA]: {
          runs: [
            run('failed', 'Fix the production login redirect', 'error', 5),
            run('done', 'Update the installation guide', 'done', 90)
          ],
          activeRunId: null
        },
        [BETA]: {
          runs: [run('running', 'Audit authentication end to end', 'running', 2)],
          activeRunId: 'running'
        }
      }}
      activeRuns={[{ workspacePath: BETA, runId: 'running' }]}
      workspaceHasBackgroundRun={(path) => path === BETA}
      pinnedRunKeys={[]}
      {...handlers}
      {...overrides}
    />
  )
}

beforeEach(() => {
  Object.values(handlers).forEach((handler) => handler.mockClear())
  // @ts-expect-error test bridge
  window.vyotiq = {
    runStats: vi.fn(async ({ runIds }: { runIds: string[] }) => ({
      ok: true as const,
      data: {
        stats: runIds.map((runId) => ({
          runId,
          messages: 1,
          ...(runId === 'done'
            ? { verification: { verifiedAfterLastMutation: false } }
            : {})
        }))
      }
    })),
    gitStatus: vi.fn(async (path: string) => ({
      ok: true as const,
      data: {
        kind: 'ok' as const,
        status: {
          branch: path === ALPHA ? 'feature/home' : 'main',
          files: path === ALPHA ? [{
            path: 'src/home.tsx',
            status: 'modified' as const,
            added: 10,
            removed: 2,
            addedStaged: 0,
            removedStaged: 0,
            addedUnstaged: 10,
            removedUnstaged: 2,
            binary: false,
            staged: false,
            unstaged: true
          }] : [],
          truncated: false,
          fileCount: path === ALPHA ? 1 : 0,
          added: path === ALPHA ? 10 : 0,
          removed: path === ALPHA ? 2 : 0,
          hasRemote: true,
          hasCommits: true,
          ahead: 0,
          behind: 0
        }
      }
    })),
    workspaceFileReveal: vi.fn(async () => ({ ok: true as const, data: {} }))
  }
})

afterEach(() => {
  delete (window as { vyotiq?: unknown }).vyotiq
})

describe('Home command center', () => {
  it('renders one canonical session list without duplicated sections or analytics clutter', async () => {
    renderHome()
    expect(screen.getByRole('heading', { name: 'Home' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Needs attention' })).toBeNull()
    expect(screen.getByRole('region', { name: 'Running now' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Workspaces' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Sessions' })).toBeTruthy()
    // The failed session exists exactly once — no attention/recent duplication.
    expect(screen.getAllByText('Fix the production login redirect')).toHaveLength(1)
    expect(screen.queryByText(/billed tokens/i)).toBeNull()
    expect(screen.queryByText(/cache hit/i)).toBeNull()
    expect(screen.queryByText(/compact/i)).toBeNull()
    expect(screen.queryByText(/tools/i)).toBeNull()
  })

  it('marks failed and unverified sessions and exposes review through the row menu', async () => {
    renderHome()
    const sessions = within(screen.getByRole('region', { name: 'Sessions' }))
    expect(sessions.getByText('Failed')).toBeTruthy()
    // Verification state arrives with the async receipt stats.
    expect(await sessions.findByText('Needs review')).toBeTruthy()

    fireEvent.click(sessions.getByRole('button', { name: /^Open Fix the production login redirect/ }))
    expect(handlers.onSelectRunInWorkspace).toHaveBeenCalledWith(ALPHA, 'failed')

    fireEvent.click(sessions.getByRole('button', { name: 'More actions for Fix the production login redirect' }))
    const menu = await screen.findByRole('menu')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Review changes' }))
    expect(handlers.onReviewChangesInWorkspace).toHaveBeenCalledWith(ALPHA, 'failed')
  })

  it('filters the single session list to items needing review and back', async () => {
    const failures = Array.from({ length: 7 }, (_, index) =>
      run(`failed-${index}`, `Failed session ${index}`, 'error', index + 1)
    )
    // @ts-expect-error test bridge
    window.vyotiq.runStats = vi.fn(async ({ runIds }: { runIds: string[] }) => ({
      ok: true as const,
      data: {
        stats: runIds.map((runId) => ({
          runId,
          messages: 1,
          verification: { verifiedAfterLastMutation: true }
        }))
      }
    }))
    renderHome({
      openWorkspaces: [ALPHA],
      activeRuns: [],
      runsByWorkspacePath: {
        [ALPHA]: {
          runs: [...failures, run('done', 'Update the installation guide', 'done', 90)],
          activeRunId: null
        }
      }
    })

    const sessions = within(screen.getByRole('region', { name: 'Sessions' }))
    fireEvent.click(sessions.getByRole('button', { name: 'Needs review · 7' }))
    expect(sessions.getAllByText('Failed')).toHaveLength(7)
    expect(sessions.queryByText('Update the installation guide')).toBeNull()

    fireEvent.click(sessions.getByRole('button', { name: 'All' }))
    expect(sessions.getByText('Update the installation guide')).toBeTruthy()
  })

  it('stops a live run from Running now', async () => {
    renderHome()
    const running = within(screen.getByRole('region', { name: 'Running now' }))
    fireEvent.click(running.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(handlers.onStopRunInWorkspace).toHaveBeenCalledWith(BETA, 'running'))
  })

  it('shows actionable repository state and workspace controls', async () => {
    renderHome()
    const workspaces = within(screen.getByRole('region', { name: 'Workspaces' }))
    expect(await workspaces.findByText('feature/home')).toBeTruthy()
    expect(workspaces.getByText('1 changed')).toBeTruthy()
    expect(workspaces.getByText('src/home.tsx')).toBeTruthy()
    fireEvent.click(workspaces.getAllByRole('button', { name: 'New chat' })[0]!)
    expect(handlers.onNewSessionInWorkspace).toHaveBeenCalledWith(ALPHA, '')
    fireEvent.click(workspaces.getByRole('button', { name: 'repo-alpha' }))
    expect(handlers.onSwitchWorkspace).toHaveBeenCalledWith(ALPHA)
  })

  it('filters the session list by title and clears with Escape', () => {
    renderHome()
    const filter = screen.getByRole('searchbox', { name: 'Filter sessions' })
    fireEvent.change(filter, { target: { value: 'installation' } })
    const sessions = within(screen.getByRole('region', { name: 'Sessions' }))
    expect(sessions.getByText('Update the installation guide')).toBeTruthy()
    expect(sessions.queryByText('Fix the production login redirect')).toBeNull()
    fireEvent.keyDown(filter, { key: 'Escape' })
    expect((filter as HTMLInputElement).value).toBe('')
  })

  it('keeps management actions in an accessible overflow menu', async () => {
    renderHome()
    // The failed row's workspace has changes, so its menu carries Review changes.
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Fix the production login redirect' }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: 'Pin' })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: 'Rename' })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: 'Review changes' })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: 'Export' })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: 'Delete' })).toBeTruthy()
  })

  it('refreshes workspaces and asynchronous Home data', async () => {
    renderHome()
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }))
    await waitFor(() => expect(handlers.onRefreshWorkspaceRuns).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('Home updated', { selector: '.sr-only' })).toBeTruthy()
  })

  it('renders a focused workspace empty state', () => {
    renderHome({ openWorkspaces: [], runsByWorkspacePath: {}, activeRuns: [] })
    expect(screen.getByRole('heading', { name: 'Open a workspace' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add workspace' }))
    expect(handlers.onAddWorkspace).toHaveBeenCalled()
  })
})
