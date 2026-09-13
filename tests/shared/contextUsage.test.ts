import { describe, expect, it } from 'vitest'
import {
  contextUsageFromEvent,
  summarizeContextUsageFromEvents,
  alignContextUsageToModelWindow,
  reconcileContextLayers
} from '@shared/utils/contextUsage'

describe('contextUsage', () => {
  it('maps context_usage events into UI state', () => {
    const state = contextUsageFromEvent({
      type: 'context_usage',
      runId: 'r1',
      step: 2,
      estimatedTokens: 1200,
      inputTokens: 1100,
      contextWindow: 128000,
      contentWindow: 89600,
      compactionTrigger: 62720,
      source: 'provider',
      layers: { system: 100, history: 900, tools: 200, buffer: 19200 }
    })
    expect(state).toMatchObject({
      step: 2,
      used: 1100,
      estimatedTokens: 1200,
      window: 128000,
      contentWindow: 89600,
      source: 'provider'
    })
  })

  it('reuses prior estimate layers when provider context_usage omits them', () => {
    const prior = { system: 100, history: 900, tools: 200, buffer: 19200 }
    const state = contextUsageFromEvent(
      {
        type: 'context_usage',
        runId: 'r1',
        step: 2,
        estimatedTokens: 1200,
        inputTokens: 1100,
        contextWindow: 128000,
        contentWindow: 89600,
        compactionTrigger: 62720,
        source: 'provider'
      },
      undefined,
      prior
    )
    expect(state?.layers.system).toBe(100)
    expect(state?.layers.tools).toBe(200)
    expect(state?.layers.history).toBe(800)
    expect(state?.layers.buffer).toBe(89600 - 1100)
    expect(state?.source).toBe('provider')
    expect(state?.used).toBe(1100)
  })

  it('keeps prior layers when estimate context_usage omits them', () => {
    const prior = { system: 100, history: 900, tools: 200, buffer: 19200 }
    const state = contextUsageFromEvent(
      {
        type: 'context_usage',
        runId: 'r1',
        step: 2,
        estimatedTokens: 1200,
        contextWindow: 128000,
        contentWindow: 89600,
        compactionTrigger: 62720,
        source: 'estimate'
      },
      undefined,
      prior
    )
    expect(state?.layers.system).toBe(100)
    expect(state?.layers.history).toBe(900)
    expect(state?.layers.tools).toBe(200)
    expect(state?.layers.buffer).toBe(89600 - 1200)
    expect(state?.source).toBe('estimate')
  })

  it('replays the latest context_usage from persisted events', () => {
    const state = summarizeContextUsageFromEvents([
      {
        at: '2026-01-01T00:00:00.000Z',
        event: {
          type: 'context_usage',
          runId: 'r1',
          step: 1,
          estimatedTokens: 800,
          contextWindow: 32000,
          compactionTrigger: 20000,
          source: 'estimate',
          layers: { system: 50, history: 600, tools: 150, buffer: 4800 }
        }
      },
      {
        at: '2026-01-01T00:00:10.000Z',
        event: {
          type: 'step_usage',
          runId: 'r1',
          step: 1,
          inputTokens: 900,
          outputTokens: 40,
          cachedInputTokens: 300
        }
      },
      {
        at: '2026-01-01T00:00:20.000Z',
        event: {
          type: 'context_usage',
          runId: 'r1',
          step: 1,
          estimatedTokens: 800,
          inputTokens: 900,
          contextWindow: 32000,
          contentWindow: 22400,
          compactionTrigger: 15680,
          source: 'provider',
          layers: { system: 50, history: 600, tools: 150, buffer: 4800 }
        }
      }
    ])
    expect(state?.used).toBe(900)
    expect(state?.updatedAt).toBe('2026-01-01T00:00:20.000Z')
    expect(state?.stepUsage.outputTokens).toBe(40)
    expect(state?.stepUsage.cachedInputTokens).toBe(300)
  })

  it('keeps prior estimate layers when provider events omit them during replay', () => {
    const state = summarizeContextUsageFromEvents([
      {
        at: '2026-01-01T00:00:00.000Z',
        event: {
          type: 'context_usage',
          runId: 'r1',
          step: 1,
          estimatedTokens: 800,
          contextWindow: 32000,
          compactionTrigger: 20000,
          source: 'estimate',
          layers: { system: 50, history: 600, tools: 150, buffer: 4800 }
        }
      },
      {
        at: '2026-01-01T00:00:20.000Z',
        event: {
          type: 'context_usage',
          runId: 'r1',
          step: 1,
          estimatedTokens: 800,
          inputTokens: 900,
          contextWindow: 32000,
          contentWindow: 22400,
          compactionTrigger: 15680,
          source: 'provider'
        }
      }
    ])
    expect(state?.used).toBe(900)
    expect(state?.source).toBe('provider')
    expect(state?.layers.system).toBe(50)
    expect(state?.layers.tools).toBe(150)
    expect(state?.layers.history).toBe(700)
    expect(state?.layers.buffer).toBe(22400 - 900)
  })

  it('reconciles provider totals into history and content-budget headroom', () => {
    const layers = reconcileContextLayers(
      { system: 2300, history: 1000, tools: 3500, buffer: 0 },
      7000,
      1_000_000,
      850_000
    )
    expect(layers.system).toBe(2300)
    expect(layers.tools).toBe(3500)
    expect(layers.history).toBe(1200)
    expect(layers.buffer).toBe(843_000)
    expect(layers.system + layers.history + layers.tools).toBe(7000)
  })

  it('realigns stale 128k events to the real model window', () => {
    const stale = contextUsageFromEvent({
      type: 'context_usage',
      runId: 'r1',
      step: 1,
      estimatedTokens: 9000,
      inputTokens: 9000,
      contextWindow: 128000,
      contentWindow: 89600,
      compactionTrigger: 62720,
      source: 'estimate',
      layers: { system: 2000, history: 3000, tools: 4000, buffer: 19200 }
    })
    expect(stale).toBeTruthy()
    const aligned = alignContextUsageToModelWindow(stale!, 1_000_000)
    expect(aligned.window).toBe(1_000_000)
    expect(aligned.contentWindow).toBe(850_000)
    expect(aligned.compactionTrigger).toBe(595_000)
    expect(aligned.layers.buffer).toBe(841_000)
    expect(aligned.used).toBe(9000)
    expect(aligned.layers.system).toBe(2000)
  })
})
