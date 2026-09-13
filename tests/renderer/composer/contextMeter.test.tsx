/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import {
  ContextMeter,
  cacheHitPct
} from '@renderer/features/chat/components/composer/ContextMeter'
import type { ContextUsageState } from '@shared/utils/contextUsage'

const baseUsage: ContextUsageState = {
  step: 3,
  used: 45000,
  estimatedTokens: 44000,
  inputTokens: 45000,
  window: 128000,
  contentWindow: 89600,
  compactionTrigger: 62720,
  source: 'provider',
  layers: { system: 5000, history: 32000, tools: 7000, buffer: 19200 },
  stepUsage: {
    inputTokens: 45000,
    billedInputTokens: 120000,
    peakInputTokens: 45000,
    outputTokens: 1200,
    cachedInputTokens: 20000,
    billedCachedInputTokens: 50000,
    cacheCreationInputTokens: 0,
    reasoningTokens: 0,
    steps: 3,
    stepsWithCacheReport: 3,
    billedCost: 0,
    billedCostSaved: 0,
    stepsWithCostReport: 0,
    generationMs: 0
  },
  updatedAt: '2026-01-01T12:00:00.000Z'
}

describe('ContextMeter', () => {
  it('opens a context details popover on click', () => {
    render(<ContextMeter usage={baseUsage} />)

    const trigger = screen.getByRole('button', { name: /context window 50% full/i })
    expect(trigger.getAttribute('aria-label')).toContain('50%')

    fireEvent.click(trigger)

    expect(screen.getByRole('dialog', { name: /context details/i })).toBeTruthy()
    expect(screen.getByText(/^Context$/)).toBeTruthy()
    expect(screen.getByText(/used of/)).toBeTruthy()
    expect(screen.getAllByText(/45k/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(/90k/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/^Breakdown$/)).toBeTruthy()
    expect(screen.getByText(/^This run$/)).toBeTruthy()
    expect(screen.getByText(/^Completed steps$/)).toBeTruthy()
    expect(screen.getByText(/Auto-compact at 63k/i)).toBeTruthy()
    expect(screen.getByText(/Current step 3/)).toBeTruthy()
    expect(screen.queryByText(/^Telemetry$/i)).toBeNull()
    expect(screen.queryByText(/^Layers$/i)).toBeNull()
  })

  it('shows cache write in run stats when creation tokens are present', () => {
    render(
      <ContextMeter
        usage={{
          ...baseUsage,
          stepUsage: {
            ...baseUsage.stepUsage,
            cachedInputTokens: 0,
            cacheCreationInputTokens: 8000
          }
        }}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /context/i }))
    expect(screen.getByText(/^Cache write$/)).toBeTruthy()
    expect(screen.getByText(/^8k$/)).toBeTruthy()
  })

  it('notes estimated source in the panel subtitle', () => {
    render(
      <ContextMeter
        usage={{
          ...baseUsage,
          estimatedTokens: 5600,
          inputTokens: 5600,
          used: 5600,
          source: 'estimate'
        }}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /context/i }))
    expect(screen.getByText(/estimated/i)).toBeTruthy()
  })

  it('shows task-boundary tip without warning chrome on the trigger', () => {
    render(
      <ContextMeter
        usage={{
          ...baseUsage,
          used: 70_451,
          contentWindow: 850_000,
          window: 1_000_000,
          stepUsage: {
            ...baseUsage.stepUsage,
            steps: 49,
            inputTokens: 70_451,
            billedInputTokens: 2_313_786,
            cachedInputTokens: 69_632,
            billedCachedInputTokens: 2_183_936
          }
        }}
      />
    )
    const trigger = screen.getByRole('button', { name: /context/i })
    expect(trigger.className).not.toMatch(/bg-warning/)
    expect(trigger.getAttribute('aria-label')).toMatch(/Long-run tip available/i)
    expect(trigger.getAttribute('aria-label')).toMatch(/70k/)
    fireEvent.click(trigger)
    expect(screen.getByText(/Long run — \/clear/i)).toBeTruthy()
  })

  it('surfaces overage when used exceeds the content budget', () => {
    render(
      <ContextMeter
        usage={{
          ...baseUsage,
          used: 909_000,
          contentWindow: 850_000,
          window: 1_000_000,
          stepUsage: {
            ...baseUsage.stepUsage,
            cachedInputTokens: 0,
            cacheCreationInputTokens: 0
          }
        }}
      />
    )
    const trigger = screen.getByRole('button', { name: /context/i })
    expect(trigger.className).toMatch(/text-danger|bg-danger/)
    expect(trigger.getAttribute('aria-label')).toMatch(/107%/)
    fireEvent.click(trigger)
    expect(screen.getByText(/over budget/i)).toBeTruthy()
  })

  it('shows content-budget headroom aligned with used of budget', () => {
    render(
      <ContextMeter
        usage={{
          ...baseUsage,
          used: 10_000,
          inputTokens: 10_000,
          window: 1_000_000,
          contentWindow: 850_000,
          compactionTrigger: 170_000,
          layers: { system: 2400, history: 4300, tools: 3500, buffer: 840_000 },
          stepUsage: {
            ...baseUsage.stepUsage,
            steps: 3,
            inputTokens: 10_000,
            billedInputTokens: 27_000,
            peakInputTokens: 10_000
          }
        }}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /context/i }))
    expect(screen.getByText(/used of/)).toBeTruthy()
    expect(screen.getAllByText(/10k/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(/850k/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/840k headroom/i)).toBeTruthy()
    expect(screen.queryByText(/990k headroom/i)).toBeNull()
  })

  it('renders compact action when handler is provided', () => {
    render(
      <ContextMeter
        usage={baseUsage}
        onCompact={async () => ({ ok: true, message: 'Done' })}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /context/i }))
    expect(screen.getByRole('button', { name: /compact history/i })).toBeTruthy()
  })
})

describe('cacheHitPct', () => {
  it('returns null without a hit', () => {
    expect(
      cacheHitPct({
        inputTokens: 1000,
        billedInputTokens: 1000,
        peakInputTokens: 1000,
        outputTokens: 0,
        cachedInputTokens: 0,
        billedCachedInputTokens: 0,
        cacheCreationInputTokens: 100,
        reasoningTokens: 0,
        steps: 1,
        stepsWithCacheReport: 1,
        billedCost: 0,
        billedCostSaved: 0,
        stepsWithCostReport: 0,
        generationMs: 0
      })
    ).toBeNull()
  })

  it('rounds hit share of input', () => {
    expect(
      cacheHitPct({
        inputTokens: 45000,
        billedInputTokens: 45000,
        peakInputTokens: 45000,
        outputTokens: 0,
        cachedInputTokens: 20000,
        billedCachedInputTokens: 20000,
        cacheCreationInputTokens: 0,
        reasoningTokens: 0,
        steps: 1,
        stepsWithCacheReport: 1,
        billedCost: 0,
        billedCostSaved: 0,
        stepsWithCostReport: 0,
        generationMs: 0
      })
    ).toBe(44)
  })
})
