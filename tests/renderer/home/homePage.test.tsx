/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { HomePage } from '@renderer/features/home/HomePage'
import type { HomeActivityResult, NotificationItem, RunSummary } from '@shared/ipc'

const ALPHA = 'C:\\repo-alpha'
const BETA = 'C:\\repo-beta'
const IN_FOUR_HOURS = new Date(Date.now() + 4 * 3_600_000).toISOString()

function run(
  runId: string,
  goal: string,
  status: RunSummary['status'],
  minutesAgo: number,
  extra: Partial<RunSummary> = {}
): RunSummary {
  return {
    runId,
    goal,
    status,
    updatedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    ...extra
  }
}

const ACTIVITY: HomeActivityResult = {
  days: [
    { date: new Date().toISOString().slice(0, 10), runs: 4, billedInputTokens: 900, outputTokens: 300 }
  ],
  activeDays: 3,
  windowDays: 7,
  outcomes: { done: 6, error: 2, cancelled: 0, running: 1 },
  attention: {
    unverifiedRuns: 1,
    topTools: [
      { name: 'apply_patch', ok: 10, failed: 4 },
      { name: 'read_file', ok: 30, failed: 0 }
    ]
  },
  totals: {
    runs: 9,
    billedInputTokens: 900_000,
    outputTokens: 340_000,
    billedCost: 4.21,
    previousTokens: 620_000
  },
  generatedAt: new Date().toISOString()
}

const handlers = {
  onNewSessionInWorkspace: vi.fn(),
  onSelectRunInWorkspace: vi.fn(),
  onSwitchWorkspace: vi.fn(),
  onAddWorkspace: vi.fn(),
  onOpenProviderSettings: vi.fn(),
  onOpenMcpServer: vi.fn(),
  onStopRunInWorkspace: vi.fn(async () => {}),
  onResumeRunInWorkspace: vi.fn(async () => {}),
  onReviewChangesInWorkspace: vi.fn(),
  onRefreshWorkspaceRuns: vi.fn(async () => {}),
  onTogglePinnedRun: vi.fn()
}

let notifications: NotificationItem[] = []
let mcpServers: Array<{
  id: string
  name: string
  enabled: boolean
  connected: boolean
  toolCount: number
  error?: string
}> = []
let homeActivity = vi.fn()

function needsYou(runId: string, workspacePath = ALPHA): NotificationItem {
  return {
    id: `n-${runId}`,
    createdAt: new Date().toISOString(),
    read: false,
    source: 'agent',
    kind: 'needs_you',
    title: 'Needs your input',
    body: 'Approve the write to src/app.ts',
    dedupeKey: `needs_you:${runId}`,
    action: { type: 'open_run', workspacePath, runId }
  }
}

function gitStatusFor(path: string) {
  const changed = path === ALPHA
  return {
    ok: true as const,
    data: {
      kind: 'ok' as const,
      status: {
        branch: changed ? 'feature/home' : 'main',
        files: changed
          ? [
              {
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
              }
            ]
          : [],
        truncated: false,
        fileCount: changed ? 1 : 0,
        added: changed ? 10 : 0,
        removed: changed ? 2 : 0,
        hasRemote: true,
        hasCommits: true,
        ahead: changed ? 1 : 0,
        behind: 0
      }
    }
  }
}

