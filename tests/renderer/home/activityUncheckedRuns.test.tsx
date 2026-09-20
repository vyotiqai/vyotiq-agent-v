/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ActivitySection } from '@renderer/features/home/components/ActivitySection'
import type { HomeActivityResult } from '@shared/ipc'

afterEach(cleanup)

function result(attention?: HomeActivityResult['attention']): HomeActivityResult {
  return {
    days: [],
    activeDays: 0,
    windowDays: 7,
    outcomes: { done: 4, error: 0, cancelled: 0, running: 0 },
    // Non-zero: the section short-circuits to an empty state at 0 runs, and a
    // window with unchecked runs necessarily has runs in it.
    totals: { runs: 4, billedInputTokens: 100, outputTokens: 50 },
    ...(attention ? { attention } : {})
  }
}

function renderSection(attention?: HomeActivityResult['attention']): void {
  render(
    <ActivitySection
      data={result(attention)}
      loading={false}
      error={null}
      windowDays={7}
      onWindowChange={vi.fn()}
      onRetry={vi.fn()}
    />
  )
}

describe('ActivitySection unchecked runs', () => {
  it('surfaces the gate fire count so the rate can actually be read', () => {
    // The whole point of the observe-only phase: the number has to be legible
    // somewhere, or there is nothing to decide arming the gate on.
    renderSection({ unverifiedRuns: 3, topTools: [] })

    expect(screen.getByText('Unchecked runs')).toBeTruthy()
    expect(screen.getByText('3')).toBeTruthy()
    expect(screen.getByText(/^runs changed files with no passing check/)).toBeTruthy()
  })

  it('says "run" for a single one', () => {
    renderSection({ unverifiedRuns: 1, topTools: [] })

    expect(screen.getByText(/^run changed files with no passing check/)).toBeTruthy()
  })

  it('shows nothing when no run went unchecked', () => {
    renderSection({ unverifiedRuns: 0, topTools: [{ name: 'edit', ok: 2, failed: 1 }] })

    expect(screen.queryByText('Unchecked runs')).toBeNull()
    // The sibling attention signal still renders, so the section is live.
    expect(screen.getByText('Tool failures')).toBeTruthy()
  })

  it('shows nothing when receipts reported no attention block at all', () => {
    renderSection()

    expect(screen.queryByText('Unchecked runs')).toBeNull()
  })
})
