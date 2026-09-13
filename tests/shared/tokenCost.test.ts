import { describe, expect, it } from 'vitest'
import {
  classifyTokenCostHotspot,
  countKeptToolResultChars,
  evaluateTokenCostWarnings,
  isAdvisoryTokenCostHint,
  stepCacheHitRate,
  billedCacheHitRate,
  nextLowerThinkingEffort,
  pushRecentLargeCacheHit,
  rollingMean,
  shouldShowTaskBoundaryTip,
  shouldSuggestLowerThinkingEffort,
  topToolsByCallCount,
  userFacingTokenCostHint,
  type TokenCostWarnKind
} from '../../src/shared/utils/tokenCost'

describe('tokenCost', () => {
  it('classifies history as hotspot when it dominates', () => {
    expect(
      classifyTokenCostHotspot({ system: 4_000, history: 80_000, tools: 13_000, buffer: 0 })
    ).toBe('history')
  })

  it('returns balanced when layers are close', () => {
    expect(
      classifyTokenCostHotspot({ system: 10_000, history: 11_000, tools: 10_500, buffer: 0 })
    ).toBe('balanced')
  })

  it('computes step cache hit rate only when reported', () => {
    expect(stepCacheHitRate(100_000, 2_500, false)).toBeNull()
    expect(stepCacheHitRate(100_000, 2_500, true)).toBeCloseTo(0.025)
  })

  it('computes billed cache hit rate', () => {
    expect(billedCacheHitRate(6_000_000, 170_000)).toBeCloseTo(170_000 / 6_000_000)
    expect(billedCacheHitRate(0, 10)).toBeNull()
  })

  it('warns on low cache only after a rolling window of large steps', () => {
    const base = {
      estimatedTokens: 40_000,
      compactionTrigger: 64_000,
      contentWindow: 850_000,
      compactedThisRun: false,
      cacheHitRate: 0,
      stepsWithCacheReport: 10,
      largeInput: true,
      thinkingEnabled: false,
      thinkingEffortHigh: false,
      step: 10
    }
    // One large miss must not warn when the rolling window is still short.
    expect(
      evaluateTokenCostWarnings({
        ...base,
        recentLargeStepCacheHitRates: [0]
      }).some((w) => w.kind === 'low_cache_hit_rate')
    ).toBe(false)
    // Sustained low hits across the window warn.
    expect(
      evaluateTokenCostWarnings({
        ...base,
        recentLargeStepCacheHitRates: [0, 0.05, 0, 0.02, 0.01]
      }).some((w) => w.kind === 'low_cache_hit_rate')
    ).toBe(true)
    // High rolling mean does not warn even if the latest sample is 0.
    expect(
      evaluateTokenCostWarnings({
        ...base,
        cacheHitRate: 0,
        recentLargeStepCacheHitRates: [0.9, 0.85, 0.8, 0.75, 0]
      }).some((w) => w.kind === 'low_cache_hit_rate')
    ).toBe(false)
    // Empty rolling window suppresses the legacy single-step false positive.
    expect(
      evaluateTokenCostWarnings({
        ...base,
        recentLargeStepCacheHitRates: []
      }).some((w) => w.kind === 'low_cache_hit_rate')
    ).toBe(false)
  })

  it('pushRecentLargeCacheHit keeps a bounded window', () => {
    const w: number[] = []
    pushRecentLargeCacheHit(w, 0.1)
    pushRecentLargeCacheHit(w, 0.2)
    pushRecentLargeCacheHit(w, 0.3)
    pushRecentLargeCacheHit(w, 0.4)
    pushRecentLargeCacheHit(w, 0.5)
    pushRecentLargeCacheHit(w, 0.6)
    expect(w).toEqual([0.2, 0.3, 0.4, 0.5, 0.6])
    expect(rollingMean(w)).toBeCloseTo(0.4)
  })

  it('warns when context stays above soft trigger after compaction', () => {
    const warns = evaluateTokenCostWarnings({
      estimatedTokens: 100_000,
      compactionTrigger: 64_000,
      contentWindow: 850_000,
      compactedThisRun: true,
      cacheHitRate: null,
      stepsWithCacheReport: 0,
      largeInput: true,
      thinkingEnabled: false,
      thinkingEffortHigh: false,
      step: 5
    })
    expect(warns.some((w) => w.kind === 'context_above_soft_trigger')).toBe(true)
  })

  it('counts kept tool result chars and skips stubs', () => {
    const n = countKeptToolResultChars([
      { role: 'tool', content: 'hello world' },
      { role: 'tool', content: '[cleared]' },
      { role: 'user', content: 'ignore' }
    ])
    expect(n).toBe(11)
  })

  it('ranks top tools by call count', () => {
    expect(
      topToolsByCallCount(
        {
          read: { ok: 10, failed: 1 },
          grep: { ok: 3, failed: 0 },
          shell: { ok: 0, failed: 0 },
          write: { ok: 5, failed: 2 }
        },
        2
      )
    ).toEqual([
      { name: 'read', calls: 11 },
      { name: 'write', calls: 7 }
    ])
  })

  it('suppresses user-facing /clear tips — auto + menu compact own continuity', () => {
    expect(userFacingTokenCostHint('high_thinking_on_long_run', 12)).toBeNull()
    expect(userFacingTokenCostHint('context_above_soft_trigger')).toBeNull()
    expect(userFacingTokenCostHint('long_run_task_boundary', 40)).toBeNull()
    expect(userFacingTokenCostHint('low_cache_hit_rate')).toBeNull()
    expect(userFacingTokenCostHint('high_context_watermark')).toBeNull()
  })

  it('marks all current token-cost hint kinds as advisory (not runNotice)', () => {
    const kinds: TokenCostWarnKind[] = [
      'long_run_task_boundary',
      'high_thinking_on_long_run',
      'high_context_watermark',
      'context_above_soft_trigger',
      'low_cache_hit_rate'
    ]
    for (const kind of kinds) {
      expect(isAdvisoryTokenCostHint(kind)).toBe(true)
    }
  })

  it('warns on long-run task boundary by step or billed input', () => {
    const byStep = evaluateTokenCostWarnings({
      estimatedTokens: 20_000,
      compactionTrigger: 64_000,
      contentWindow: 850_000,
      compactedThisRun: false,
      cacheHitRate: null,
      stepsWithCacheReport: 0,
      largeInput: false,
      thinkingEnabled: false,
      thinkingEffortHigh: false,
      step: 40,
      billedInputTokens: 100_000
    })
    expect(byStep.some((w) => w.kind === 'long_run_task_boundary')).toBe(true)

    const byBilled = evaluateTokenCostWarnings({
      estimatedTokens: 20_000,
      compactionTrigger: 64_000,
      contentWindow: 850_000,
      compactedThisRun: false,
      cacheHitRate: null,
      stepsWithCacheReport: 0,
      largeInput: false,
      thinkingEnabled: false,
      thinkingEffortHigh: false,
      step: 5,
      billedInputTokens: 1_000_000
    })
    expect(byBilled.some((w) => w.kind === 'long_run_task_boundary')).toBe(true)

    const quiet = evaluateTokenCostWarnings({
      estimatedTokens: 20_000,
      compactionTrigger: 64_000,
      contentWindow: 850_000,
      compactedThisRun: false,
      cacheHitRate: null,
      stepsWithCacheReport: 0,
      largeInput: false,
      thinkingEnabled: false,
      thinkingEffortHigh: false,
      step: 5,
      billedInputTokens: 10_000
    })
    expect(quiet.some((w) => w.kind === 'long_run_task_boundary')).toBe(false)
  })

  it('suppresses ContextMeter task-boundary /clear tip', () => {
    expect(shouldShowTaskBoundaryTip({ steps: 39, billedInputTokens: 999_999 })).toBe(false)
    expect(shouldShowTaskBoundaryTip({ steps: 40, billedInputTokens: 0 })).toBe(false)
    expect(shouldShowTaskBoundaryTip({ steps: 1, billedInputTokens: 1_000_000 })).toBe(false)
  })

  it('suggests lower thinking only for high effort on long runs (never auto)', () => {
    expect(
      shouldSuggestLowerThinkingEffort({
        thinkingEnabled: true,
        thinkingEffort: 'high',
        steps: 9
      })
    ).toBe(false)
    expect(
      shouldSuggestLowerThinkingEffort({
        thinkingEnabled: true,
        thinkingEffort: 'high',
        steps: 10
      })
    ).toBe(true)
    expect(
      shouldSuggestLowerThinkingEffort({
        thinkingEnabled: true,
        thinkingEffort: 'medium',
        steps: 20
      })
    ).toBe(false)
    expect(
      shouldSuggestLowerThinkingEffort({
        thinkingEnabled: true,
        thinkingEffort: 'max',
        steps: 12,
        thinkingMode: 'boolean'
      })
    ).toBe(false)
  })

  it('steps nextLowerThinkingEffort within allowed set without inventing Off', () => {
    expect(nextLowerThinkingEffort('max')).toBe('xhigh')
    expect(nextLowerThinkingEffort('high', ['low', 'medium', 'high'])).toBe('medium')
    expect(nextLowerThinkingEffort('low', ['low', 'medium', 'high'])).toBeNull()
    expect(nextLowerThinkingEffort('xhigh', ['low', 'high'])).toBe('high')
  })
})