function renderHome(overrides: Partial<Parameters<typeof HomePage>[0]> = {}) {
  return render(
    <HomePage
      openWorkspaces={[ALPHA, BETA]}
      activeWorkspace={ALPHA}
      runsByWorkspacePath={{
        [ALPHA]: {
          runs: [
            run('blocked', 'Migrate the settings schema', 'running', 1),
            run('failed', 'Fix the production login redirect', 'error', 5),
            run('interrupted', 'Rewrite the export pipeline', 'cancelled', 20, {
              resumable: true
            }),
            run('unverified', 'Update the installation guide', 'done', 90),
            run('goal', 'Keep the test suite green', 'done', 120, {
              goalStatus: 'active',
              goalContinueCount: 7
            }),
            run('loop', 'Watch the nightly build', 'done', 200, {
              loopArmed: true,
              loopNextAt: IN_FOUR_HOURS
            }),
            run('idle', 'Draft the release notes', 'done', 400)
          ],
          activeRunId: null
        },
        [BETA]: {
          runs: [run('running', 'Audit authentication end to end', 'running', 2)],
          activeRunId: 'running'
        }
      }}
      activeRuns={[
        { workspacePath: BETA, runId: 'running' },
        { workspacePath: ALPHA, runId: 'blocked' }
      ]}
      workspaceHasBackgroundRun={(path) => path === BETA}
      pinnedRunKeys={[]}
      {...handlers}
      {...overrides}
    />
  )
}

beforeEach(() => {
  Object.values(handlers).forEach((handler) => handler.mockClear())
  notifications = []
  mcpServers = []
  homeActivity = vi.fn(async () => ({ ok: true as const, data: ACTIVITY }))
  window.vyotiq = {
    runStats: vi.fn(async ({ runIds }: { runIds: string[] }) => ({
      ok: true as const,
      data: {
        stats: runIds.map((runId) => ({
          runId,
          messages: 1,
          ...(runId.startsWith('unverified')
            ? { verification: { verifiedAfterLastMutation: false } }
            : {}),
          ...(runId === 'failed' ? { billedCost: 0.42 } : {})
        }))
      }
    })),
    gitStatus: vi.fn(async (path: string) => gitStatusFor(path)),
    homeActivity: (payload: unknown) => homeActivity(payload),
    mcpStatus: vi.fn(async () => ({ ok: true as const, data: { servers: mcpServers } })),
    listNotifications: vi.fn(async () => ({ ok: true as const, data: { items: notifications } })),
    onNotificationsChanged: vi.fn(() => () => {}),
    workspaceFileReveal: vi.fn(async () => ({ ok: true as const, data: {} })),
    setGoalStatus: vi.fn(async () => ({ ok: true as const, data: { goal: null } })),
    setLoop: vi.fn(async () => ({ ok: true as const, data: { loop: null } }))
  }
})

afterEach(() => {
  cleanup()
  delete (window as { vyotiq?: unknown }).vyotiq
})

