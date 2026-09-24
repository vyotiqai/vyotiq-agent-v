import { describe, expect, it } from 'vitest'
import {
  emptyStepUsageTotals,
  mergeStepUsageTotals,
  stepUsageFromEvent,
  stepUsageTotalsFromPersistedEvents
} from '@shared/utils/runTelemetry'

describe('runTelemetry', () => {
  it('returns null for events that carry no step usage', () => {
    expect(stepUsageFromEvent({ type: 'status', runId: 'r1', status: 'running' })).toBeNull()
  })

  it('keeps the latest input window, sums billed input, and sums output across steps', () => {
    const first = stepUsageFromEvent({
      type: 'step_usage',
      runId: 'r1',
      step: 1,
      inputTokens: 500,
      outputTokens: 20,
      cachedInputTokens: 400,
      reasoningTokens: 12
    })
    const second = stepUsageFromEvent({
      type: 'step_usage',
      runId: 'r1',
      step: 2,
      inputTokens: 300,
      outputTokens: 10,
      cachedInputTokens: 200,
      reasoningTokens: 4
    })
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(mergeStepUsageTotals(first!, second!)).toEqual({
      inputTokens: 300,
      billedInputTokens: 800,
      peakInputTokens: 500,
      outputTokens: 30,
      cachedInputTokens: 200,
      billedCachedInputTokens: 600,
      // No provider flag: input is the whole prompt (promptTokensFromUsage).
      billedPromptTokens: 800,
      cacheCreationInputTokens: 0,
      reasoningTokens: 16,
      steps: 2,
      stepsWithCacheReport: 2,
      billedCost: 0,
      billedCostSaved: 0,
      stepsWithCostReport: 0,
      estimatedCost: 0,
      stepsWithEstimate: 0,
      generationMs: 0
    })
  })

  it('accumulates cache write tokens across steps', () => {
    const first = stepUsageFromEvent({
      type: 'step_usage',
      runId: 'r1',
      step: 1,
      inputTokens: 500,
      outputTokens: 20,
      cacheCreationInputTokens: 400
    })
    const second = stepUsageFromEvent({
      type: 'step_usage',
      runId: 'r1',
      step: 2,
      inputTokens: 300,
      outputTokens: 10,
      cachedInputTokens: 280,
      cacheCreationInputTokens: 50
    })
    expect(mergeStepUsageTotals(first!, second!)).toMatchObject({
      cachedInputTokens: 280,
      cacheCreationInputTokens: 450,
      billedInputTokens: 800,
      steps: 2
    })
  })

  it('carries the previous input window forward when a step reports none', () => {
    const totals = mergeStepUsageTotals(
      {
        inputTokens: 900,
        billedInputTokens: 900,
        peakInputTokens: 900,
        outputTokens: 5,
        cachedInputTokens: 700,
        billedCachedInputTokens: 700,
        cacheCreationInputTokens: 100,
        reasoningTokens: 3,
        steps: 1,
        stepsWithCacheReport: 1,
        billedCost: 0.012,
        billedCostSaved: 0.004,
        stepsWithCostReport: 1,
        estimatedCost: 0,
        stepsWithEstimate: 0,
        generationMs: 1200
      },
      {
        inputTokens: 0,
        billedInputTokens: 0,
        peakInputTokens: 0,
        outputTokens: 7,
        cachedInputTokens: 0,
        billedCachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningTokens: 2,
        steps: 1,
        stepsWithCacheReport: 0,
        billedCost: 0,
        billedCostSaved: 0,
        stepsWithCostReport: 0,
        estimatedCost: 0,
        stepsWithEstimate: 0,
        generationMs: 800
      }
    )
    expect(totals.inputTokens).toBe(900)
    expect(totals.billedInputTokens).toBe(900)
    expect(totals.cachedInputTokens).toBe(700)
    expect(totals.cacheCreationInputTokens).toBe(100)
    expect(totals.outputTokens).toBe(12)
    expect(totals.reasoningTokens).toBe(5)
    expect(totals.generationMs).toBe(2000)
  })

  it('defaults reasoning tokens to zero when the provider omits them', () => {
    const usage = stepUsageFromEvent({
      type: 'step_usage',
      runId: 'r1',
      step: 1,
      inputTokens: 100,
      outputTokens: 10
    })
    expect(usage?.reasoningTokens).toBe(0)
    expect(usage?.cacheCreationInputTokens).toBe(0)
    expect(usage?.billedInputTokens).toBe(100)
  })

  it('starts from an empty total', () => {
    expect(emptyStepUsageTotals()).toEqual({
      inputTokens: 0,
      billedInputTokens: 0,
      peakInputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      billedCachedInputTokens: 0,
      billedPromptTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningTokens: 0,
      steps: 0,
      stepsWithCacheReport: 0,
      billedCost: 0,
      billedCostSaved: 0,
      stepsWithCostReport: 0,
      estimatedCost: 0,
      stepsWithEstimate: 0,
      generationMs: 0
    })
  })

  it('rebuilds cumulative totals from persisted events without trusting process-local billed fields', () => {
    const totals = stepUsageTotalsFromPersistedEvents([
      {
        event: {
          type: 'step_usage',
          runId: 'r1',
          step: 1,
          inputTokens: 1000,
          outputTokens: 5,
          cachedInputTokens: 100,
          billedInputTokens: 1000
        }
      },
      {
        event: {
          type: 'step_usage',
          runId: 'r1',
          step: 2,
          inputTokens: 400,
          outputTokens: 3,
          cachedInputTokens: 50,
          billedInputTokens: 400
        }
      }
    ])
    expect(totals.billedInputTokens).toBe(1400)
    expect(totals.billedCachedInputTokens).toBe(150)
    expect(totals.peakInputTokens).toBe(1000)
    expect(totals.steps).toBe(2)
  })

  it('sums billed cost only from steps that reported it', () => {
    const withCost = stepUsageFromEvent({
      type: 'step_usage',
      runId: 'r1',
      step: 1,
      inputTokens: 10,
      outputTokens: 2,
      billedCost: 0.01,
      billedCostSaved: 0.004
    })
    const withoutCost = stepUsageFromEvent({
      type: 'step_usage',
      runId: 'r1',
      step: 2,
      inputTokens: 8,
      outputTokens: 1
    })
    const merged = mergeStepUsageTotals(withCost!, withoutCost!)
    expect(merged.billedCost).toBe(0.01)
    expect(merged.billedCostSaved).toBe(0.004)
    expect(merged.stepsWithCostReport).toBe(1)
    expect(merged.steps).toBe(2)
  })

  it('sums estimated cost only from steps that carry an estimate', () => {
    const withEstimate = stepUsageFromEvent({
      type: 'step_usage',
      runId: 'r1',
      step: 1,
      inputTokens: 10,
      outputTokens: 2,
      estimatedCost: 0.0035
    })
    const withoutEstimate = stepUsageFromEvent({
      type: 'step_usage',
      runId: 'r1',
      step: 2,
      inputTokens: 8,
      outputTokens: 1,
      billedCost: 0.01
    })
    const merged = mergeStepUsageTotals(withEstimate!, withoutEstimate!)
    expect(merged.estimatedCost).toBe(0.0035)
    expect(merged.stepsWithEstimate).toBe(1)
    expect(merged.billedCost).toBe(0.01)
    expect(merged.stepsWithCostReport).toBe(1)
  })

  it('sums generationMs from steps that reported a stream clock', () => {
    const first = stepUsageFromEvent({
      type: 'step_usage',
      runId: 'r1',
      step: 1,
      inputTokens: 10,
      outputTokens: 20,
      generationMs: 2500
    })
    const second = stepUsageFromEvent({
      type: 'step_usage',
      runId: 'r1',
      step: 2,
      inputTokens: 8,
      outputTokens: 10,
      generationMs: 1500
    })
    expect(mergeStepUsageTotals(first!, second!).generationMs).toBe(4000)
  })
})

describe('billedPromptTokens', () => {
  it('is the whole prompt per step: Anthropic adds its cache slices, OpenAI-style input already has them', () => {
    const anthropic = stepUsageFromEvent({
      type: 'step_usage', runId: 'r', step: 1,
      inputTokens: 6, inputTokensIncludesCache: false, cachedInputTokens: 9000, cacheCreationInputTokens: 994, outputTokens: 5
    })!
    const openai = stepUsageFromEvent({
      type: 'step_usage', runId: 'r', step: 2,
      inputTokens: 10000, cachedInputTokens: 8000, outputTokens: 5
    })!
    expect(anthropic.billedPromptTokens).toBe(10000)
    expect(openai.billedPromptTokens).toBe(10000)
    const merged = mergeStepUsageTotals(mergeStepUsageTotals(emptyStepUsageTotals(), anthropic), openai)
    expect(merged.billedPromptTokens).toBe(20000)
    expect(merged.billedCachedInputTokens).toBe(17000)
  })
})
