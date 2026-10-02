/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { PrPanel } from '@renderer/features/chat/components/PrPanel'
import { PrReviewThreads } from '@renderer/features/chat/components/PrReviewThreads'
import { groupReviewThreads } from '@renderer/features/chat/components/reviewThreadGroups'
import { followUpOrigin, prReviewInstruction } from '@renderer/features/task/followUps'
import type { PrReviewThread, PrReviewThreadsResult, PrView } from '@shared/ipc'

function thread(overrides: Partial<PrReviewThread> & { id: string }): PrReviewThread {
  return {
    path: 'src/app.ts',
    line: 10,
    originalLine: 10,
    startLine: null,
    diffSide: 'RIGHT',
    isResolved: false,
    isOutdated: false,
    resolvedBy: null,
    viewerCanResolve: true,
    viewerCanUnresolve: false,
    viewerCanReply: true,
    comments: [
      {
        id: `${overrides.id}-c1`,
        author: 'alice',
        body: 'Please rename this.',
        createdAt: '2026-10-01T10:00:00Z',
        url: `https://github.com/acme/app/pull/12#discussion_${overrides.id}`
      }
    ],
    commentCount: 1,
    ...overrides
  }
}

const OPEN_APP_42 = thread({ id: 'PRRT_a', line: 42, originalLine: 40 })
const OPEN_APP_FILE = thread({ id: 'PRRT_b', line: null, originalLine: null })
const RESOLVED_APP_7 = thread({
  id: 'PRRT_c',
  line: 7,
  originalLine: 7,
  isResolved: true,
  viewerCanResolve: false,
  viewerCanUnresolve: true,
  comments: [{ id: 'c', author: 'carol', body: 'Typo here', createdAt: null, url: null }]
})
const OUTDATED_README = thread({
  id: 'PRRT_d',
  path: 'README.md',
  line: null,
  originalLine: 3,
  isOutdated: true,
  comments: [
    { id: 'd1', author: 'dave', body: 'Old wording', createdAt: null, url: 'https://github.com/acme/app/pull/12#discussion_r4' },
    { id: 'd2', author: 'erin', body: 'Agreed,\nfix it', createdAt: null, url: null }
  ],
  commentCount: 2
})

const ALL = [RESOLVED_APP_7, OPEN_APP_42, OUTDATED_README, OPEN_APP_FILE]

