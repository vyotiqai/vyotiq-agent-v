/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { UsagePage } from '@renderer/features/usage/UsagePage'
import type { HomeActivityResult } from '@shared/ipc'

const ALPHA = 'C:\\repo-alpha'
const BETA = 'C:\\repo-beta'

const today = new Date()
const dayKey = (offset: number): string => {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function result(overrides: Partial<HomeActivityResult> = {}): HomeActivityResult {
  return {
    days: [
      { date: dayKey(0), runs: 4, billedInputTokens: 500_000, outputTokens: 200_000, billedCost: 2.5, byModel: { 'deepseek-v4.1-flash': 150_000 } },
      { date: dayKey(3), runs: 5, billedInputTokens: 400_000, outputTokens: 140_000, billedCost: 1.71, byModel: { 'claude-sonnet-5': 50_000 } }
    ],
    activeDays: 2,
    windowDays: 7,
    outcomes: { done: 6, error: 2, cancelled: 0, running: 1 },
    attention: {
      unverifiedRuns: 2,
      topTools: [{ name: 'terminal', ok: 200, failed: 4 }],
      toolCalls: 1240,
      failingTools: [
        { name: 'terminal', ok: 208, failed: 4, reason: 'Timed out after 5 min' },
        { name: 'list_dir', ok: 16, failed: 1 }
      ],
      uncheckedRuns: [
        { runId: 'fade', workspacePath: ALPHA, goal: '**Fade** rows under the pinned prompt', files: 3 },
        { runId: 'repair', workspacePath: BETA, files: 1 }
      ]
    },
    totals: { runs: 9, billedInputTokens: 900_000, outputTokens: 340_000, billedCost: 4.21, previousRuns: 6 },
    generatedAt: new Date().toISOString(),
    ...overrides
  }
}

let homeActivity = vi.fn()
const onOpenTask = vi.fn()

beforeEach(() => {
  onOpenTask.mockClear()
  homeActivity = vi.fn(async (payload: { windowDays: number }) => ({
    ok: true as const,
    data: result({ windowDays: payload.windowDays })
  }))
  window.vyotiq = { homeActivity: (payload: unknown) => homeActivity(payload) } as unknown as typeof window.vyotiq
})

afterEach(() => cleanup())

function renderUsage() {
  return render(<UsagePage openWorkspaces={[ALPHA, BETA]} onOpenTask={onOpenTask} />)
}

const section = (name: string): HTMLElement => screen.getByRole('region', { name })

describe('Usage', () => {
  it('leads with four numbers, each with what it is measured against', async () => {
    renderUsage()
    await screen.findByText('Spend per day')
    const page = document.querySelector('[data-usage]') as HTMLElement
    expect(page.textContent).toContain('Tasks9+50% vs the 7 days before')
    expect(page.textContent).toContain('Tokens1.2M900K in · 340K out')
    expect(page.textContent).toContain('Spend$4.21$0.468 a task')
    expect(page.textContent).toContain('Finished75%2 failed · 1 running')
  })

  it('marks spend as an estimate when some tasks had no cost, and averages over the ones that did', async () => {
    homeActivity = vi.fn(async () => ({
      ok: true as const,
      data: result({ totals: { runs: 9, billedInputTokens: 900_000, outputTokens: 340_000, billedCost: 4.21, pricedRuns: 6 } })
    }))
    renderUsage()
    await screen.findByText('Spend per day')
    const page = document.querySelector('[data-usage]') as HTMLElement
    expect(page.textContent).toContain('Spend$4.21 est.$0.702 a task with a cost')
    expect(page.querySelector('[title^="Estimated total — 3 of 9 tasks have no measurable cost"]')).toBeTruthy()
  })

  it('says how much of the prompt came from cache when the window can tell', async () => {
    homeActivity = vi.fn(async (payload: { windowDays: number }) => ({
      ok: true as const,
      data: result({
        windowDays: payload.windowDays,
        totals: { runs: 9, billedInputTokens: 900_000, outputTokens: 340_000, cachedInputTokens: 640_000, cacheShare: 0.712, billedCost: 4.21 }
      })
    }))
    renderUsage()
    await screen.findByText('Spend per day')
    const page = document.querySelector('[data-usage]') as HTMLElement
    expect(page.textContent).toContain('Tokens1.2M71% from cache')
  })

  it('draws one chart by day, spend first, with a switch to tokens and tasks', async () => {
    renderUsage()
    const spend = await screen.findByRole('region', { name: 'Spend per day' })
    expect(spend.textContent).toContain('total $4.21')
    const bars = spend.querySelectorAll('[data-day-bar]')
    expect(bars).toHaveLength(7)
    expect(bars[6]!.classList.contains('bg-accent')).toBe(true)
    expect(bars[5]!.classList.contains('bg-border')).toBe(true)
    expect(within(spend).getByRole('img').getAttribute('aria-label')).toMatch(/^Spend per day, total \$4\.21: /)
    // Each day's tooltip carries all three measures, whichever is drawn.
    expect(spend.querySelector('[title$="4 tasks · 700K tokens · $2.50"]')).toBeTruthy()

    fireEvent.click(within(spend).getByRole('radio', { name: 'Tokens' }))
    expect(screen.getByRole('region', { name: 'Tokens per day' }).textContent).toContain('total 1.2M')

    fireEvent.click(screen.getByRole('radio', { name: 'Tasks' }))
    const tasks = screen.getByRole('region', { name: 'Tasks per day' })
    expect(tasks.textContent).toContain('peak 5')
    expect(within(tasks).getByRole('img').textContent).toContain('4')
    expect(screen.queryByRole('region', { name: 'Spend per day' })).toBeNull()
  })

  it('adds a day’s estimate to its bill, says est., and draws unpriced days apart from quiet ones', async () => {
    homeActivity = vi.fn(async () => ({
      ok: true as const,
      data: result({
        days: [
          { date: dayKey(0), runs: 2, billedInputTokens: 100_000, outputTokens: 10_000, billedCost: 1, estimatedCost: 2, byModel: {} },
          { date: dayKey(2), runs: 1, billedInputTokens: 50_000, outputTokens: 5_000, byModel: {} }
        ],
        totals: { runs: 3, billedInputTokens: 150_000, outputTokens: 15_000, billedCost: 1, estimatedCost: 2, pricedRuns: 2 }
      })
    }))
    renderUsage()
    const spend = await screen.findByRole('region', { name: 'Spend per day' })
    expect(spend.textContent).toContain('total $3.00 est.')
    expect(spend.querySelector('[title$="· $3.00 est."]')).toBeTruthy()
    const bars = [...spend.querySelectorAll('[data-day-bar]')]
    // Two days back ran a task nobody priced; the days around it ran nothing.
    expect(bars.map((bar) => bar.hasAttribute('data-day-unpriced'))).toEqual([false, false, false, false, true, false, false])
    expect(spend.querySelector('[title$="no cost reported"]')).toBeTruthy()
  })

  it('opens on tasks when no cost was reported, and says so on spend', async () => {
    homeActivity = vi.fn(async () => ({
      ok: true as const,
      data: result({
        days: [{ date: dayKey(0), runs: 3, billedInputTokens: 0, outputTokens: 0, byModel: {} }],
        totals: { runs: 3, billedInputTokens: 0, outputTokens: 0 }
      })
    }))
    renderUsage()
    const tasks = await screen.findByRole('region', { name: 'Tasks per day' })
    expect(tasks.textContent).toContain('peak 3')
    fireEvent.click(within(tasks).getByRole('radio', { name: 'Spend' }))
    expect(screen.getByRole('region', { name: 'Spend per day' }).textContent).toContain(
      'No provider reported a cost in these days.'
    )
  })

  it('names the models, the failing tools with their reason, and the unchecked tasks', async () => {
    renderUsage()
    const mix = await screen.findByRole('region', { name: 'Model mix' })
    expect(mix.textContent).toContain('deepseek-v4.1-flash75%')
    expect(mix.textContent).toContain('claude-sonnet-525%')

    const tools = section('Tool failures')
    expect(tools.textContent).toContain('of 1,240 calls')
    expect(tools.textContent).toContain('terminalTimed out after 5 min4 of 212')
    expect(tools.textContent).toContain('list_dir1 of 17')

    const unchecked = section('Unchecked')
    expect(unchecked.textContent).toContain('Worth a test run before you commit.')
    fireEvent.click(within(unchecked).getByRole('button', { name: /^Fade rows under the pinned prompt/ }))
    expect(onOpenTask).toHaveBeenCalledWith(ALPHA, 'fade')
    expect(within(unchecked).getByRole('button', { name: /^Untitled task/ }).textContent).toContain('1 file')
  })

  it('reads again for thirty days, or for one workspace', async () => {
    renderUsage()
    await screen.findByText('Spend per day')
    expect(homeActivity).toHaveBeenLastCalledWith({ workspacePaths: [ALPHA, BETA], windowDays: 7, breakdown: true })

    fireEvent.click(screen.getByRole('radio', { name: '30 days' }))
    await waitFor(() =>
      expect(homeActivity).toHaveBeenLastCalledWith({ workspacePaths: [ALPHA, BETA], windowDays: 30, breakdown: true })
    )

    fireEvent.click(screen.getByRole('button', { name: 'Workspaces' }))
    fireEvent.click(await screen.findByRole('option', { name: 'repo-beta' }))
    await waitFor(() =>
      expect(homeActivity).toHaveBeenLastCalledWith({ workspacePaths: [BETA], windowDays: 30, breakdown: true })
    )

    fireEvent.click(screen.getByRole('radio', { name: '90 days' }))
    await waitFor(() =>
      expect(homeActivity).toHaveBeenLastCalledWith({ workspacePaths: [BETA], windowDays: 90, breakdown: true })
    )
  })

  it('reads a custom range by its last day, and refuses one that runs backwards or past a year', async () => {
    renderUsage()
    await screen.findByText('Spend per day')
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }))
    const from = screen.getByLabelText('From') as HTMLInputElement
    const to = screen.getByLabelText('To') as HTMLInputElement
    // Opens on the last thirty days, ending today.
    expect(from.value).toBe(dayKey(29))
    expect(to.value).toBe(dayKey(0))
    await waitFor(() =>
      expect(homeActivity).toHaveBeenLastCalledWith({ workspacePaths: [ALPHA, BETA], windowDays: 30, breakdown: true })
    )

    fireEvent.change(from, { target: { value: dayKey(20) } })
    fireEvent.change(to, { target: { value: dayKey(11) } })
    await waitFor(() =>
      expect(homeActivity).toHaveBeenLastCalledWith({
        workspacePaths: [ALPHA, BETA],
        windowDays: 10,
        endDay: dayKey(11),
        breakdown: true
      })
    )

    const calls = homeActivity.mock.calls.length
    fireEvent.change(from, { target: { value: dayKey(5) } })
    expect(screen.getByRole('alert').textContent).toBe('The start is after the end.')
    fireEvent.change(from, { target: { value: dayKey(400) } })
    expect(screen.getByRole('alert').textContent).toBe('A range can span at most 365 days.')
    // An unreadable pair keeps the last good range on screen rather than reading again.
    expect(homeActivity.mock.calls.length).toBe(calls)
  })

  it('groups spend under each workspace, costliest first, and opens a task from its row', async () => {
    homeActivity = vi.fn(async () => ({
      ok: true as const,
      data: result({
        workspaces: [
          { path: ALPHA, runs: 2, billedInputTokens: 300_000, outputTokens: 100_000, billedCost: 1 },
          { path: BETA, runs: 1, billedInputTokens: 600_000, outputTokens: 240_000, billedCost: 3, estimatedCost: 0.21 }
        ],
        tasks: [
          { runId: 'b1', workspacePath: BETA, goal: 'Port the **updater**', model: 'claude-sonnet-5', days: 2, billedInputTokens: 600_000, outputTokens: 240_000, billedCost: 3, estimatedCost: 0.21 },
          { runId: 'a1', workspacePath: ALPHA, goal: 'Fix lint', days: 1, billedInputTokens: 200_000, outputTokens: 60_000, billedCost: 1 },
          { runId: 'a2', workspacePath: ALPHA, days: 1, billedInputTokens: 100_000, outputTokens: 40_000 }
        ]
      })
    }))
    renderUsage()
    const where = await screen.findByRole('region', { name: 'Where it went' })
    const groups = within(where).getAllByRole('group')
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['repo-beta', 'repo-alpha'])
    expect(groups[0]!.textContent).toContain('repo-beta1 task840K$3.21 est.')
    expect(groups[0]!.textContent).toContain('Port the updaterclaude-sonnet-5840K$3.21 est.')
    // A task nobody priced says so instead of $0.
    expect(groups[1]!.querySelector('[data-usage-task="a2"]')!.textContent).toBe('Untitled task140K—')
    fireEvent.click(within(groups[1]!).getByRole('button', { name: /Fix lint/ }))
    expect(onOpenTask).toHaveBeenCalledWith(ALPHA, 'a1')
  })

  it('exports the same window as CSV through main', async () => {
    const usageExportCsv = vi.fn(async () => ({ ok: true as const, data: { saved: true, path: 'C:\\u.csv', rows: 12 } }))
    window.vyotiq = {
      homeActivity: (payload: unknown) => homeActivity(payload),
      usageExportCsv
    } as unknown as typeof window.vyotiq
    renderUsage()
    await screen.findByText('Spend per day')
    fireEvent.click(screen.getByRole('radio', { name: '30 days' }))
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))
    await waitFor(() => expect(usageExportCsv).toHaveBeenCalledWith({ workspacePaths: [ALPHA, BETA], windowDays: 30 }))
  })

  it('says when there were no tasks, and when the receipts could not be read', async () => {
    homeActivity = vi.fn(async () => ({
      ok: true as const,
      data: result({ days: [], totals: { runs: 0, billedInputTokens: 0, outputTokens: 0 }, attention: undefined })
    }))
    const { unmount } = renderUsage()
    expect(await screen.findByText('No tasks in the last 7 days')).toBeTruthy()
    unmount()

    homeActivity = vi.fn(async () => ({ ok: false as const, error: 'EACCES' }))
    renderUsage()
    expect(await screen.findByText('Usage couldn’t be read')).toBeTruthy()
    homeActivity.mockResolvedValueOnce({ ok: true as const, data: result() })
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Spend per day')).toBeTruthy()
  })
})
