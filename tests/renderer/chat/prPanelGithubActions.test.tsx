/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { PrPanel } from '@renderer/features/chat/components/PrPanel'
import type { GithubIssueDetail, PrView } from '@shared/ipc'

const JOB_URL = 'https://github.com/vyotiqai/vyotiq-agent-v/actions/runs/37205055756/job/111444405036'

function prWith(overrides: Partial<PrView> = {}): PrView {
  return {
    number: 64,
    title: 'chore(deps-dev): bump',
    url: 'https://github.com/vyotiqai/vyotiq-agent-v/pull/64',
    state: 'OPEN',
    baseRefName: 'main',
    headRefName: 'dependabot/dev',
    baseRefOid: 'aaa',
    headRefOid: 'bbb',
    body: '',
    additions: 1,
    deletions: 0,
    files: [],
    commits: [],
    checks: [
      { name: 'ubuntu-latest', state: 'COMPLETED', conclusion: 'FAILURE', url: JOB_URL },
      { name: 'Security Reviewer', state: 'COMPLETED', conclusion: 'FAILURE', url: 'https://cursor.com/agents/x' },
      { name: 'macos-latest', state: 'COMPLETED', conclusion: 'SUCCESS', url: JOB_URL.replace('405036', '405079') }
    ],
    reviews: [],
    latestReviews: [],
    reviewDecision: '',
    reviewRequests: [],
    isDraft: false,
    mergeStateStatus: '',
    ...overrides
  }
}

const LOG = {
  step: 'node scripts/typecheck-tests-ratchet.mjs',
  excerpt: 'tsconfig.tests-node.json: 1 file(s) gained type errors:\nError: Process completed with exit code 1.',
  truncated: false,
  foundError: true
}

const ISSUE: GithubIssueDetail = {
  number: 12,
  title: 'Crash on start',
  url: 'https://github.com/o/r/issues/12',
  state: 'OPEN',
  author: 'ada',
  body: 'It **crashes**.',
  labels: ['bug'],
  createdAt: null,
  comments: [{ author: 'bob', body: 'Same here', createdAt: null }],
  commentCount: 1
}

let api: Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  api = {
    prView: vi.fn().mockResolvedValue({ ok: true, data: prWith() }),
    githubAuthStatus: vi.fn().mockResolvedValue({
      ok: true,
      data: { ghAvailable: true, ghAuthenticated: true, hasAppToken: false, pending: false }
    }),
    onGithubAuthStatus: vi.fn(() => () => {}),
    prReviewThreads: vi.fn().mockResolvedValue({ ok: true, data: null }),
    prCheckLog: vi.fn().mockResolvedValue({ ok: true, data: LOG }),
    prCheckRerun: vi.fn().mockResolvedValue({ ok: true, data: { detail: 'Re-running ubuntu-latest' } }),
    prCleanupMerged: vi.fn().mockResolvedValue({
      ok: true,
      data: { detail: 'Switched to main, deleted dependabot/dev here and on GitHub.', switchedTo: 'main', deletedLocal: true, deletedRemote: true }
    }),
    githubIssuesList: vi.fn().mockResolvedValue({ ok: true, data: { issues: [{ number: 12, title: 'Crash on start', url: ISSUE.url, state: 'OPEN' }] } }),
    githubIssueView: vi.fn().mockResolvedValue({ ok: true, data: ISSUE }),
    shellOpenExternal: vi.fn().mockResolvedValue({ ok: true, data: true })
  }
  Object.defineProperty(window, 'vyotiq', { configurable: true, writable: true, value: api })
})

afterEach(() => cleanup())

async function checksList(): Promise<HTMLElement> {
  return screen.findByRole('list', { name: 'Checks' })
}

