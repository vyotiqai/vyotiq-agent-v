/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SpendPerDay } from '@renderer/features/home/components/ActivityCharts'
import type { HomeActivityDay } from '@shared/ipc'

const TODAY = new Date().toISOString().slice(0, 10)

function day(extra: Partial<HomeActivityDay> = {}): HomeActivityDay {
  return { date: TODAY, runs: 2, billedInputTokens: 100, outputTokens: 50, ...extra }
}

afterEach(cleanup)

describe('SpendPerDay', () => {
  it('defaults to tokens and never invents a $0.00 when the window has no cost', () => {
    render(<SpendPerDay days={[day()]} windowDays={7} />)
    expect(screen.getByText('Tokens per day')).toBeTruthy()
    expect(screen.getByText('total 150')).toBeTruthy()
    expect(screen.queryByText(/total \$0\.00/)).toBeNull()
    expect(screen.queryByText('No provider-reported cost in this window.')).toBeNull()
  })

  it('defaults to cost and prints the dollar total when providers reported one', () => {
    render(<SpendPerDay days={[day({ billedCost: 4.21 })]} windowDays={7} />)
    expect(screen.getByText('Spend per day')).toBeTruthy()
    expect(screen.getByText('total $4.21')).toBeTruthy()
    expect(
      screen.getByRole('img', { name: 'Spend per day over the last 7 days, total $4.21' })
    ).toBeTruthy()
  })

  it('shows the tile dash instead of a fake zero when cost is picked without data', () => {
    render(<SpendPerDay days={[day()]} windowDays={7} />)
    fireEvent.click(screen.getByRole('button', { name: 'cost' }))
    expect(screen.getByText('Spend per day')).toBeTruthy()
    expect(screen.getByText('—')).toBeTruthy()
    expect(screen.getByText('No provider-reported cost in this window.')).toBeTruthy()
    expect(screen.queryByText(/total \$0\.00/)).toBeNull()
  })

  it('stays honest for an entirely empty window', () => {
    render(<SpendPerDay days={[]} windowDays={7} />)
    expect(screen.getByText('Tokens per day')).toBeTruthy()
    expect(screen.getByText('—')).toBeTruthy()
    expect(screen.getByText('No token usage recorded in this window.')).toBeTruthy()
    expect(screen.queryByText(/total 0/)).toBeNull()
  })
})
