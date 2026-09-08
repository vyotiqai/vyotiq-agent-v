/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { EffectiveChatSettings } from '@shared/effectiveSettings'
import type { ProviderId, SecretProvider } from '@shared/ipc'
import { HomePage } from '@renderer/features/home/HomePage'
import { prunePinnedRun, togglePinnedRun } from '@renderer/features/home/pinnedRuns'
import type { RunSummary } from '@shared/ipc'

// The hero composer is stubbed: HomePage tests cover the page's wiring (send
// routing, draft routing, workspace targeting), not the composer internals,
// which have their own suites under tests/renderer/chat.
const composerState = vi.hoisted(() => ({
  props: {} as Record<string, unknown>
}))

vi.mock('@renderer/features/chat/components/composer', () => ({
  Composer: function ComposerStub(props: {
    workspacePath?: string | null
    onSend?: (
      text: string,
      images?: string[],
      files?: unknown,
      extras?: unknown
    ) => unknown
    onDraftChange?: (draft: string) => void
  }) {
    composerState.props = props as Record<string, unknown>
    return (
      <div data-testid="composer-stub">
        <button
          type="button"
          aria-label="Composer send"
          onClick={() => {
            void props.onSend?.('  Fix the flaky pty test  ', ['img-1'], undefined, undefined)
          }}
        >
          Composer send
        </button>
        <button
          type="button"
          aria-label="Composer draft"
          onClick={() => props.onDraftChange?.('  Fix the flaky pty test  ')}
        >
          Composer draft
        </button>
      </div>
    )
  }
}))

const ALPHA = 'C:\\repo-alpha'
const BETA = 'C:\\repo-beta'

/** Realistic RunSummary per src/shared/ipc/schemas/agent.ts RunSummarySchema. */
function makeRun(overrides: {
  runId: string
  updatedAt: string
  status?: RunSummary['status']
  goal?: string
}): RunSummary {
  return {
    runId: overrides.runId,
    status: overrides.status ?? 'done',
    updatedAt: overrides.updatedAt,
    ...(overrides.goal != null ? { goal: overrides.goal } : {})
  }
}

/** ISO timestamps a few minutes apart so recency grouping is stable. */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString()
}

function renderHome(props: Partial<Parameters<typeof HomePage>[0]> = {}) {
  const onNewSessionInWorkspace = vi.fn()
  const onSelectRunInWorkspace = vi.fn()
  const onSwitchWorkspace = vi.fn()
  const onAddWorkspace = vi.fn()
  const onSendInWorkspace = vi.fn(async () => true)
  const onDraftChangeInWorkspace = vi.fn()
  const onTogglePinnedRun = vi.fn()

  const utils = render(
    <HomePage
      openWorkspaces={[ALPHA, BETA]}
      activeWorkspacePath={ALPHA}
      runsByWorkspacePath={{
        [ALPHA]: {
          runs: [
            makeRun({ runId: 'run-a1', goal: 'Fix the login redirect', updatedAt: minutesAgo(5) }),
            makeRun({ runId: 'run-a2', goal: 'Update README install steps', updatedAt: minutesAgo(90) })
          ],
          activeRunId: null
        },
        [BETA]: {
          runs: [makeRun({ runId: 'run-b1', goal: 'Audit the auth flow', status: 'running', updatedAt: minutesAgo(2) })],
          activeRunId: 'run-b1'
        }
      }}
      onNewSessionInWorkspace={onNewSessionInWorkspace}
      onSelectRunInWorkspace={onSelectRunInWorkspace}
      onSwitchWorkspace={onSwitchWorkspace}
      onAddWorkspace={onAddWorkspace}
      onSendInWorkspace={onSendInWorkspace}
      onDraftChangeInWorkspace={onDraftChangeInWorkspace}
      pinnedRunKeys={[]}
      onTogglePinnedRun={onTogglePinnedRun}
      provider={'openai' as ProviderId}
      model="gpt-test"
      secrets={{} as Record<SecretProvider, boolean>}
      onProviderModel={vi.fn()}
      chatSettings={{} as unknown as EffectiveChatSettings}
      onChatSettingsChange={vi.fn()}
      {...props}
    />
  )

  return {
    ...utils,
    handlers: {
      onNewSessionInWorkspace,
      onSelectRunInWorkspace,
      onSwitchWorkspace,
      onAddWorkspace,
      onSendInWorkspace,
      onDraftChangeInWorkspace,
      onTogglePinnedRun
    }
  }
}

