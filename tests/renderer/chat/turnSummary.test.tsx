/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { TurnSummary } from '@renderer/features/chat/components/TurnSummary'
import type { RunActivityPhase } from '@renderer/features/chat/utils/runActivity'
import {
  RUN_VOICE_PHRASES,
  RUN_VOICE_ROTATE_MS
} from '@renderer/features/chat/utils/runVoice'

describe('TurnSummary', () => {
  it('lets a live phase take on the transcript voice as the turn runs long', async () => {
    vi.useFakeTimers()
    try {
      render(
        <TurnSummary
          span={{
            startedAt: Date.now(),
            endedAt: null,
            active: true,
            activity: { kind: 'working' }
          }}
          collapsed
          onToggle={() => undefined}
        />
      )

      // Opens plain, so a turn that ends in a beat never reads as a flourish.
      expect(screen.getByRole('button').textContent).toContain(RUN_VOICE_PHRASES.working[0])

      await act(async () => {
        vi.advanceTimersByTime(RUN_VOICE_ROTATE_MS)
      })
      expect(screen.getByRole('button').textContent).toContain(RUN_VOICE_PHRASES.working[1])

      await act(async () => {
        vi.advanceTimersByTime(RUN_VOICE_ROTATE_MS)
      })
      expect(screen.getByRole('button').textContent).toContain(RUN_VOICE_PHRASES.working[2])
    } finally {
      vi.useRealTimers()
    }
  })

  it('restarts the rotation when the phase changes, not when the turn does', async () => {
    vi.useFakeTimers()
    try {
      const startedAt = Date.now()
      const span = (activity: RunActivityPhase) =>
        ({ startedAt, endedAt: null, active: true, activity }) as const

      const { rerender } = render(
        <TurnSummary span={span({ kind: 'thinking' })} collapsed onToggle={() => undefined} />
      )

      // Three rotations into the turn, thinking has walked well past plain.
      await act(async () => {
        vi.advanceTimersByTime(RUN_VOICE_ROTATE_MS * 3)
      })
      expect(screen.getByRole('button').textContent).toContain(RUN_VOICE_PHRASES.thinking[3])

      // A different phase begins here. It is one beat old, so it must read
      // literally — anchoring to the turn would have opened it mid-pool.
      rerender(
        <TurnSummary span={span({ kind: 'writing' })} collapsed onToggle={() => undefined} />
      )
      expect(screen.getByRole('button').textContent).toContain(RUN_VOICE_PHRASES.writing[0])

      // And it rotates on its own clock from there.
      await act(async () => {
        vi.advanceTimersByTime(RUN_VOICE_ROTATE_MS)
      })
      expect(screen.getByRole('button').textContent).toContain(RUN_VOICE_PHRASES.writing[1])

      // Returning to an earlier phase restarts it too, rather than resuming.
      rerender(
        <TurnSummary span={span({ kind: 'thinking' })} collapsed onToggle={() => undefined} />
      )
      expect(screen.getByRole('button').textContent).toContain(RUN_VOICE_PHRASES.thinking[0])
    } finally {
      vi.useRealTimers()
    }
  })

  it('never voices a finished turn, whatever it ran for', () => {
    render(
      <TurnSummary
        span={{
          startedAt: Date.parse('2026-08-18T10:00:00.000Z'),
          endedAt: Date.parse('2026-08-18T10:04:00.000Z'),
          active: false,
          activity: { kind: 'working' }
        }}
        collapsed
        onToggle={() => undefined}
      />
    )

    const text = screen.getByRole('button').textContent ?? ''
    expect(text).toContain('Completed')
    for (const phrase of RUN_VOICE_PHRASES.working.slice(1)) {
      expect(text).not.toContain(phrase)
    }
  })

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

  it('appends verified tokens on the live phase line without inventing $', () => {
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

    // The live phase speaks in the transcript's voice, so assert the row opens
    // on a working phrase rather than pinning the copy to one word.
    const phase = screen.getByRole('button').textContent ?? ''
    expect(RUN_VOICE_PHRASES.working.some((phrase) => phase.startsWith(phrase))).toBe(true)
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