function result(threads: PrReviewThread[]): PrReviewThreadsResult {
  return { number: 12, threads, totalCount: threads.length, truncated: false }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('groupReviewThreads', () => {
  it('groups by file in path order, threads by line with whole-file comments first', () => {
    const { groups, unresolved, resolvedCount } = groupReviewThreads(ALL)
    expect(groups.map((g) => g.path)).toEqual(['README.md', 'src/app.ts'])
    expect(groups[1]!.threads.map((t) => t.id)).toEqual(['PRRT_b', 'PRRT_a'])
    expect(resolvedCount).toBe(1)
    expect(unresolved.map((t) => t.id)).toEqual(['PRRT_d', 'PRRT_b', 'PRRT_a'])
  })

  it('keeps resolved threads in line order when shown', () => {
    const { groups, unresolved } = groupReviewThreads(ALL, { showResolved: true })
    expect(groups[1]!.threads.map((t) => t.id)).toEqual(['PRRT_b', 'PRRT_c', 'PRRT_a'])
    expect(unresolved.map((t) => t.id)).not.toContain('PRRT_c')
  })
})

describe('prReviewInstruction', () => {
  it('lists each thread as path:line — author: comment, with its link', () => {
    const text = prReviewInstruction([OUTDATED_README, OPEN_APP_42], 12)
    expect(text).toBe(
      [
        'Address the 2 unresolved review comments on pull request #12:',
        '- README.md:3 (outdated: the line has changed since) — dave: Old wording',
        '  ↳ erin: Agreed, fix it',
        '  https://github.com/acme/app/pull/12#discussion_r4',
        '- src/app.ts:42 — alice: Please rename this.',
        '  https://github.com/acme/app/pull/12#discussion_PRRT_a',
        'For each, make the change it asks for, or tell me why not. Do not reply on GitHub or resolve the threads.'
      ].join('\n')
    )
  })

  it('indents a multi-line comment under its item and reads back in the record', () => {
    const multi = thread({
      id: 'PRRT_m',
      comments: [{ id: 'm', author: 'bob', body: 'First line\n- not a new item\n\nlast', createdAt: null, url: null }]
    })
    const text = prReviewInstruction([multi], 9)
    expect(text.split('\n').slice(0, 5)).toEqual([
      'Address the review comment on pull request #9:',
      '- src/app.ts:10 — bob: First line',
      '  - not a new item',
      '',
      '  last'
    ])
    expect(followUpOrigin(text)).toEqual({
      kind: 'prReview',
      icon: 'chat',
      ask: 'Address the review comment on #9',
      about: 'src/app.ts:10'
    })
    expect(followUpOrigin(prReviewInstruction([OUTDATED_README, OPEN_APP_42], 12))).toMatchObject({
      ask: 'Address 2 review comments on #12',
      about: 'README.md:3\nsrc/app.ts:42'
    })
    // Edited before sending: your own words now.
    expect(followUpOrigin(`${text} Also add a test.`)).toBeNull()
  })
})

function renderGroup(props: Partial<Parameters<typeof PrReviewThreads>[0]> = {}) {
  const handlers = {
    onOpenLocation: vi.fn(),
    onHandToAgent: vi.fn(),
    onOpenExternal: vi.fn(),
    onResultChange: vi.fn(),
    onNotice: vi.fn()
  }
  render(
    <PrReviewThreads
      result={result(ALL)}
      loading={false}
      error={null}
      prNumber={12}
      workspacePath="/ws"
      {...handlers}
      {...props}
    />
  )
  return handlers
}

describe('PrReviewThreads', () => {
  it('hides resolved threads behind a count until asked', () => {
    renderGroup()
    expect(document.querySelector('[data-review-thread="PRRT_c"]')).toBeNull()
    expect(screen.getByText('3 unresolved')).toBeTruthy()
    const toggle = screen.getByRole('button', { name: /1 resolved/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    const row = document.querySelector('[data-review-thread="PRRT_c"]') as HTMLElement
    expect(row).toBeTruthy()
    expect(row.getAttribute('data-thread-state')).toBe('resolved')
    // State is a word and an icon, never hue alone.
    expect(within(row).getByText('Resolved')).toBeTruthy()
    expect(within(row).queryByRole('button', { name: 'Hand to the agent' })).toBeNull()
    expect(screen.getByRole('button', { name: /Hide resolved/ })).toBeTruthy()
  })

  it('labels an outdated thread and counts its replies', () => {
    renderGroup()
    const row = document.querySelector('[data-review-thread="PRRT_d"]') as HTMLElement
    expect(row.getAttribute('data-thread-state')).toBe('outdated')
    expect(within(row).getByText('Outdated')).toBeTruthy()
    expect(within(row).getByText('1 reply')).toBeTruthy()
    // An outdated thread opens where it was made.
    fireEvent.click(within(row).getByRole('button', { name: 'Open README.md at line 3' }))
  })

  it('opens the file at the thread’s line', () => {
    const { onOpenLocation } = renderGroup()
    const row = document.querySelector('[data-review-thread="PRRT_a"]') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Open app.ts at line 42' }))
    expect(onOpenLocation).toHaveBeenCalledWith('src/app.ts', 42)
  })

  it('hands one thread, or every unresolved one, to the agent', () => {
    const { onHandToAgent } = renderGroup()
    const row = document.querySelector('[data-review-thread="PRRT_a"]') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Hand to the agent' }))
    expect(onHandToAgent).toHaveBeenLastCalledWith(prReviewInstruction([OPEN_APP_42], 12))
    fireEvent.click(screen.getByRole('button', { name: 'Address all unresolved' }))
    const sent = onHandToAgent.mock.calls.at(-1)![0] as string
    expect(sent.startsWith('Address the 3 unresolved review comments on pull request #12:')).toBe(true)
    expect(sent).not.toContain('Typo here')
  })

  it('resolves through the bridge and reports the new state', async () => {
    const prReviewThreadResolve = vi
      .fn()
      .mockResolvedValue({ ok: true, data: { threadId: 'PRRT_a', isResolved: true } })
    Object.defineProperty(window, 'vyotiq', { configurable: true, writable: true, value: { prReviewThreadResolve } })
    const { onResultChange } = renderGroup()
    const row = document.querySelector('[data-review-thread="PRRT_a"]') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Resolve' }))
    await waitFor(() => expect(onResultChange).toHaveBeenCalled())
    expect(prReviewThreadResolve).toHaveBeenCalledWith({ workspacePath: '/ws', threadId: 'PRRT_a', resolved: true })
    const next = onResultChange.mock.calls[0]![0] as PrReviewThreadsResult
    expect(next.threads.find((t) => t.id === 'PRRT_a')).toMatchObject({ isResolved: true, viewerCanUnresolve: true })
  })

  it('posts a reply only from the explicit button', async () => {
    const prReviewThreadReply = vi.fn().mockResolvedValue({
      ok: true,
      data: { comment: { id: 'r', author: 'me', body: 'Done', createdAt: null, url: null } }
    })
    Object.defineProperty(window, 'vyotiq', { configurable: true, writable: true, value: { prReviewThreadReply } })
    const { onResultChange } = renderGroup()
    const row = document.querySelector('[data-review-thread="PRRT_a"]') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Reply' }))
    const box = within(row).getByRole('textbox', { name: 'Reply to alice' })
    fireEvent.change(box, { target: { value: 'Done' } })
    expect(prReviewThreadReply).not.toHaveBeenCalled()
    fireEvent.click(within(row).getByRole('button', { name: 'Post reply on GitHub' }))
    await waitFor(() => expect(prReviewThreadReply).toHaveBeenCalledWith({ workspacePath: '/ws', threadId: 'PRRT_a', body: 'Done' }))
    await waitFor(() => expect(onResultChange).toHaveBeenCalled())
    const next = onResultChange.mock.calls[0]![0] as PrReviewThreadsResult
    expect(next.threads.find((t) => t.id === 'PRRT_a')?.commentCount).toBe(2)
  })

  it('says when every comment is resolved', () => {
    renderGroup({ result: result([RESOLVED_APP_7]) })
    expect(screen.getByText('Every review comment is resolved.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Address all unresolved' })).toBeNull()
  })
})

const AUTHED = {
  ok: true,
  data: {
    ghAvailable: true,
    ghAuthenticated: true,
    hasAppToken: false,
    pending: false,
    userCode: null,
    verificationUri: null,
    error: null
  }
}

const PR: PrView = {
  number: 12,
  title: 'feat: things',
  url: 'https://github.com/acme/app/pull/12',
  state: 'OPEN',
  baseRefName: 'main',
  headRefName: 'feat/things',
  baseRefOid: 'aaa',
  headRefOid: 'bbb',
  body: '',
  additions: 1,
  deletions: 0,
  files: [],
  commits: [],
  checks: [],
  reviews: [],
  latestReviews: [],
  reviewDecision: '',
  reviewRequests: [],
  isDraft: false,
  mergeStateStatus: ''
}

describe('PrPanel review comments and open pull requests', () => {
  it('fetches the PR’s threads and hands one to the task', async () => {
    const prReviewThreads = vi.fn().mockResolvedValue({ ok: true, data: result([OPEN_APP_42]) })
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        prView: vi.fn().mockResolvedValue({ ok: true, data: PR }),
        prReviewThreads,
        githubAuthStatus: vi.fn().mockResolvedValue(AUTHED),
        onGithubAuthStatus: vi.fn(() => () => {}),
        shellOpenExternal: vi.fn().mockResolvedValue({ ok: true, data: true })
      }
    })
    const onHandToAgent = vi.fn()
    const onOpenFile = vi.fn()
    render(<PrPanel workspacePath="/ws" onHandToAgent={onHandToAgent} onOpenFile={onOpenFile} />)
    fireEvent.click(await screen.findByRole('tab', { name: /Reviews/ }))
    await waitFor(() => expect(prReviewThreads).toHaveBeenCalledWith('/ws', 12))
    const row = await waitFor(() => {
      const el = document.querySelector('[data-review-thread="PRRT_a"]')
      expect(el).toBeTruthy()
      return el as HTMLElement
    })
    fireEvent.click(within(row).getByRole('button', { name: 'Hand to the agent' }))
    expect(onHandToAgent).toHaveBeenCalledWith(prReviewInstruction([OPEN_APP_42], 12))
    fireEvent.click(within(row).getByRole('button', { name: 'Open app.ts at line 42' }))
    expect(onOpenFile).toHaveBeenCalledWith('src/app.ts', { line: 42 })
    // The tab counts the thread still waiting on an answer.
    expect(screen.getByRole('tab', { name: /Reviews/ }).textContent).toContain('1 open')
  })

  it('offers open pull requests to check out when the branch has none', async () => {
    const prView = vi.fn().mockResolvedValue({ ok: true, data: null })
    const prCheckout = vi.fn().mockResolvedValue({ ok: true, data: { detail: 'Checked out #7 on feat/x' } })
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        prView,
        prList: vi.fn().mockResolvedValue({
          ok: true,
          data: {
            prs: [
              {
                number: 7,
                title: 'Add the thing',
                headRefName: 'feat/x',
                author: 'alice',
                updatedAt: null,
                url: 'https://github.com/acme/app/pull/7',
                isDraft: false
              }
            ]
          }
        }),
        prCheckout,
        githubAuthStatus: vi.fn().mockResolvedValue(AUTHED),
        onGithubAuthStatus: vi.fn(() => () => {}),
        shellOpenExternal: vi.fn().mockResolvedValue({ ok: true, data: true })
      }
    })
    render(<PrPanel workspacePath="/ws" />)
    const list = await waitFor(() => {
      const el = document.querySelector('[data-pr-open-list]')
      expect(el).toBeTruthy()
      return el as HTMLElement
    })
    expect(within(list).getByText('Add the thing')).toBeTruthy()
    const callsBefore = prView.mock.calls.length
    fireEvent.click(within(list).getByRole('button', { name: 'Check out' }))
    await waitFor(() => expect(prCheckout).toHaveBeenCalledWith('/ws', 7))
    await screen.findByText('Checked out #7 on feat/x')
    // The panel reloads so the checked-out branch's PR shows.
    await waitFor(() => expect(prView.mock.calls.length).toBeGreaterThan(callsBefore))
  })

  it('will not check out while the task on screen is running', async () => {
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        prView: vi.fn().mockResolvedValue({ ok: true, data: null }),
        prList: vi.fn().mockResolvedValue({
          ok: true,
          data: {
            prs: [{ number: 7, title: 'Add', headRefName: 'feat/x', author: 'a', updatedAt: null, url: null, isDraft: false }]
          }
        }),
        prCheckout: vi.fn(),
        githubAuthStatus: vi.fn().mockResolvedValue(AUTHED),
        onGithubAuthStatus: vi.fn(() => () => {})
      }
    })
    render(<PrPanel workspacePath="/ws" running />)
    const button = await screen.findByRole('button', { name: 'Check out' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })
})
