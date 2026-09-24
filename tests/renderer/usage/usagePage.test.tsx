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
    await screen.findByText('Tasks per day')
    const page = document.querySelector('[data-usage]') as HTMLElement
    expect(page.textContent).toContain('Tasks9+50% vs the 7 days before')
    expect(page.textContent).toContain('Tokens1.2M900K in · 340K out')
    expect(page.textContent).toContain('Spend$4.21$0.468 a task')
    expect(page.textContent).toContain('Finished75%2 failed · 1 running')
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
    await screen.findByText('Tasks per day')
    const page = document.querySelector('[data-usage]') as HTMLElement
    expect(page.textContent).toContain('Tokens1.2M71% from cache')
  })

  it('draws a bar per day with today in the accent, and spend as a line', async () => {
    renderUsage()
    const perDay = within(await screen.findByRole('region', { name: 'Tasks per day' })).getByRole('img')
    const bars = perDay.querySelectorAll('div.w-full.rounded-sm')
    expect(bars).toHaveLength(7)
    expect(bars[6]!.classList.contains('bg-accent')).toBe(true)
    expect(perDay.textContent).toContain('4')
    expect(section('Tasks per day').textContent).toContain('peak 5')

    const spend = section('Spend per day')
    expect(spend.textContent).toContain('total $4.21')
    expect(within(spend).getByRole('img', { name: 'Spend per day, total $4.21' })).toBeTruthy()
    fireEvent.click(within(spend).getByRole('radio', { name: 'Tokens' }))
    expect(screen.getByRole('region', { name: 'Tokens per day' }).textContent).toContain('total 1.2M')
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
    await screen.findByText('Tasks per day')
    expect(homeActivity).toHaveBeenLastCalledWith({ workspacePaths: [ALPHA, BETA], windowDays: 7 })

    fireEvent.click(screen.getByRole('radio', { name: '30 days' }))
    await waitFor(() => expect(homeActivity).toHaveBeenLastCalledWith({ workspacePaths: [ALPHA, BETA], windowDays: 30 }))

    fireEvent.click(screen.getByRole('button', { name: 'Workspaces' }))
    fireEvent.click(await screen.findByRole('option', { name: 'repo-beta' }))
    await waitFor(() => expect(homeActivity).toHaveBeenLastCalledWith({ workspacePaths: [BETA], windowDays: 30 }))
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
    expect(await screen.findByText('Tasks per day')).toBeTruthy()
  })
})