beforeEach(() => {
  composerState.props = {}
})

describe('HomePage', () => {
  it('sends the composed message through to the targeted workspace', () => {
    const { handlers } = renderHome()

    fireEvent.click(screen.getByRole('button', { name: 'Composer send' }))

    expect(handlers.onSendInWorkspace).toHaveBeenCalledTimes(1)
    expect(handlers.onSendInWorkspace).toHaveBeenCalledWith(
      ALPHA,
      '  Fix the flaky pty test  ',
      ['img-1'],
      undefined,
      undefined
    )
  })

  it('retargets the hero composer with workspace chips', () => {
    const { handlers } = renderHome()

    const betaChip = screen.getByRole('button', { name: 'repo-beta' })
    expect(betaChip.getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: 'repo-alpha' }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(betaChip)
    expect(betaChip.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Composer send' }))
    expect(handlers.onSendInWorkspace).toHaveBeenCalledWith(
      BETA,
      '  Fix the flaky pty test  ',
      ['img-1'],
      undefined,
      undefined
    )
  })

  it('keeps a single workspace implicit — no chips, workspace named in the subtitle', () => {
    renderHome({
      openWorkspaces: [ALPHA],
      activeWorkspacePath: ALPHA,
      runsByWorkspacePath: {
        [ALPHA]: {
          runs: [makeRun({ runId: 'run-a1', goal: 'Fix the login redirect', updatedAt: minutesAgo(5) })],
          activeRunId: null
        }
      }
    })

    expect(screen.queryByRole('button', { name: 'repo-alpha' })).toBeNull()
    expect(screen.getByText(/the session starts in repo-alpha/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Composer send' }))
    expect(composerState.props.workspacePath).toBe(ALPHA)
  })

  it('persists composer drafts keyed to the targeted workspace', () => {
    const { handlers } = renderHome()

    fireEvent.click(screen.getByRole('button', { name: 'Composer draft' }))

    expect(handlers.onDraftChangeInWorkspace).toHaveBeenCalledTimes(1)
    expect(handlers.onDraftChangeInWorkspace).toHaveBeenCalledWith(ALPHA, '  Fix the flaky pty test  ')
  })

  it('switches workspace when a workspace card is clicked', () => {
    const { handlers } = renderHome()

    fireEvent.click(screen.getByRole('button', { name: 'Open workspace repo-beta' }))

    expect(handlers.onSwitchWorkspace).toHaveBeenCalledTimes(1)
    expect(handlers.onSwitchWorkspace).toHaveBeenCalledWith(BETA)
  })

  it('starts a fresh chat in a workspace from its card action', () => {
    const { handlers } = renderHome()

    const newChatButtons = screen.getAllByRole('button', { name: 'New chat' })
    expect(newChatButtons).toHaveLength(2)
    fireEvent.click(newChatButtons[0]!)

    expect(handlers.onNewSessionInWorkspace).toHaveBeenCalledTimes(1)
    expect(handlers.onNewSessionInWorkspace).toHaveBeenCalledWith(ALPHA, '')
  })

  it('opens a recent session row with its workspace path and run id', () => {
    // No activeRuns: a live run surfaced through activeRuns renders in the
    // Running now section, not Recent — run-b1 has status 'running' but stays
    // in Recent because activeRuns has not caught up.
    const { handlers } = renderHome()

    const recent = within(screen.getByRole('region', { name: 'Recent sessions' }))
    const row = recent.getByRole('button', { name: /^Audit the auth flow/ })
    expect(row.textContent).toContain('repo-beta')
    fireEvent.click(row)

    expect(handlers.onSelectRunInWorkspace).toHaveBeenCalledTimes(1)
    expect(handlers.onSelectRunInWorkspace).toHaveBeenCalledWith(BETA, 'run-b1')
  })

  it('renders a wired add-workspace empty state when no workspaces are open', () => {
    const { handlers } = renderHome({
      openWorkspaces: [],
      activeWorkspacePath: null,
      runsByWorkspacePath: {}
    })

    expect(screen.getByText('Add your first workspace')).toBeTruthy()
    expect(screen.queryByTestId('composer-stub')).toBeNull()

    const addButtons = screen.getAllByRole('button', { name: 'Add workspace' })
    expect(addButtons).toHaveLength(1)
    fireEvent.click(addButtons[0]!)

    expect(handlers.onAddWorkspace).toHaveBeenCalledTimes(1)
  })

  it('renders workspace cards plus the no-sessions message when there are no runs yet', () => {
    renderHome({
      runsByWorkspacePath: {
        [ALPHA]: { runs: [], activeRunId: null },
        [BETA]: { runs: [], activeRunId: null }
      }
    })

    expect(screen.getByText(/No sessions yet — start your first session/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open workspace repo-alpha' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open workspace repo-beta' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'New chat' })).toHaveLength(2)
  })

  it('keeps instance runs out of Recent sessions and out of the card session count', () => {
    renderHome({
      runsByWorkspacePath: {
        [ALPHA]: {
          runs: [
            makeRun({ runId: 'run-a1', goal: 'Fix the login redirect', updatedAt: minutesAgo(5) }),
            makeRun({ runId: 'run-a2', goal: 'Update README install steps', updatedAt: minutesAgo(90) })
          ],
          instanceRuns: [
            makeRun({ runId: 'inst-a1', goal: 'docs/arc-eval.md', updatedAt: minutesAgo(1) }),
            makeRun({ runId: 'inst-a2', goal: 'src/app', updatedAt: minutesAgo(3) })
          ],
          activeRunId: null
        },
        [BETA]: {
          runs: [makeRun({ runId: 'run-b1', goal: 'Audit the auth flow', status: 'running', updatedAt: minutesAgo(2) })],
          activeRunId: 'run-b1'
        }
      }
    })

    // Instances stay folded under their parent in the sidebar — Home must not
    // surface them as top-level sessions.
    expect(screen.queryByRole('button', { name: /docs\/arc-eval\.md/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /src\/app/ })).toBeNull()
    expect(
      within(screen.getByRole('region', { name: 'Recent sessions' })).getByRole('button', {
        name: /^Fix the login redirect/
      })
    ).toBeTruthy()
    // Workspace cards count sessions (parent runs), not instance sub-runs.
    expect(screen.getByText('2 sessions')).toBeTruthy()
    expect(screen.queryByText('4 sessions')).toBeNull()
  })

  it('shows the running spinner from run status even when activeRuns has not caught up', () => {
    renderHome() // run-b1 has status 'running'; no activeRuns passed

    expect(
      within(screen.getByRole('region', { name: 'Recent sessions' })).getByTitle('Running')
    ).toBeTruthy()
  })

  it('hides the per-row workspace badge when only one workspace is open', () => {
    renderHome({
      openWorkspaces: [ALPHA],
      activeWorkspacePath: ALPHA,
      runsByWorkspacePath: {
        [ALPHA]: {
          runs: [makeRun({ runId: 'run-a1', goal: 'Fix the login redirect', updatedAt: minutesAgo(5) })],
          activeRunId: null
        }
      }
    })

    const row = within(screen.getByRole('region', { name: 'Recent sessions' })).getByRole(
      'button',
      { name: /^Fix the login redirect/ }
    )
    expect(row.textContent).not.toContain('repo-alpha')
  })

  it('opens an idle session from the Continue where you left off strip', () => {
    const { handlers } = renderHome()

    const strip = within(screen.getByRole('region', { name: 'Continue where you left off' }))
    fireEvent.click(strip.getByRole('button', { name: /^Fix the login redirect, repo-alpha/ }))

    expect(handlers.onSelectRunInWorkspace).toHaveBeenCalledWith(ALPHA, 'run-a1')
  })

  it('excludes running sessions from the Continue strip — they own Running now', () => {
    renderHome()

    const strip = within(screen.getByRole('region', { name: 'Continue where you left off' }))
    expect(strip.queryByRole('button', { name: /Audit the auth flow/ })).toBeNull()
    expect(strip.getByRole('button', { name: /^Update README install steps/ })).toBeTruthy()
  })

  it('shows a Running now section for live runs and opens them', () => {
    const { handlers } = renderHome({ activeRuns: [{ runId: 'run-b1', workspacePath: BETA }] })

    const running = within(screen.getByRole('region', { name: 'Running now' }))
    fireEvent.click(running.getByRole('button', { name: /^Audit the auth flow/ }))

    expect(handlers.onSelectRunInWorkspace).toHaveBeenCalledWith(BETA, 'run-b1')
  })

  it('filters recent sessions by title from the filter input', () => {
    renderHome()

    const recent = within(screen.getByRole('region', { name: 'Recent sessions' }))
    fireEvent.change(screen.getByLabelText('Filter sessions'), {
      target: { value: 'audit' }
    })

    expect(recent.getByRole('button', { name: /^Audit the auth flow/ })).toBeTruthy()
    expect(recent.queryByRole('button', { name: /^Fix the login redirect/ })).toBeNull()
  })

  it('shows a no-match message when the filter matches nothing', () => {
    renderHome()

    fireEvent.change(screen.getByLabelText('Filter sessions'), {
      target: { value: 'no-such-session' }
    })

    expect(screen.getByText('No sessions match this filter.')).toBeTruthy()
  })

  it('keeps a keyboard tab stop in the Recent list when filtering shrinks it', () => {
    const { container } = renderHome()

    const rows = container.querySelectorAll('[data-session-open]')
    expect(rows.length).toBeGreaterThan(1)

    // Move the roving focus to the last row, then shrink the list to one row.
    fireEvent.keyDown(rows[rows.length - 1]!, { key: 'End' })
    fireEvent.change(screen.getByLabelText('Filter sessions'), { target: { value: 'audit' } })

    const filtered = container.querySelectorAll('[data-session-open]')
    expect(filtered.length).toBe(1)
    expect((filtered[0] as HTMLButtonElement).tabIndex).toBe(0)
  })

  it('clears the session filter with Escape and restores the list', () => {
    const { container } = renderHome()

    const input = screen.getByLabelText('Filter sessions') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'audit' } })
    expect(container.querySelectorAll('[data-session-open]')).toHaveLength(1)

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.value).toBe('')
    expect(container.querySelectorAll('[data-session-open]')).toHaveLength(3)
  })

  it('pins a session from the Running now row', () => {
    const { handlers } = renderHome({ activeRuns: [{ runId: 'run-b1', workspacePath: BETA }] })

    const running = within(screen.getByRole('region', { name: 'Running now' }))
    fireEvent.click(running.getByRole('button', { name: 'Pin Audit the auth flow' }))

    expect(handlers.onTogglePinnedRun).toHaveBeenCalledWith(`${BETA}\u0000run-b1`)
  })

  it('shows git branch and change count on workspace cards', async () => {
    const original = window.vyotiq
    // @ts-expect-error test bridge
    window.vyotiq = {
      gitStatus: vi.fn(async () => ({
        ok: true as const,
        data: {
          kind: 'ok' as const,
          status: { branch: 'main', truncated: true, fileCount: 2 }
        }
      }))
    }
    try {
      renderHome()
      expect((await screen.findAllByText(/main · 2 changed/)).length).toBe(2)
    } finally {
      // @ts-expect-error test bridge
      window.vyotiq = original
    }
  })

  it('dispatches pin toggle with the session key from the row action', () => {
    const { handlers } = renderHome()

    fireEvent.click(screen.getByRole('button', { name: 'Pin Audit the auth flow' }))

    expect(handlers.onTogglePinnedRun).toHaveBeenCalledTimes(1)
    expect(handlers.onTogglePinnedRun).toHaveBeenCalledWith(`${BETA}\u0000run-b1`)
  })

  it('renders pinned sessions in a Pinned section with unpin actions', () => {
    const { handlers } = renderHome({ pinnedRunKeys: [`${ALPHA}\u0000run-a1`] })

    expect(screen.getByText('Pinned')).toBeTruthy()
    // Both the Pinned row and its recency row show the unpin toggle.
    const unpinButtons = screen.getAllByRole('button', { name: 'Unpin Fix the login redirect' })
    expect(unpinButtons.length).toBe(2)
    fireEvent.click(unpinButtons[0]!)
    expect(handlers.onTogglePinnedRun).toHaveBeenCalledWith(`${ALPHA}\u0000run-a1`)
  })

  it('renders a pinned session older than the recency cap in Pinned', () => {
    // 26 sessions: the two oldest fall outside the 24-run recency cap, yet a
    // pin on the oldest must still resolve and render in Pinned.
    const runs = Array.from({ length: 26 }, (_, i) =>
      makeRun({
        runId: `run-old-${i}`,
        goal: `Older session ${i}`,
        updatedAt: minutesAgo(60 * (i + 1))
      })
    )
    renderHome({
      runsByWorkspacePath: {
        [ALPHA]: { runs, activeRunId: null },
        [BETA]: { runs: [], activeRunId: null }
      },
      pinnedRunKeys: [`${ALPHA}\u0000run-old-25`]
    })

    const pinned = within(screen.getByRole('region', { name: 'Pinned' }))
    expect(pinned.getByRole('button', { name: /^Older session 25/ })).toBeTruthy()

    // The recency-capped Recent list does not carry the out-of-cap session.
    const recent = within(screen.getByRole('region', { name: 'Recent sessions' }))
    expect(recent.queryByRole('button', { name: /^Older session 25/ })).toBeNull()
  })

  it('shows the usage strip from real run stats', async () => {
    // @ts-expect-error test bridge
    window.vyotiq = {
      runStats: vi.fn(async () => ({
        ok: true as const,
        data: {
          stats: [
            {
              runId: 'run-a1',
              messages: 42,
              tokenUsage: { billedInputTokens: 1500, outputTokens: 120 }
            },
            { runId: 'run-b1', messages: 7 }
          ]
        }
      }))
    }

    try {
      renderHome()
      expect(await screen.findByText(/billed input/)).toBeTruthy()
      expect(screen.getByText('3 sessions')).toBeTruthy()
      expect(screen.getByText('49 messages')).toBeTruthy()
      expect(screen.getByText('1.5K billed input')).toBeTruthy()
      expect(screen.getByText('120 output')).toBeTruthy()
    } finally {
      delete (window as { vyotiq?: unknown }).vyotiq
    }
  })

  it('hides the usage strip when run stats are unavailable', () => {
    renderHome() // no bridge — stats stay empty, strip stays hidden (no fake zeros)

    expect(screen.queryByText(/billed input/)).toBeNull()
    expect(screen.queryByText(/messages/)).toBeNull()
  })

  it('caps pin toggles at 24 keeping the newest and prunes identity-stable', () => {
    const keys = Array.from({ length: 24 }, (_, i) => `k${i}`)
    expect(togglePinnedRun(keys, 'new')).toEqual([...keys.slice(1), 'new'])
    expect(togglePinnedRun(['a', 'b'], 'a')).toEqual(['b'])
    expect(prunePinnedRun(['a'], 'b')).toEqual(['a'])
    expect(prunePinnedRun(['a'], 'a')).toEqual([])
  })
})
