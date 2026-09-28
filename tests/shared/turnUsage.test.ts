import { describe, expect, it } from 'vitest'
import { emptyStepUsageTotals } from '@shared/utils/runTelemetry'
import {
  turnUsageFromPersistedEvents,
  userMessageAts,
  userTurnCount,
  alignTurnUsageSlots
} from '@shared/utils/turnUsage'

describe('turnUsageFromPersistedEvents', () => {
  it('assigns step_usage to the latest user turn at or before the event time', () => {
    const slots = turnUsageFromPersistedEvents(
      [
        {
          at: '2026-08-18T10:00:05.000Z',
          event: {
            type: 'step_usage',
            runId: 'r1',
            step: 1,
            inputTokens: 100,
            outputTokens: 10,
            billedCost: 0.01
          }
        },
        {
          at: '2026-08-18T10:01:05.000Z',
          event: {
            type: 'step_usage',
            runId: 'r1',
            step: 2,
            inputTokens: 80,
            outputTokens: 8
          }
        }
      ],
      ['2026-08-18T10:00:00.000Z', '2026-08-18T10:01:00.000Z']
    )
    expect(slots).toHaveLength(2)
    expect(slots[0]?.billedInputTokens).toBe(100)
    expect(slots[0]?.billedCost).toBe(0.01)
    expect(slots[0]?.stepsWithCostReport).toBe(1)
    expect(slots[1]?.billedInputTokens).toBe(80)
    expect(slots[1]?.stepsWithCostReport).toBe(0)
  })

  it('omits $ when a turn is missing a cost report', () => {
    const slots = turnUsageFromPersistedEvents(
      [
        {
          at: '2026-08-18T10:00:05.000Z',
          event: {
            type: 'step_usage',
            runId: 'r1',
            step: 1,
            inputTokens: 100,
            outputTokens: 10
          }
        }
      ],
      ['2026-08-18T10:00:00.000Z']
    )
    expect(slots[0]?.steps).toBe(1)
    expect(slots[0]?.stepsWithCostReport).toBe(0)
  })
})

describe('userMessageAts', () => {
  it('keeps only user timestamps in order', () => {
    expect(
      userMessageAts([
        { role: 'user', at: 'a' },
        { role: 'assistant', at: 'b' },
        { role: 'user' }
      ])
    ).toEqual(['a', undefined])
  })

  it('excludes synthetic protocol turns from slots and counts', () => {
    const messages = [
      { role: 'user', at: 'a' },
      { role: 'user', at: 'b', synthetic: true },
      { role: 'user' }
    ]
    expect(userMessageAts(messages)).toEqual(['a', undefined])
    expect(userTurnCount(messages)).toBe(2)
  })
})

describe('alignTurnUsageSlots', () => {
  it('truncates and resets the last slot', () => {
    const first = { ...emptyStepUsageTotals(), steps: 2, billedInputTokens: 50 }
    const second = { ...emptyStepUsageTotals(), steps: 1, billedInputTokens: 20 }
    const next = alignTurnUsageSlots([first, second], 1, true)
    expect(next).toHaveLength(1)
    expect(next[0]?.steps).toBe(0)
    expect(next[0]?.billedInputTokens).toBe(0)
  })
})

describe('child instance usage in the parent turn', () => {
  const usage = {
    billedInputTokens: 921_701,
    billedCachedInputTokens: 796_672,
    cacheCreationInputTokens: 0,
    outputTokens: 8_325,
    reasoningTokens: 3_298,
    steps: 21,
    stepsWithCacheReport: 21,
    billedCost: 0,
    billedCostSaved: 0,
    stepsWithCostReport: 0,
    estimatedCost: 0,
    stepsWithEstimate: 0,
    generationMs: 200_000
  }

  it("adds a finished child's usage to the turn it finished in, and leaves the parent's window alone", () => {
    const slots = turnUsageFromPersistedEvents(
      [
        {
          at: '2026-09-28T09:48:20.000Z',
          event: { type: 'step_usage', runId: 'p', step: 1, inputTokens: 20_000, cachedInputTokens: 0, outputTokens: 500 }
        },
        {
          at: '2026-09-28T09:49:32.000Z',
          event: { type: 'agent_instance_update', runId: 'p', parentRunId: 'p', instanceRunId: 'c', phase: 'started', usage }
        },
        {
          at: '2026-09-28T09:53:51.000Z',
          event: { type: 'agent_instance_update', runId: 'p', parentRunId: 'p', instanceRunId: 'c', phase: 'done', usage }
        }
      ],
      ['2026-09-28T09:48:00.000Z']
    )
    // Counted once — the started update carries no final usage to add.
    expect(slots[0]!.billedInputTokens).toBe(20_000 + 921_701)
    expect(slots[0]!.outputTokens).toBe(500 + 8_325)
    expect(slots[0]!.steps).toBe(22)
    // The context meter's figures stay the parent's.
    expect(slots[0]!.inputTokens).toBe(20_000)
    expect(slots[0]!.peakInputTokens).toBe(20_000)
  })
})