describe('PrPanel: a failed GitHub Actions check', () => {
  it('shows its failing step in place, read once', async () => {
    render(<PrPanel workspacePath="/ws" />)
    const list = await checksList()
    // Only the Actions job has a log; the third-party check links out only.
    expect(within(list).queryByRole('button', { name: 'Show the Security Reviewer log' })).toBeNull()
    fireEvent.click(within(list).getByRole('button', { name: 'Show the ubuntu-latest log' }))
    expect(await screen.findByText(/gained type errors/)).toBeTruthy()
    expect(screen.getByText('Run node scripts/typecheck-tests-ratchet.mjs')).toBeTruthy()
    expect(api.prCheckLog).toHaveBeenCalledWith({ workspacePath: '/ws', url: JOB_URL })
    fireEvent.click(within(list).getByRole('button', { name: 'Hide the ubuntu-latest log' }))
    fireEvent.click(within(list).getByRole('button', { name: 'Show the ubuntu-latest log' }))
    expect(api.prCheckLog).toHaveBeenCalledTimes(1)
  })

  it('says why when the log cannot be read', async () => {
    api.prCheckLog!.mockResolvedValue({ ok: false, error: 'job is still in progress' })
    render(<PrPanel workspacePath="/ws" />)
    fireEvent.click(within(await checksList()).getByRole('button', { name: 'Show the ubuntu-latest log' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/still in progress/)
  })

  it('re-runs the job and reads the pull request again', async () => {
    render(<PrPanel workspacePath="/ws" />)
    fireEvent.click(within(await checksList()).getByRole('button', { name: 'Re-run ubuntu-latest' }))
    await waitFor(() => expect(api.prCheckRerun).toHaveBeenCalledWith({ workspacePath: '/ws', url: JOB_URL }))
    expect(await screen.findByText('Re-running ubuntu-latest')).toBeTruthy()
    await waitFor(() => expect(api.prView!.mock.calls.length).toBeGreaterThanOrEqual(2))
  })

  it('hands the failing step to the agent with the ask', async () => {
    const onHandToAgent = vi.fn()
    render(<PrPanel workspacePath="/ws" onHandToAgent={onHandToAgent} />)
    const rows = within(await checksList()).getAllByRole('button', { name: 'Hand to the agent' })
    fireEvent.click(rows[0]!)
    await waitFor(() => expect(onHandToAgent).toHaveBeenCalledTimes(1))
    const text = onHandToAgent.mock.calls[0]![0] as string
    expect(text).toMatch(/^The “ubuntu-latest” check failed on pull request #64\./)
    expect(text).toMatch(/Failing step \(node scripts\/typecheck-tests-ratchet\.mjs\):\n```\ntsconfig/)
  })

  it('hands a check without a log as the plain ask', async () => {
    const onHandToAgent = vi.fn()
    render(<PrPanel workspacePath="/ws" onHandToAgent={onHandToAgent} />)
    fireEvent.click(within(await checksList()).getAllByRole('button', { name: 'Hand to the agent' })[1]!)
    await waitFor(() => expect(onHandToAgent).toHaveBeenCalled())
    expect(onHandToAgent.mock.calls[0]![0]).not.toMatch(/Failing step/)
    expect(api.prCheckLog).not.toHaveBeenCalled()
  })
})

describe('PrPanel: after a merge', () => {
  it('cleans up the merged branch once confirmed', async () => {
    api.prView!.mockResolvedValue({ ok: true, data: prWith({ state: 'MERGED', checks: [] }) })
    render(<PrPanel workspacePath="/ws" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Clean up dependabot/dev' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toMatch(/Switch to main and pull it, then delete dependabot\/dev here and on GitHub/)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clean up' }))
    await waitFor(() => expect(api.prCleanupMerged).toHaveBeenCalledWith({ workspacePath: '/ws', number: 64 }))
    expect(await screen.findByText(/Switched to main, deleted dependabot\/dev here and on GitHub/)).toBeTruthy()
  })

  it('offers no clean-up on an open pull request', async () => {
    render(<PrPanel workspacePath="/ws" />)
    await checksList()
    expect(screen.queryByRole('button', { name: /^Clean up/ })).toBeNull()
  })
})

describe('PrPanel: issues', () => {
  it('opens an issue in full and starts a task from it', async () => {
    api.prView!.mockResolvedValue({ ok: true, data: null })
    const onStartTask = vi.fn()
    render(<PrPanel workspacePath="/ws" onStartTask={onStartTask} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Issues' }))
    fireEvent.click(await screen.findByRole('button', { name: /#12\s*Crash on start/ }))
    await waitFor(() => expect(api.githubIssueView).toHaveBeenCalledWith({ workspacePath: '/ws', number: 12 }))
    const view = await waitFor(() => {
      const el = document.querySelector('[data-issue-view]')
      if (!el?.textContent?.includes('Same here')) throw new Error('issue not shown yet')
      return el as HTMLElement
    })
    expect(within(view).getByText('bug')).toBeTruthy()
    expect(within(view).getByText('crashes').tagName).toBe('STRONG')
    fireEvent.click(within(view).getByRole('button', { name: 'Start a task' }))
    expect(onStartTask).toHaveBeenCalledWith(
      ['Resolve GitHub issue #12: Crash on start', 'https://github.com/o/r/issues/12', '', 'It **crashes**.', '', 'Fixes #12'].join('\n')
    )
    fireEvent.click(within(view).getByRole('button', { name: 'Back to issues' }))
    expect(await screen.findByText('Open issues')).toBeTruthy()
  })

  it('shows why an issue could not be read, and no Start a task without a place to start it', async () => {
    api.prView!.mockResolvedValue({ ok: true, data: null })
    api.githubIssueView!.mockResolvedValue({ ok: false, error: 'Could not resolve to an issue' })
    render(<PrPanel workspacePath="/ws" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Issues' }))
    fireEvent.click(await screen.findByRole('button', { name: /#12\s*Crash on start/ }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not resolve/)
    expect(screen.queryByRole('button', { name: 'Start a task' })).toBeNull()
  })
})
