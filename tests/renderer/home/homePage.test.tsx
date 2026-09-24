/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { HomePage } from '@renderer/features/home/HomePage'
import type { ActiveRun, HomeActivityResult, RunSummary } from '@shared/ipc'

const ALPHA = 'C:\\repo-alpha'
const BETA = 'C:\\repo-beta'

function run(runId: string, goal: string, status: RunSummary['status']): RunSummary {
  return { runId, goal, status, updatedAt: new Date().toISOString() }
}

function live(runId: string, workspacePath: string, waiting?: ActiveRun['waiting']): ActiveRun {
  return { runId, workspacePath, invokeId: 1, pendingFollowUps: [], ...(waiting ? { waiting } : {}) }
}

const today = new Date()
const dayKey = (offset: number): string => {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const ACTIVITY: HomeActivityResult = {
  days: [
    { date: dayKey(0), runs: 4, billedInputTokens: 900_000, outputTokens: 300_000 },
    { date: dayKey(2), runs: 2, billedInputTokens: 0, outputTokens: 40_000 }
  ],
  activeDays: 2,
  windowDays: 7,
  outcomes: { done: 6, error: 2, cancelled: 0, running: 1 },
  totals: { runs: 9, billedInputTokens: 900_000, outputTokens: 340_000, billedCost: 4.21 },
  generatedAt: new Date().toISOString()
}

const handlers = {
  onStartTask: vi.fn(),
  onNewTaskInWorkspace: vi.fn(),
  onOpenTask: vi.fn(),
  onOpenWorkspace: vi.fn(),
  onAddWorkspace: vi.fn(),
  onRespondApproval: vi.fn(async () => {}),
  onOpenProviderSettings: vi.fn(),
  onOpenMcpServer: vi.fn(),
  onReviewChangesInWorkspace: vi.fn(),
  onOpenUsage: vi.fn()
}

let mcpServers: Array<Record<string, unknown>> = []
let indexStatus: { phase: string; workspacePath?: string } = { phase: 'ready' }

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
        ahead: changed ? 3 : 0,
        behind: 0
      }
    }
  }
}

const TWO_MINUTES_AGO = new Date(Date.now() - 2 * 60_000).toISOString()

function renderHome(overrides: Partial<Parameters<typeof HomePage>[0]> = {}) {
  return render(
    <HomePage
      openWorkspaces={[ALPHA, BETA]}
      activeWorkspace={ALPHA}
      runsByWorkspacePath={{
        [ALPHA]: {
          runs: [run('approve', 'Add backpressure to the chat stream', 'running'), run('ask', 'Pick the release branch', 'running')],
          activeRunId: null
        },
        [BETA]: { runs: [run('busy', 'Audit authentication end to end', 'running')], activeRunId: null }
      }}
      activeRuns={[
        live('approve', ALPHA, { kind: 'approval', since: TWO_MINUTES_AGO }),
        live('ask', ALPHA, { kind: 'question', since: new Date().toISOString() }),
        live('busy', BETA)
      ]}
      {...handlers}
      {...overrides}
    />
  )
}

beforeEach(() => {
  Object.values(handlers).forEach((handler) => handler.mockClear())
  mcpServers = []
  indexStatus = { phase: 'ready' }
  window.vyotiq = {
    gitStatus: vi.fn(async (path: string) => gitStatusFor(path)),
    homeActivity: vi.fn(async () => ({ ok: true as const, data: ACTIVITY })),
    mcpStatus: vi.fn(async () => ({ ok: true as const, data: { servers: mcpServers } })),
    mcpRefresh: vi.fn(async () => ({ ok: true as const, data: { servers: [] } })),
    codeIndexStatus: vi.fn(async () => ({
      ok: true as const,
      data: { ...indexStatus, progress: null, message: null, error: null, indexProgress: null, settings: {} }
    })),
    onCodeIndexStatus: vi.fn(() => () => {}),
    listPendingToolApprovals: vi.fn(async (runId: string) => ({
      ok: true as const,
      data:
        runId === 'approve'
          ? [
              {
                requestId: 'req-1',
                runId,
                toolCallId: 'call-1',
                name: 'terminal',
                summary: 'pnpm vitest run',
                argsPreview: JSON.stringify({ command: 'pnpm vitest run tests/renderer/chatStreamController.test.ts' }),
                mutating: true
              }
            ]
          : []
    })),
    listPendingAgentQuestions: vi.fn(async (runId: string) => ({
      ok: true as const,
      data:
        runId === 'ask'
          ? [
              {
                requestId: 'q-1',
                runId,
                toolCallId: 'call-2',
                questions: [{ id: 'branch', prompt: 'Which branch should the release cut from?', type: 'text' }]
              }
            ]
          : []
    }))
  } as unknown as typeof window.vyotiq
})

