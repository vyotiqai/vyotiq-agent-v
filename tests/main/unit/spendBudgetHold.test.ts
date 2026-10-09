import { describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import type { HomeActivityResult } from '@shared/ipc'

vi.mock('electron', () => ({
  app: { getPath: () => join(tmpdir(), 'vyotiq-budget-hold-test'), isPackaged: false }
}))

import { budgetHoldReason, checkSpendBudget, readBudgetStatus, type SpendBudgetDeps } from '@main/agent/spendBudget'

function activity(billedCost: number): HomeActivityResult {
  return {
    days: [],
    outcomes: { done: 0, error: 0, cancelled: 0, running: 0 },
    totals: { runs: 1, billedInputTokens: 0, outputTokens: 0, billedCost, estimatedCost: 0 },
    generatedAt: new Date().toISOString()
  }
}

type State = Record<string, string | number>
function deps(budget: { dailyUsd: number; monthlyUsd: number; holdAtBudget?: boolean }, state: State = {}) {
  const box = { state }
  return {
    collect: vi.fn(async (_p: readonly string[], _n: Date, windowDays: number) => (windowDays === 1 ? activity(12) : activity(40))),
    publish: vi.fn(),
    readState: () => ({ ...box.state }),
    writeState: (s: State) => {
      box.state = s
    },
    workspacePaths: () => ['C:\\ws'],
    budget: () => budget,
    box
  } as unknown as SpendBudgetDeps & { box: { state: State } }
}

const NOW = new Date(2026, 9, 8, 15, 0, 0)

describe('Hold new work at the budget', () => {
  it('holds nothing while the switch is off, whatever was spent', () => {
    expect(budgetHoldReason(NOW, deps({ dailyUsd: 10, monthlyUsd: 0 }, { day: '2026-10-08', dayLimit: 10 }))).toBeNull()
  })

  it('holds new work for the rest of a day whose budget was reached, and says how to go on', () => {
    const reason = budgetHoldReason(NOW, deps({ dailyUsd: 10, monthlyUsd: 0, holdAtBudget: true }, { day: '2026-10-08', dayLimit: 10 }))
    expect(reason).toMatch(/daily budget of \$10\.00 is spent/)
    expect(reason).toMatch(/until tomorrow/)
    expect(reason).toMatch(/Settings › Agent/)
    // The next day starts clear.
    expect(budgetHoldReason(new Date(2026, 9, 9, 9), deps({ dailyUsd: 10, monthlyUsd: 0, holdAtBudget: true }, { day: '2026-10-08', dayLimit: 10 }))).toBeNull()
  })

  it('lets work through once the budget is raised past the one it was reached at, and checks the new one', async () => {
    const d = deps({ dailyUsd: 20, monthlyUsd: 0, holdAtBudget: true }, { day: '2026-10-08', dayNear: '2026-10-08', dayLimit: 10 })
    expect(budgetHoldReason(NOW, d)).toBeNull()
    // $12 of the new $20: not reached, and the 80% heads-up was already spent today.
    expect(await checkSpendBudget(NOW, d)).toEqual([])
    expect(d.collect).toHaveBeenCalledWith(['C:\\ws'], NOW, 1)
  })

  it('says new work waits in the notice when holding', async () => {
    const d = deps({ dailyUsd: 10, monthlyUsd: 0, holdAtBudget: true })
    expect(await checkSpendBudget(NOW, d)).toEqual(['day'])
    expect(d.publish).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringMatching(/new work waits/) }))
    expect(d.box.state).toMatchObject({ day: '2026-10-08', dayLimit: 10 })
    expect(budgetHoldReason(NOW, d)).toMatch(/daily budget/)
  })
})

describe('readBudgetStatus', () => {
  it('reports each set budget against its period, and the hold', async () => {
    const d = deps({ dailyUsd: 10, monthlyUsd: 0, holdAtBudget: true }, { day: '2026-10-08', dayLimit: 10 })
    const status = await readBudgetStatus(NOW, d)
    expect(status.day).toEqual({ spentUsd: 12, limitUsd: 10 })
    expect(status.month).toBeNull()
    expect(status.held).toMatch(/daily budget/)
  })
})