describe('Home structure', () => {
  it('categorises the page and never lists a session twice', async () => {
    renderHome()
    expect(screen.getByRole('heading', { name: 'Home' })).toBeTruthy()
    expect(await screen.findByRole('region', { name: /Needs you/ })).toBeTruthy()
    expect(screen.getByRole('region', { name: /In flight/ })).toBeTruthy()
    expect(screen.getByRole('region', { name: /Repositories/ })).toBeTruthy()
    expect(await screen.findByRole('region', { name: /Activity/ })).toBeTruthy()

    // The sidebar owns session navigation — Home has no session list or search.
    expect(screen.queryByRole('region', { name: /^Sessions/ })).toBeNull()
    expect(screen.queryByRole('searchbox')).toBeNull()

    for (const title of [
      'Fix the production login redirect',
      'Migrate the settings schema',
      'Keep the test suite green'
    ]) {
      expect(screen.getAllByText(title)).toHaveLength(1)
    }
    // A session with nothing notable about it belongs to neither section.
    expect(screen.queryByText('Draft the release notes')).toBeNull()
  })

  it('keeps only the count no section heading already carries', async () => {
    notifications = [needsYou('blocked')]
    renderHome()
    // The blocked run is live, but it is counted once — under "needs you", so
    // the header reports the one running session that In flight does not.
    expect(await screen.findByText('1 running')).toBeTruthy()
    // Workspace and attention totals live in their own headings now.
    expect(screen.queryByText(/2 workspaces/)).toBeNull()
    expect(screen.queryByText(/needs you$/)).toBeNull()
  })

  it('puts the blocking environment condition above the sessions', async () => {
    mcpServers = [
      { id: 'files', name: 'Filesystem', enabled: true, connected: false, toolCount: 0 }
    ]
    renderHome()
    const environment = await screen.findByRole('region', { name: /Environment/ })
    const attention = screen.getByRole('region', { name: /Needs you/ })
    // Nothing can run without a provider or a server, so it cannot render last:
    // below the fold is exactly where it was invisible.
    expect(
      environment.compareDocumentPosition(attention) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })
})

describe('Needs you', () => {
  it('ranks a blocked run first and labels each attention state', async () => {
    notifications = [needsYou('blocked')]
    renderHome()
    const section = within(await screen.findByRole('region', { name: /Needs you/ }))
    expect(await section.findByText('Waiting on you')).toBeTruthy()
    expect(section.getByText('Failed')).toBeTruthy()
    expect(section.getByText('Interrupted')).toBeTruthy()
    expect(await section.findByText('Unverified edits')).toBeTruthy()

    const rows = section.getAllByRole('listitem')
    expect(rows[0]!.textContent).toContain('Migrate the settings schema')
    expect(rows[1]!.textContent).toContain('Fix the production login redirect')
  })

  it('states each condition once and folds a long tail of one state', async () => {
    renderHome({
      openWorkspaces: [ALPHA],
      activeRuns: [],
      runsByWorkspacePath: {
        [ALPHA]: {
          runs: Array.from({ length: 5 }, (_, index) =>
            run(`unverified-${index}`, `Redesign pass ${index + 1}`, 'done', index + 1)
          ),
          activeRunId: null
        }
      }
    })
    const section = within(await screen.findByRole('region', { name: /Needs you/ }))
    // One header explains the state; the rows under it are its instances.
    expect(
      await section.findByText(
        'Files changed after the last check ran, so nothing has re-verified them.'
      )
    ).toBeTruthy()
    expect(section.getAllByText('Unverified edits')).toHaveLength(1)

    const lane = within(section.getByRole('group', { name: 'Unverified edits, 5' }))
    expect(lane.getAllByRole('listitem')).toHaveLength(3)
    fireEvent.click(lane.getByRole('button', { name: 'Show 2 more' }))
    expect(lane.getAllByRole('listitem')).toHaveLength(5)
    fireEvent.click(lane.getByRole('button', { name: 'Show fewer' }))
    expect(lane.getAllByRole('listitem')).toHaveLength(3)
  })

  it('opens a session from its title', async () => {
    renderHome()
    const section = within(await screen.findByRole('region', { name: /Needs you/ }))
    fireEvent.click(section.getByRole('button', { name: /^Open Fix the production login redirect/ }))
    expect(handlers.onSelectRunInWorkspace).toHaveBeenCalledWith(ALPHA, 'failed')
  })

  it('offers Review changes only for unverified edits', async () => {
    renderHome()
    const section = within(await screen.findByRole('region', { name: /Needs you/ }))
    const review = await section.findByRole('button', {
      name: 'Review changes Update the installation guide'
    })
    fireEvent.click(review)
    expect(handlers.onReviewChangesInWorkspace).toHaveBeenCalledWith(ALPHA, 'unverified')
    expect(section.getAllByRole('button', { name: /^Review changes / })).toHaveLength(1)
  })

  it('offers Resume on the state whose header says it can be resumed', async () => {
    renderHome()
    const section = within(await screen.findByRole('region', { name: /Needs you/ }))
    const resume = await section.findByRole('button', {
      name: 'Resume Rewrite the export pipeline'
    })
    fireEvent.click(resume)
    await waitFor(() =>
      expect(handlers.onResumeRunInWorkspace).toHaveBeenCalledWith(ALPHA, 'interrupted')
    )
    // A failed run is not resumable, so it gets no button it cannot honour.
    expect(section.getAllByRole('button', { name: /^Resume / })).toHaveLength(1)
  })
})

describe('In flight', () => {
  it('shows live runs with Stop, and standing goals and loops with their real markers', async () => {
    renderHome()
    const section = within(await screen.findByRole('region', { name: /In flight/ }))

    // Two runs are executing; the goal and the loop are standing work.
    expect(section.getAllByText('Running')).toHaveLength(2)
    expect(section.getByText('Goal ×7')).toBeTruthy()
    expect(section.getByText('Loop in 4h')).toBeTruthy()

    // Stop belongs to the live runs only, and names the session it stops.
    expect(section.getAllByRole('button', { name: /^Stop (?!loop)/ })).toHaveLength(2)
    fireEvent.click(section.getByRole('button', { name: 'Stop Audit authentication end to end' }))
    await waitFor(() => expect(handlers.onStopRunInWorkspace).toHaveBeenCalledWith(BETA, 'running'))
  })

  it('calls off a standing goal from its own row', async () => {
    renderHome()
    const section = within(await screen.findByRole('region', { name: /In flight/ }))
    // The goal row is not running, so pausing it must not also stop a run.
    fireEvent.click(section.getByRole('button', { name: 'Pause goal Keep the test suite green' }))
    await waitFor(() =>
      expect(window.vyotiq.setGoalStatus).toHaveBeenCalledWith({
        workspacePath: ALPHA,
        runId: 'goal',
        action: 'pause'
      })
    )
    expect(handlers.onStopRunInWorkspace).not.toHaveBeenCalled()
    // Only the rows that actually carry the standing work offer to end it.
    expect(section.getAllByRole('button', { name: /^Pause goal / })).toHaveLength(1)
  })

  it('disarms a loop from its own row', async () => {
    renderHome()
    const section = within(await screen.findByRole('region', { name: /In flight/ }))
    fireEvent.click(section.getByRole('button', { name: 'Stop loop Watch the nightly build' }))
    await waitFor(() =>
      expect(window.vyotiq.setLoop).toHaveBeenCalledWith({
        workspacePath: ALPHA,
        runId: 'loop',
        action: 'stop'
      })
    )
    expect(section.getAllByRole('button', { name: /^Stop loop / })).toHaveLength(1)
  })

  it('says a loop is armed when no next tick was recorded', async () => {
    renderHome({
      openWorkspaces: [ALPHA],
      activeRuns: [],
      runsByWorkspacePath: {
        [ALPHA]: {
          runs: [run('loop', 'Watch the nightly build', 'done', 10, { loopArmed: true })],
          activeRunId: null
        }
      }
    })
    const section = within(await screen.findByRole('region', { name: /In flight/ }))
    expect(section.getByText('Loop armed')).toBeTruthy()
  })
})

describe('Pinned', () => {
  it('lists starred sessions no other section claimed', async () => {
    renderHome({ pinnedRunKeys: [`${ALPHA}\u0000idle`, `${BETA}\u0000running`] })
    const section = within(await screen.findByRole('region', { name: /Pinned/ }))
    expect(section.getByText('Draft the release notes')).toBeTruthy()
    // The pinned live run is already shown under In flight.
    expect(section.queryByText('Audit authentication end to end')).toBeNull()
  })

  it('toggles a pin from any session row', async () => {
    renderHome()
    const section = within(await screen.findByRole('region', { name: /Needs you/ }))
    fireEvent.click(section.getByRole('button', { name: 'Pin Fix the production login redirect' }))
    expect(handlers.onTogglePinnedRun).toHaveBeenCalledWith(`${ALPHA}\u0000failed`)
  })

  it('hides the section when nothing is pinned', () => {
    renderHome()
    expect(screen.queryByRole('region', { name: /Pinned/ })).toBeNull()
  })
})

describe('Repositories', () => {
  it('leads with repository state and routes the per-repo actions', async () => {
    renderHome()
    const section = within(screen.getByRole('region', { name: /Repositories/ }))
    expect(await section.findByText('feature/home')).toBeTruthy()
    expect(section.getByText('1 changed')).toBeTruthy()
    expect(section.getByText('↑1 ↓0')).toBeTruthy()
    expect(section.getByText('Clean')).toBeTruthy()
    // Session counts belong to the sidebar, not here.
    expect(section.queryByText(/session/)).toBeNull()

    fireEvent.click(section.getByText('src/home.tsx'))
    expect(window.vyotiq.workspaceFileReveal).toHaveBeenCalledWith({
      workspacePath: ALPHA,
      path: 'src/home.tsx'
    })

    fireEvent.click(section.getByRole('button', { name: 'Review changes' }))
    expect(handlers.onReviewChangesInWorkspace).toHaveBeenCalledWith(ALPHA)

    fireEvent.click(section.getAllByRole('button', { name: /New chat/ })[0]!)
    expect(handlers.onNewSessionInWorkspace).toHaveBeenCalledWith(ALPHA, '')

    fireEvent.click(section.getByRole('button', { name: 'repo-alpha' }))
    expect(handlers.onSwitchWorkspace).toHaveBeenCalledWith(ALPHA)
  })

  it('offers the hidden tail beyond the three preview chips', async () => {
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts'].map((name, index) => ({
      path: `src/${name}`,
      status: 'modified' as const,
      added: 12 - index,
      removed: 0,
      addedStaged: 0,
      removedStaged: 0,
      addedUnstaged: 12 - index,
      removedUnstaged: 0,
      binary: false,
      staged: false,
      unstaged: true
    }))
    const bridge = window.vyotiq as unknown as {
      gitStatus: (path: string) => Promise<unknown>
    }
    bridge.gitStatus = vi.fn(async (path: string) =>
      path === ALPHA
        ? {
            ok: true as const,
            data: {
              kind: 'ok' as const,
              status: {
                branch: 'feature/home',
                files,
                truncated: false,
                fileCount: files.length,
                added: 42,
                removed: 0,
                hasRemote: true,
                hasCommits: true
              }
            }
          }
        : gitStatusFor(path)
    )

    renderHome()
    const section = within(await screen.findByRole('region', { name: /Repositories/ }))
    expect(await section.findByText('4 changed')).toBeTruthy()
    // Three preview chips plus one honest tail instead of silent truncation.
    expect(section.getByText('+1 more')).toBeTruthy()
    fireEvent.click(section.getByText('+1 more'))
    expect(handlers.onReviewChangesInWorkspace).toHaveBeenCalledWith(ALPHA)
  })
})