afterEach(() => cleanup())

const needsYou = (): HTMLElement => screen.getByRole('region', { name: 'Needs you' })

describe('Home', () => {
  it('asks what the agent should do, and starts the task in the chosen workspace', async () => {
    renderHome()
    expect(screen.getByRole('heading', { name: 'What should the agent do?', level: 1 })).toBeTruthy()
    const field = screen.getByRole('textbox', { name: 'New task' })
    const start = screen.getByRole('button', { name: 'Start' })
    expect(start.hasAttribute('disabled')).toBe(true)

    fireEvent.change(field, { target: { value: 'Fix the flaky updater test' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(handlers.onStartTask).toHaveBeenCalledWith(ALPHA, 'Fix the flaky updater test')
    expect((field as HTMLInputElement).value).toBe('')

    // Another workspace, then Start.
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }))
    fireEvent.click(await screen.findByRole('option', { name: 'repo-beta' }))
    fireEvent.change(field, { target: { value: 'Audit the session store' } })
    fireEvent.click(start)
    expect(handlers.onStartTask).toHaveBeenLastCalledWith(BETA, 'Audit the session store')
  })

  it('answers an approval in place: Deny and Allow once go to the run', async () => {
    renderHome()
    const row = (await within(needsYou()).findByText('Add backpressure to the chat stream')).closest('li') as HTMLElement
    await waitFor(() => expect(row.textContent).toContain('Wants to run pnpm vitest run tests/renderer/chatStreamController.test.ts'))
    expect(row.textContent).toContain('· 2m')
    expect(within(row).getByRole('img', { name: 'Needs you' })).toBeTruthy()

    fireEvent.click(within(row).getByRole('button', { name: 'Allow once' }))
    await waitFor(() => expect(handlers.onRespondApproval).toHaveBeenCalledWith(ALPHA, 'approve', 'req-1', 'once'))
    // Taken: both answers wait for main instead of sending twice.
    expect(within(row).getByRole('button', { name: 'Deny' }).hasAttribute('disabled')).toBe(true)

    fireEvent.click(within(row).getByRole('button', { name: 'Open Add backpressure to the chat stream' }))
    expect(handlers.onOpenTask).toHaveBeenCalledWith(ALPHA, 'approve')
  })

  it('says what a question asks, and Answer opens its task', async () => {
    renderHome()
    const row = (await within(needsYou()).findByText('Pick the release branch')).closest('li') as HTMLElement
    await waitFor(() => expect(row.textContent).toContain('Asks: Which branch should the release cut from?'))
    fireEvent.click(within(row).getByRole('button', { name: 'Answer' }))
    expect(handlers.onOpenTask).toHaveBeenCalledWith(ALPHA, 'ask')
  })

  it('shows a failed answer on the row instead of losing it', async () => {
    handlers.onRespondApproval.mockRejectedValueOnce(new Error('The run already moved on.'))
    renderHome()
    const row = (await within(needsYou()).findByText('Add backpressure to the chat stream')).closest('li') as HTMLElement
    await waitFor(() => expect(within(row).getByRole('button', { name: 'Deny' })).toBeTruthy())
    await waitFor(() => expect(row.textContent).toContain('Wants to run'))
    fireEvent.click(within(row).getByRole('button', { name: 'Deny' }))
    expect((await within(row).findByRole('alert')).textContent).toBe('The run already moved on.')
    expect(within(row).getByRole('button', { name: 'Deny' }).hasAttribute('disabled')).toBe(false)
  })

  it('lists what stops any task from running under the waiting tasks', async () => {
    mcpServers = [
      { id: 'github', name: 'GitHub', enabled: true, connected: false, toolCount: 0, error: 'Unauthorized', errorKind: 'sign-in' },
      { id: 'linear', name: 'Linear', enabled: true, connected: false, toolCount: 0, error: 'ECONNREFUSED', errorKind: 'network' }
    ]
    renderHome({ providerIssue: { label: 'OpenAI' } })
    const region = needsYou()
    expect(within(region).getByText('OpenAI has no API key')).toBeTruthy()
    fireEvent.click(within(region).getByRole('button', { name: 'Add key' }))
    expect(handlers.onOpenProviderSettings).toHaveBeenCalledTimes(1)

    fireEvent.click(await within(region).findByRole('button', { name: 'Sign in' }))
    expect(handlers.onOpenMcpServer).toHaveBeenCalledWith('github')
    expect(within(region).getByText('The GitHub MCP is installed but not connected')).toBeTruthy()

    fireEvent.click(within(region).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(window.vyotiq.mcpRefresh).toHaveBeenCalledWith({ workspacePath: ALPHA }))
  })

  it('says so when nothing is waiting', () => {
    renderHome({ activeRuns: [] })
    expect(needsYou().textContent).toContain('Nothing is waiting on you.')
  })

  it('shows each workspace as git sees it, with what runs there now', async () => {
    indexStatus = { phase: 'syncing', workspacePath: BETA }
    renderHome()
    const region = screen.getByRole('region', { name: 'Workspaces' })
    const alpha = (await within(region).findByRole('button', { name: 'repo-alpha' })).closest('li') as HTMLElement
    await waitFor(() => expect(alpha.textContent).toContain('feature/home'))
    expect(alpha.textContent).toContain('1 changed')
    expect(alpha.textContent).toContain('3 ahead')
    expect(alpha.textContent).not.toContain('indexing')
    // A task parked on you is not "running": alpha has two waiting and none working.
    expect(within(alpha).queryByTitle(/running/)).toBeNull()

    const beta = within(region).getByRole('button', { name: 'repo-beta' }).closest('li') as HTMLElement
    await waitFor(() => expect(beta.textContent).toContain('clean'))
    await waitFor(() => expect(beta.textContent).toContain('· indexing'))
    expect(within(beta).getByTitle('1 running').textContent).toBe('1')

    fireEvent.click(within(alpha).getByRole('button', { name: '1 changed' }))
    expect(handlers.onReviewChangesInWorkspace).toHaveBeenCalledWith(ALPHA)
    fireEvent.click(within(beta).getByRole('button', { name: 'New task in repo-beta' }))
    expect(handlers.onNewTaskInWorkspace).toHaveBeenCalledWith(BETA)
    fireEvent.click(within(beta).getByRole('button', { name: 'repo-beta' }))
    expect(handlers.onOpenWorkspace).toHaveBeenCalledWith(BETA)
    fireEvent.click(within(region).getByRole('button', { name: 'Add' }))
    expect(handlers.onAddWorkspace).toHaveBeenCalledTimes(1)
  })

  it('sums the week from the receipts, with a bar per day', async () => {
    renderHome()
    const region = screen.getByRole('region', { name: 'This week' })
    await waitFor(() => expect(region.textContent).toContain('9tasks'))
    expect(region.textContent).toContain('$4.21spent')
    expect(region.textContent).toContain('1.2Mtokens')
    // Six done of eight that ended; the running one has not ended.
    expect(region.textContent).toContain('75%finished')
    const bars = within(region).getByRole('img', { name: /^Tasks per day/ })
    expect(bars.querySelectorAll('span.w-full.rounded-\\[2px\\]').length).toBe(7)
    fireEvent.click(within(region).getByRole('button', { name: 'Usage' }))
    expect(handlers.onOpenUsage).toHaveBeenCalledTimes(1)
  })

  it('offers to open a workspace when none is open', () => {
    renderHome({ openWorkspaces: [], activeRuns: [], runsByWorkspacePath: {} })
    expect(screen.getByText('No workspace yet')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'New task' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open a workspace…' }))
    expect(handlers.onAddWorkspace).toHaveBeenCalledTimes(1)
  })
})
