/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { checksPendingCount, PrPanel } from '@renderer/features/chat/components/PrPanel'
import type { PrView } from '@shared/ipc'

function prWith(checks: PrView['checks'], overrides: Partial<PrView> = {}): PrView {
  return {
    number: 10,
    title: 'feat: watch ci',
    url: 'https://github.com/ex/repo/pull/10',
    state: 'OPEN',
    baseRefName: 'main',
    headRefName: 'feat/ci',
    baseRefOid: 'aaa',
    headRefOid: 'bbb',
    body: '',
    additions: 1,
    deletions: 0,
    files: [],
    commits: [],
    checks,
    reviews: [],
    latestReviews: [],
    reviewDecision: '',
    reviewRequests: [],
    isDraft: false,
    ...overrides
  }
}

describe('checksPendingCount', () => {
  it('counts CheckRun statuses that have not finished', () => {
    const pr = prWith([
      { name: 'build', state: 'QUEUED', conclusion: null },
      { name: 'test', state: 'IN_PROGRESS', conclusion: null }
    ])
    expect(checksPendingCount(pr)).toBe(2)
  })

  it('counts StatusContext PENDING and EXPECTED', () => {
    const pr = prWith([
      { name: 'legacy', state: 'PENDING', conclusion: null },
      { name: 'required', state: 'EXPECTED', conclusion: null }
    ])
    expect(checksPendingCount(pr)).toBe(2)
  })

  it('treats any reported conclusion as settled, including failures', () => {
    const pr = prWith([
      { name: 'build', state: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'test', state: 'COMPLETED', conclusion: 'FAILURE' },
      { name: 'lint', state: 'COMPLETED', conclusion: 'SKIPPED' },
      // A conclusion that arrives while the state still reads IN_PROGRESS is
      // still a finished run.
      { name: 'odd', state: 'IN_PROGRESS', conclusion: 'CANCELLED' }
    ])
    expect(checksPendingCount(pr)).toBe(0)
  })

  it('treats an unrecognized state as settled so the poller cannot run forever', () => {
    const pr = prWith([
      { name: 'weird', state: 'UNKNOWN', conclusion: null },
      { name: 'other', state: 'COMPLETED', conclusion: null }
    ])
    expect(checksPendingCount(pr)).toBe(0)
  })

  it('reports zero for a PR with no checks', () => {
    expect(checksPendingCount(prWith([]))).toBe(0)
  })
})

describe('PrPanel watches CI while checks are in flight', () => {
  let prView: ReturnType<typeof vi.fn>

  beforeEach(() => {
    prView = vi.fn()
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        prView,
        githubAuthStatus: vi.fn().mockResolvedValue({
          ok: true,
          data: { ghAvailable: true, ghAuthenticated: true, hasAppToken: false, pending: false }
        }),
        onGithubAuthStatus: vi.fn(() => () => {})
      }
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  /**
   * Fake timers go in before render: the poll interval is created during the
   * first load, and a real interval scheduled earlier would ignore
   * advanceTimersByTime entirely.
   */
  async function renderAndSettle(data: PrView) {
    prView.mockResolvedValue({ ok: true, data })
    vi.useFakeTimers()
    render(<PrPanel workspacePath="/ws" />)
    await act(async () => {
      for (let i = 0; i < 20; i += 1) await Promise.resolve()
    })
    expect(prView).toHaveBeenCalled()
  }

  async function advance(ms: number) {
    await act(async () => {
      vi.advanceTimersByTime(ms)
      for (let i = 0; i < 20; i += 1) await Promise.resolve()
    })
  }

  it('re-asks gh while a check is still running', async () => {
    await renderAndSettle(prWith([{ name: 'build', state: 'IN_PROGRESS', conclusion: null }]))
    const initial = prView.mock.calls.length

    await advance(15_000)
    expect(prView.mock.calls.length).toBeGreaterThan(initial)
  })

  it('does not poll once every check has settled', async () => {
    await renderAndSettle(prWith([{ name: 'build', state: 'COMPLETED', conclusion: 'SUCCESS' }]))
    const initial = prView.mock.calls.length

    await advance(60_000)
    expect(prView.mock.calls.length).toBe(initial)
  })

  it('does not poll a merged PR even with a stuck check', async () => {
    await renderAndSettle(
      prWith([{ name: 'build', state: 'IN_PROGRESS', conclusion: null }], { state: 'MERGED' })
    )
    const initial = prView.mock.calls.length

    await advance(60_000)
    expect(prView.mock.calls.length).toBe(initial)
  })

  it('does not poll a closed PR', async () => {
    await renderAndSettle(
      prWith([{ name: 'build', state: 'QUEUED', conclusion: null }], { state: 'CLOSED' })
    )
    const initial = prView.mock.calls.length

    await advance(60_000)
    expect(prView.mock.calls.length).toBe(initial)
  })

  it('skips the tick while the window is hidden', async () => {
    await renderAndSettle(prWith([{ name: 'build', state: 'QUEUED', conclusion: null }]))
    const initial = prView.mock.calls.length

    const spy = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden' as DocumentVisibilityState)
    await advance(45_000)
    expect(prView.mock.calls.length).toBe(initial)
    spy.mockRestore()
  })
})