describe('Activity', () => {
  it('renders totals, the trend, the day axis and tool failures from the receipt aggregate', async () => {
    renderHome()
    const section = within(await screen.findByRole('region', { name: /Activity/ }))
    expect(await section.findByText('9')).toBeTruthy()
    expect(section.getByText('1.2M')).toBeTruthy()
    expect(section.getByText('+100% vs previous')).toBeTruthy()
    expect(section.getByText('$4.21')).toBeTruthy()
    expect(section.getByText('3 of 7')).toBeTruthy()
    expect(section.getByRole('img', { name: /Sessions per day over the last 7 days/ })).toBeTruthy()
    expect(section.getByText('Completed')).toBeTruthy()
    expect(section.getByText('apply_patch')).toBeTruthy()
    expect(section.getByText('4 of 14')).toBeTruthy()
    // A tool that never failed is not a failure row.
    expect(section.queryByText('read_file')).toBeNull()
  })

  it('refetches the aggregate for the selected window', async () => {
    renderHome()
    await waitFor(() =>
      expect(homeActivity).toHaveBeenCalledWith({
        workspacePaths: [ALPHA, BETA],
        windowDays: 7
      })
    )
    fireEvent.click(screen.getByRole('button', { name: '30d' }))
    await waitFor(() =>
      expect(homeActivity).toHaveBeenCalledWith({
        workspacePaths: [ALPHA, BETA],
        windowDays: 30
      })
    )
  })

  it('shows an absence rather than zeros when the window holds no sessions', async () => {
    homeActivity = vi.fn(async () => ({
      ok: true as const,
      data: {
        ...ACTIVITY,
        days: [],
        activeDays: 0,
        outcomes: { done: 0, error: 0, cancelled: 0, running: 0 },
        totals: { runs: 0, billedInputTokens: 0, outputTokens: 0 }
      }
    }))
    renderHome()
    expect(await screen.findByText('No sessions recorded in the last 7 days.')).toBeTruthy()
  })

  it('reports a cost of "—" when no provider billed the window', async () => {
    homeActivity = vi.fn(async () => ({
      ok: true as const,
      data: { ...ACTIVITY, totals: { runs: 3, billedInputTokens: 10, outputTokens: 4 } }
    }))
    renderHome()
    const section = within(await screen.findByRole('region', { name: /Activity/ }))
    expect(await section.findByText('—')).toBeTruthy()
  })

  it('surfaces a failed read with a retry instead of an empty chart', async () => {
    homeActivity = vi.fn(async () => ({ ok: false as const, error: 'receipt read failed' }))
    renderHome()
    const retry = await screen.findByRole('button', { name: 'Retry' })
    fireEvent.click(retry)
    await waitFor(() => expect(homeActivity).toHaveBeenCalledTimes(2))
  })
})

