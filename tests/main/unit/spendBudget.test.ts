import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { HomeActivityResult } from '@shared/ipc'

vi.mock('electron', () => ({
  app: { getPath: () => join(tmpdir(), 'vyotiq-budget-test'), isPackaged: false }
}))

import { checkSpendBudget, workspacePathsWithStorage, type SpendBudgetDeps } from '@main/agent/spendBudget'

function activity(billedCost: number, estimatedCost = 0): HomeActivityResult {
  return {
    days: [],
    outcomes: { done: 0, error: 0, cancelled: 0, running: 0 },
    totals: { runs: 1, billedInputTokens: 0, outputTokens: 0, billedCost, estimatedCost },
    generatedAt: new Date().toISOString()
  }
}

function deps(over: Partial<SpendBudgetDeps> = {}): SpendBudgetDeps & { state: { day?: string; month?: string } } {
  const box: { state: { day?: string; month?: string } } = { state: {} }
  return {
    collect: vi.fn(async (_p, _n, windowDays: number) => (windowDays === 1 ? activity(8, 3) : activity(40))),
    publish: vi.fn(),
    readState: () => ({ ...box.state }),
    writeState: (s) => {
      box.state = s
    },
    workspacePaths: () => ['C:\\ws'],
    budget: () => ({ dailyUsd: 10, monthlyUsd: 100 }),
    get state() {
      return box.state
    },
    ...over
  } as SpendBudgetDeps & { state: { day?: string; month?: string } }
}

const NOW = new Date(2026, 9, 8, 15, 0, 0)

describe('checkSpendBudget', () => {
  it('posts a notice once a day when billed plus estimated spend reaches the daily budget', async () => {
    const d = deps()
    expect(await checkSpendBudget(NOW, d)).toEqual(['day'])
    expect(d.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'budget',
        title: 'Daily budget reached',
        dedupeKey: 'budget:day:2026-10-08',
        action: { type: 'open_usage' }
      })
    )
    // The same day again: already noticed, nothing re-read.
    vi.mocked(d.collect).mockClear()
    expect(await checkSpendBudget(NOW, d)).toEqual([])
    expect(d.collect).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), 1)
  })

  it('reads the month to date for the monthly budget', async () => {
    const d = deps({ budget: () => ({ dailyUsd: 0, monthlyUsd: 30 }) })
    expect(await checkSpendBudget(NOW, d)).toEqual(['month'])
    // October 8th: an eight-day window ending today.
    expect(d.collect).toHaveBeenCalledWith(['C:\\ws'], NOW, 8)
    // Past the limit, the heads-up is spent too: it never follows the notice.
    expect(d.state).toEqual({ month: '2026-10', monthNear: '2026-10', monthLimit: 30 })
  })

  it('gives a heads-up at 80%, once, then the notice at 100%', async () => {
    // $11 of a $13 day is 84%.
    const d = deps({ budget: () => ({ dailyUsd: 13, monthlyUsd: 0 }) })
    expect(await checkSpendBudget(NOW, d)).toEqual(['dayNear'])
    expect(d.publish).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Daily budget at 84%', dedupeKey: 'budget:day:2026-10-08:near' })
    )
    expect(await checkSpendBudget(NOW, d)).toEqual([])
    vi.mocked(d.collect).mockResolvedValue(activity(13))
    expect(await checkSpendBudget(NOW, d)).toEqual(['day'])
  })

  it('does nothing with both budgets off, or below them', async () => {
    const off = deps({ budget: () => ({ dailyUsd: 0, monthlyUsd: 0 }) })
    expect(await checkSpendBudget(NOW, off)).toEqual([])
    expect(off.collect).not.toHaveBeenCalled()
    const under = deps({ budget: () => ({ dailyUsd: 50, monthlyUsd: 500 }) })
    expect(await checkSpendBudget(NOW, under)).toEqual([])
    expect(under.publish).not.toHaveBeenCalled()
  })
})

describe('workspacePathsWithStorage', () => {
  const root = join(tmpdir(), 'vyotiq-budget-test', 'workspaces')
  afterEach(() => rmSync(join(tmpdir(), 'vyotiq-budget-test'), { recursive: true, force: true }))

  it('counts a closed workspace that has stored spend, not only the open ones', () => {
    // Closing a workspace you spent in today took its spend out of "across tasks".
    for (const [id, path] of [['a', 'C:\\open'], ['b', 'C:\\closed']] as const) {
      mkdirSync(join(root, id), { recursive: true })
      writeFileSync(join(root, id, 'meta.json'), JSON.stringify({ workspaceId: id, canonicalPath: path }), 'utf8')
    }
    mkdirSync(join(root, 'no-meta'), { recursive: true })
    expect(workspacePathsWithStorage(['C:\\open']).sort()).toEqual(['C:\\closed', 'C:\\open'])
  })

  it('falls back to the open workspaces when there is no store yet', () => {
    expect(workspacePathsWithStorage(['C:\\open'])).toEqual(['C:\\open'])
  })
})
