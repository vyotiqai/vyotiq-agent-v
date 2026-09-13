/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TurnSummary } from '@renderer/features/chat/components/TurnSummary'

describe('TurnSummary', () => {
  it('suppresses phase label when live tools own the detail', () => {
    render(
      <TurnSummary
        span={{
          startedAt: Date.now() - 500,
          endedAt: null,
          active: true,
          activity: { kind: 'tool', label: 'Reading', detail: 'file.ts' }
        }}
        collapsed={false}
        suppressPhaseLabel
        onToggle={() => undefined}
      />
    )

    expect(screen.queryByText('Reading')).toBeNull()
    expect(screen.queryByText(/file\.ts/)).toBeNull()
    expect(screen.getByRole('button', { name: /^Collapse turn work$/i })).toBeTruthy()
  })

  it('shows phase shimmer when collapsed during a live turn', () => {
    render(
      <TurnSummary
        span={{
          startedAt: Date.now() - 500,
          endedAt: null,
          active: true,
          activity: { kind: 'tool', label: 'Reading', detail: 'file.ts' }
        }}
        collapsed
        suppressPhaseLabel
        onToggle={() => undefined}
      />
    )

    expect(screen.getByText('Reading file.ts')).toBeTruthy()
  })

  it('shows a completed status without repeating elapsed on a finished turn', () => {
    render(
      <TurnSummary
        span={{
          startedAt: Date.parse('2026-08-18T10:00:00.000Z'),
          endedAt: Date.parse('2026-08-18T10:00:09.000Z'),
          active: false
        }}
        collapsed={false}
        onToggle={() => undefined}
      />
    )

    expect(screen.getByText('Completed')).toBeTruthy()
    expect(screen.queryByText(/Completed for/)).toBeNull()
    expect(screen.queryByText('9s')).toBeNull()
  })

  it('appends verified tokens on the live Working line without inventing $', () => {
    render(
      <TurnSummary
        span={{
          startedAt: Date.parse('2026-08-18T10:00:00.000Z'),
          endedAt: null,
          active: true,
          activity: { kind: 'working' }
        }}
        collapsed={false}
        onToggle={() => undefined}
        usage={{
          inputTokens: 200,
          billedInputTokens: 200,
          peakInputTokens: 200,
          outputTokens: 40,
          cachedInputTokens: 0,
          billedCachedInputTokens: 0,
          cacheCreationInputTokens: 0,
          reasoningTokens: 0,
          steps: 1,
          stepsWithCacheReport: 0,
          billedCost: 0,
          billedCostSaved: 0,
          stepsWithCostReport: 0,
          generationMs: 2500
        }}
      />
    )

    expect(screen.getByText('Working')).toBeTruthy()
    expect(screen.getByText(/tok/)).toBeTruthy()
    expect(screen.getByText(/16 output tok\/s/)).toBeTruthy()
    expect(screen.queryByText(/\$/)).toBeNull()
  })

  it('keeps duration and tokens on Completed when there is no answer footer', () => {
    render(
      <TurnSummary
        span={{
          startedAt: Date.parse('2026-08-18T10:00:00.000Z'),
          endedAt: Date.parse('2026-08-18T10:00:09.000Z'),
          active: false
        }}
        collapsed={false}
        onToggle={() => undefined}
        usage={{
          inputTokens: 200,
          billedInputTokens: 200,
          peakInputTokens: 200,
          outputTokens: 40,
          cachedInputTokens: 0,
          billedCachedInputTokens: 0,
          cacheCreationInputTokens: 0,
          reasoningTokens: 0,
          steps: 1,
          stepsWithCacheReport: 0,
          billedCost: 0,
          billedCostSaved: 0,
          stepsWithCostReport: 0,
          generationMs: 2500
        }}
      />
    )

    expect(screen.getByText(/Completed/)).toBeTruthy()
    expect(screen.getByText(/9s/)).toBeTruthy()
    expect(screen.getByText(/tok/)).toBeTruthy()
    expect(screen.queryByText(/\$/)).toBeNull()
  })

  it('shows cancellation instead of completion and omits partial usage', () => {
    render(
      <TurnSummary
        span={{
          startedAt: Date.parse('2026-08-18T10:00:00.000Z'),
          endedAt: Date.parse('2026-08-18T10:00:09.000Z'),
          active: false,
          status: 'cancelled'
        }}
        collapsed={false}
        onToggle={() => undefined}
        usage={{
          inputTokens: 200,
          billedInputTokens: 200,
          peakInputTokens: 200,
          outputTokens: 40,
          cachedInputTokens: 0,
          billedCachedInputTokens: 0,
          cacheCreationInputTokens: 0,
          reasoningTokens: 0,
          steps: 1,
          stepsWithCacheReport: 0,
          billedCost: 0,
          billedCostSaved: 0,
          stepsWithCostReport: 0,
          generationMs: 2500
        }}
      />
    )

    expect(screen.getByText(/Cancelled/)).toBeTruthy()
    expect(screen.queryByText(/Completed/)).toBeNull()
    expect(screen.queryByText(/tok/)).toBeNull()
    expect(screen.getByRole('button', { name: /Cancelled · 9s/i })).toBeTruthy()
  })
})
