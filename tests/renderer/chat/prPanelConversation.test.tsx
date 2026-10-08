/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { PrPanel } from '@renderer/features/chat/components/PrPanel'
import type { PrView } from '@shared/ipc'

function prWith(overrides: Partial<PrView> = {}): PrView {
  return {
    number: 63,
    title: 'chore(deps-dev): bump @lezer/highlight',
    url: 'https://github.com/vyotiqai/vyotiq-agent-v/pull/63',
    state: 'OPEN',
    baseRefName: 'main',
    headRefName: 'dependabot/dev',
    baseRefOid: 'aaa',
    headRefOid: 'bbb',
    body: 'Bumps the group.\n\n**Release notes**',
    additions: 1,
    deletions: 1,
    files: [],
    commits: [],
    checks: [],
    reviews: [],
    latestReviews: [],
    reviewDecision: '',
    reviewRequests: ['vyotiqai'],
    isDraft: false,
    mergeStateStatus: 'BLOCKED',
    // The comment GitHub has on this PR (see tests/fixtures/github/pr-view-63-conversation.json).
    comments: [
      {
        author: 'dependabot',
        body: 'Looks like @lezer/highlight is updatable in another way, so this is no longer needed.',
        createdAt: '2026-10-04T13:16:09Z',
        url: 'https://github.com/vyotiqai/vyotiq-agent-v/pull/63#issuecomment-5980353356',
        minimized: false
      },
      { author: 'spam-bot', body: 'buy now', createdAt: null, url: null, minimized: true }
    ],
    commentCount: 2,
    autoMerge: null,
    ...overrides
  }
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
    prEditBody: vi.fn().mockResolvedValue({ ok: true, data: { body: 'New text' } }),
    prComment: vi.fn().mockResolvedValue({ ok: true, data: { detail: 'Comment posted', url: 'https://github.com/o/r/pull/63#issuecomment-1' } }),
    prReviewers: vi.fn().mockResolvedValue({ ok: true, data: { detail: 'Review requested from alice', reviewRequests: ['vyotiqai', 'alice'] } }),
    prReviewerSuggestions: vi.fn().mockResolvedValue({ ok: true, data: { logins: ['alice', 'vyotiqai'] } }),
    prAutoMerge: vi.fn().mockResolvedValue({
      ok: true,
      data: { detail: 'Auto-merge on: it will rebase and merge once its requirements are met', autoMerge: { method: 'REBASE', enabledBy: 'me' } }
    }),
    shellOpenExternal: vi.fn().mockResolvedValue({ ok: true, data: true })
  }
  Object.defineProperty(window, 'vyotiq', { configurable: true, writable: true, value: api })
})

afterEach(() => cleanup())

async function openTab(name: RegExp | string): Promise<void> {
  fireEvent.click(await screen.findByRole('tab', { name }))
}

