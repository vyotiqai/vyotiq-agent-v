/**
 * Freeze-style regression invariants from docs/research/token-cost-jun-aug-2026
 * (hard content-window compaction trigger + cumulative billed Σ semantics).
 * Do not weaken these without an explicit product decision.
 */
import { describe, expect, it } from 'vitest'
import {
  compactionTriggerFromRaw,
  contentWindowFromRaw,
  toolsBudgetFromRaw
} from '../../src/shared/domain/contextBudget'
import {
  mergeStepUsageTotals,
  stepUsageFromEvent,
  stepUsageTotalsFromPersistedEvents
} from '../../src/shared/utils/runTelemetry'

describe('token-cost freeze invariants', () => {
  it('keeps 1M-window compaction trigger at the hard content window', () => {
    const trigger = compactionTriggerFromRaw(1_000_000)
    expect(trigger).toBe(contentWindowFromRaw(1_000_000))
    expect(trigger).toBe(850_000)
  })

  it('keeps tools budget as raw window share on huge windows', () => {
    expect(toolsBudgetFromRaw(1_000_000)).toBe(180_000)
  })

  it('treats billed input as Σ step inputs, not latest window', () => {
    // Shape from AppData: many ~30–45k steps → multi-million billed, peak ≪ billed.
    const steps = [30_000, 42_000, 47_049, 40_000, 35_000]
    let totals = stepUsageFromEvent({
      type: 'step_usage',
      runId: 'freeze',
      step: 1,
      inputTokens: steps[0],
      outputTokens: 100
    })!
    for (let i = 1; i < steps.length; i++) {
      const next = stepUsageFromEvent({
        type: 'step_usage',
        runId: 'freeze',
        step: i + 1,
        inputTokens: steps[i],
        outputTokens: 50
      })!
      totals = mergeStepUsageTotals(totals, next)
    }
    const sum = steps.reduce((a, b) => a + b, 0)
    expect(totals.billedInputTokens).toBe(sum)
    expect(totals.peakInputTokens).toBe(47_049)
    expect(totals.inputTokens).toBe(35_000)
    expect(totals.peakInputTokens).toBeLessThan(totals.billedInputTokens)
  })

  it('rebuilds billed Σ from durable inputTokens and ignores carried billed fields', () => {
    const totals = stepUsageTotalsFromPersistedEvents([
      {
        event: {
          type: 'step_usage',
          runId: 'r',
          step: 1,
          inputTokens: 47_049,
          billedInputTokens: 9_999_999
        }
      },
      {
        event: {
          type: 'step_usage',
          runId: 'r',
          step: 2,
          inputTokens: 40_000,
          billedInputTokens: 1
        }
      }
    ])
    expect(totals.billedInputTokens).toBe(87_049)
    expect(totals.peakInputTokens).toBe(47_049)
  })
})