describe('Environment', () => {
  it('stays hidden while the environment is healthy', async () => {
    renderHome()
    await screen.findByRole('region', { name: /Activity/ })
    expect(screen.queryByRole('region', { name: /Environment/ })).toBeNull()
  })

  it('reports a provider with no key and routes to its settings', async () => {
    renderHome({ providerIssue: { label: 'OpenAI' } })
    const section = within(await screen.findByRole('region', { name: /Environment/ }))
    expect(section.getByText('OpenAI has no API key')).toBeTruthy()
    fireEvent.click(section.getByRole('button', { name: 'Add key' }))
    expect(handlers.onOpenProviderSettings).toHaveBeenCalled()
  })

  it('reports a disconnected MCP server with its own error and opens that server', async () => {
    mcpServers = [
      { id: 'github', name: 'GitHub', enabled: true, connected: false, toolCount: 0, error: 'spawn failed' },
      { id: 'fs', name: 'Filesystem', enabled: true, connected: true, toolCount: 9 },
      { id: 'off', name: 'Disabled one', enabled: false, connected: false, toolCount: 0 }
    ]
    renderHome()
    const section = within(await screen.findByRole('region', { name: /Environment/ }))
    expect(section.getByText('GitHub is not connected')).toBeTruthy()
    expect(section.getByText('spawn failed')).toBeTruthy()
    // Connected and disabled servers are not problems.
    expect(section.queryByText(/Filesystem/)).toBeNull()
    expect(section.queryByText(/Disabled one/)).toBeNull()

    fireEvent.click(section.getByRole('button', { name: 'Manage' }))
    expect(handlers.onOpenMcpServer).toHaveBeenCalledWith('github')
  })
})

describe('Home refresh and empty state', () => {
  it('refreshes runs and every asynchronous panel', async () => {
    renderHome()
    await screen.findByRole('region', { name: /Activity/ })
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }))
    await waitFor(() => expect(handlers.onRefreshWorkspaceRuns).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(homeActivity.mock.calls.length).toBeGreaterThan(1))
    expect(await screen.findByText('Home updated', { selector: '.sr-only' })).toBeTruthy()
  })

  it('asks for a workspace before showing any panel', () => {
    renderHome({ openWorkspaces: [], runsByWorkspacePath: {}, activeRuns: [] })
    expect(screen.getByRole('heading', { name: 'Open a workspace' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: /Activity/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add workspace' }))
    expect(handlers.onAddWorkspace).toHaveBeenCalled()
  })
})
