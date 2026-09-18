import { describe, expect, it } from 'vitest'
import {
  contextUsageFromEvent,
  summarizeContextUsageFromEvents,
  alignContextUsageToModelWindow,
  reconcileContextLayers,
  type ContextBreakdownDetailWire
} from '@shared/utils/contextUsage'

const baseDetail: ContextBreakdownDetailWire = {
  messages: 600,
  systemPrompt: 140,
  skills: 60,
  system: { harness: 40, memory: 30, volatile: 10, total: 200 },
  tools: {
    builtin: { tokens: 120, count: 12 },
    mcp: { tokens: 80, count: 3 },
    mcpByServer: [
      { serverId: 'a', tokens: 50, toolCount: 2 },
      { serverId: 'b', tokens: 30, toolCount: 1 }
    ],
    deferredBuiltin: { tokens: 90, count: 7 },
    deferredMcp: { tokens: 200, count: 5 },
    total: 200
  }
}

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

  it('attaches detail with derived buffer/free fields', () => {
    const state = contextUsageFromEvent({
      type: 'context_usage',
      runId: 'r1',
      step: 3,
      estimatedTokens: 1000,
      inputTokens: 1000,
      contextWindow: 128000,
      contentWindow: 89600,
      compactionTrigger: 62720,
      source: 'estimate',
      layers: { system: 200, history: 600, tools: 200, buffer: 88800 },
      detail: baseDetail
    })
    expect(state?.detail?.messages).toBe(600)
    expect(state?.detail?.systemPrompt).toBe(140)
    expect(state?.detail?.skills).toBe(60)
    expect(state?.detail?.system.total).toBe(200)
    expect(state?.detail?.tools.mcpByServer).toHaveLength(2)
    expect(state?.detail?.autocompactBuffer).toBe(89600 - 62720)
    expect(state?.detail?.free).toBe(62720 - 1000)
  })

  it('carries the previous detail forward on provider events and absorbs the billed delta into messages', () => {
    const first = contextUsageFromEvent({
      type: 'context_usage',
      runId: 'r1',
      step: 3,
      estimatedTokens: 1000,
      inputTokens: 1000,
      contextWindow: 128000,
      contentWindow: 89600,
      compactionTrigger: 62720,
      source: 'estimate',
      layers: { system: 200, history: 600, tools: 200, buffer: 88800 },
      detail: baseDetail
    })
    const second = contextUsageFromEvent(
      {
        type: 'context_usage',
        runId: 'r1',
        step: 4,
        estimatedTokens: 1000,
        inputTokens: 1100,
        contextWindow: 128000,
        contentWindow: 89600,
        compactionTrigger: 62720,
        source: 'provider'
      },
      undefined,
      first?.layers,
      first?.detail
    )
    expect(second?.layers.history).toBe(700)
    expect(second?.detail?.messages).toBe(700)
    expect(second?.detail?.systemPrompt).toBe(140)
    expect(second?.detail?.skills).toBe(60)
    expect(second?.detail?.tools.total).toBe(200)
    expect(second?.detail?.free).toBe(62720 - 1100)
  })

  it('recomputes detail buffer/free when realigned to the model window', () => {
    const state = contextUsageFromEvent({
      type: 'context_usage',
      runId: 'r1',
      step: 1,
      estimatedTokens: 1000,
      inputTokens: 1000,
      contextWindow: 128000,
      contentWindow: 89600,
      compactionTrigger: 62720,
      source: 'estimate',
      layers: { system: 200, history: 600, tools: 200, buffer: 88800 },
      detail: baseDetail
    })
    expect(state).toBeTruthy()
    const aligned = alignContextUsageToModelWindow(state!, 1_000_000)
    expect(aligned.contentWindow).toBe(850_000)
    expect(aligned.compactionTrigger).toBe(595_000)
    expect(aligned.detail?.autocompactBuffer).toBe(850_000 - 595_000)
    expect(aligned.detail?.free).toBe(595_000 - 1000)
  })

  it('replays detail from persisted events', () => {
    const state = summarizeContextUsageFromEvents([
      {
        at: '2026-01-01T00:00:00.000Z',
        event: {
          type: 'context_usage',
          runId: 'r1',
          step: 1,
          estimatedTokens: 1000,
          contextWindow: 128000,
          contentWindow: 89600,
          compactionTrigger: 62720,
          source: 'estimate',
          layers: { system: 200, history: 600, tools: 200, buffer: 88800 },
          detail: baseDetail
        }
      }
    ])
    expect(state?.detail?.messages).toBe(600)
    expect(state?.detail?.tools.builtin.count).toBe(12)
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