describe('PrPanel About: the conversation', () => {
  it('lists the comments, folds a hidden one, and counts them on the tab', async () => {
    render(<PrPanel workspacePath="/ws" />)
    await openTab(/About/)
    const list = await waitFor(() => {
      const el = document.querySelector('[data-pr-comments]')
      if (!el) throw new Error('no comments yet')
      return el as HTMLElement
    })
    expect(within(list).getByText(/updatable in another way/)).toBeTruthy()
    expect(within(list).queryByText('buy now')).toBeNull()
    fireEvent.click(within(list).getByRole('button', { name: 'Show it' }))
    expect(within(list).getByText('buy now')).toBeTruthy()
    expect(screen.getByRole('tab', { name: /About/ }).textContent).toMatch(/2/)
  })

  it('posts a comment from the button and reads the PR again', async () => {
    render(<PrPanel workspacePath="/ws" />)
    await openTab(/About/)
    const field = await screen.findByRole('textbox', { name: 'Comment on this pull request' })
    const send = screen.getByRole('button', { name: 'Comment' })
    expect((send as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(field, { target: { value: 'Closing in favour of #64.' } })
    fireEvent.click(send)
    await waitFor(() => expect(api.prComment).toHaveBeenCalledWith({ workspacePath: '/ws', number: 63, body: 'Closing in favour of #64.' }))
    expect(await screen.findByText('Comment posted')).toBeTruthy()
    expect((field as HTMLTextAreaElement).value).toBe('')
    await waitFor(() => expect(api.prView!.mock.calls.length).toBeGreaterThanOrEqual(2))
  })

  it('edits the description against the one shown, and keeps the draft when GitHub refuses', async () => {
    api.prEditBody!.mockResolvedValueOnce({ ok: false, error: 'The description was changed on GitHub after you started editing. Refresh to see it, then edit again.' })
    render(<PrPanel workspacePath="/ws" />)
    await openTab(/About/)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit the description' }))
    const field = screen.getByRole('textbox', { name: 'Pull request description' }) as HTMLTextAreaElement
    expect(field.value).toBe('Bumps the group.\n\n**Release notes**')
    expect(document.activeElement).toBe(field)
    fireEvent.change(field, { target: { value: 'New text' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(api.prEditBody).toHaveBeenCalledWith({
        workspacePath: '/ws',
        number: 63,
        body: 'New text',
        expected: 'Bumps the group.\n\n**Release notes**'
      })
    )
    expect((await screen.findByRole('alert')).textContent).toMatch(/changed on GitHub after you started editing/)
    expect((screen.getByRole('textbox', { name: 'Pull request description' }) as HTMLTextAreaElement).value).toBe('New text')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Description saved')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Pull request description' })).toBeNull()
  })
})

describe('PrPanel Reviews: reviewers', () => {
  it('requests a review and shows the list GitHub reports back', async () => {
    render(<PrPanel workspacePath="/ws" />)
    await openTab(/Reviews/)
    const section = await waitFor(() => {
      const el = document.querySelector('[data-pr-reviewers]')
      if (!el) throw new Error('no reviewers yet')
      return el as HTMLElement
    })
    const field = within(section).getByRole('combobox', { name: 'Request a review from' })
    fireEvent.focus(field)
    await waitFor(() => expect(api.prReviewerSuggestions).toHaveBeenCalledWith({ workspacePath: '/ws' }))
    fireEvent.change(field, { target: { value: '@alice' } })
    fireEvent.click(within(section).getByRole('button', { name: 'Request' }))
    await waitFor(() => expect(api.prReviewers).toHaveBeenCalledWith({ workspacePath: '/ws', number: 63, add: ['alice'], remove: [] }))
    expect(await within(section).findByText('alice')).toBeTruthy()
  })

  it('withdraws a request', async () => {
    api.prReviewers!.mockResolvedValue({ ok: true, data: { detail: 'Review request withdrawn from vyotiqai', reviewRequests: [] } })
    render(<PrPanel workspacePath="/ws" />)
    await openTab(/Reviews/)
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw the review request from vyotiqai' }))
    await waitFor(() => expect(api.prReviewers).toHaveBeenCalledWith({ workspacePath: '/ws', number: 63, add: [], remove: ['vyotiqai'] }))
    expect(await screen.findByText('Nobody yet.')).toBeTruthy()
  })

  it('refuses a login GitHub could not take before asking', async () => {
    render(<PrPanel workspacePath="/ws" />)
    await openTab(/Reviews/)
    const field = await screen.findByRole('combobox', { name: 'Request a review from' })
    fireEvent.change(field, { target: { value: 'not a login!' } })
    expect((screen.getByRole('button', { name: 'Request' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('PrPanel Checks: auto-merge', () => {
  it('offers Merge when ready only when GitHub would take it, by the method picked', async () => {
    api.prView!.mockResolvedValue({ ok: true, data: prWith({ canAutoMerge: true }) })
    render(<PrPanel workspacePath="/ws" />)
    fireEvent.click(await screen.findByRole('button', { name: /Merge when ready/ }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rebase and merge' }))
    await waitFor(() => expect(api.prAutoMerge).toHaveBeenCalledWith({ workspacePath: '/ws', number: 63, enable: true, method: 'rebase' }))
    expect(await screen.findByText(/Auto-merge on: it will rebase and merge/)).toBeTruthy()
  })

  it('is not offered when GitHub says it cannot be (this repository: auto-merge not allowed)', async () => {
    api.prView!.mockResolvedValue({ ok: true, data: prWith({ canAutoMerge: false }) })
    render(<PrPanel workspacePath="/ws" />)
    await screen.findByRole('button', { name: /Squash and merge/ })
    expect(screen.queryByRole('button', { name: /Merge when ready/ })).toBeNull()
  })

  it('says when it is on, by whom, and turns it off', async () => {
    api.prView!.mockResolvedValue({ ok: true, data: prWith({ autoMerge: { method: 'SQUASH', enabledBy: 'octocat' } }) })
    api.prAutoMerge!.mockResolvedValue({ ok: true, data: { detail: 'Auto-merge off', autoMerge: null } })
    render(<PrPanel workspacePath="/ws" />)
    const on = await waitFor(() => {
      const el = document.querySelector('[data-auto-merge="on"]')
      if (!el) throw new Error('not shown yet')
      return el as HTMLElement
    })
    expect(on.textContent).toMatch(/Auto-merge is on: GitHub will squash and merge once its requirements are met · by octocat/)
    fireEvent.click(within(on).getByRole('button', { name: 'Turn off' }))
    await waitFor(() => expect(api.prAutoMerge).toHaveBeenCalledWith({ workspacePath: '/ws', number: 63, enable: false }))
  })
})
