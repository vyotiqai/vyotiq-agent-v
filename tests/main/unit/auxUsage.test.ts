import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readUsageLedger, recordAuxUsage, recordUsageDeltas } from '@main/agent/usageLedger'
import { AgentEventSchema } from '@shared/ipc/schemas/agent'
import {
  emptyStepUsageTotals,
  stepUsageFromEvent,
  stepUsageTotalsFromPersistedEvents
} from '@shared/utils/runTelemetry'
import type { AgentEvent } from '@shared/ipc'

let root: string

beforeEach(() => {
  root = join(tmpdir(), `vyotiq-aux-usage-${process.pid}-${Date.now()}`)
  mkdirSync(root, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const NOW = new Date('2026-09-21T12:00:00.000Z')

function auxEvent(overrides: Record<string, unknown> = {}): AgentEvent {
  return {
    type: 'aux_usage',
    runId: 'run-1',
    site: 'compaction_fork',
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    inputTokens: 5000,
    outputTokens: 400,
    generationMs: 1200,
    ...overrides
  } as AgentEvent
}

function stepEvent(step: number, inputTokens: number, outputTokens: number): AgentEvent {
  return {
    type: 'step_usage',
    runId: 'run-1',
    step,
    inputTokens,
    outputTokens
  } as AgentEvent
}

describe('aux_usage event', () => {
  it('parses through AgentEventSchema', () => {
    // Without this, appendEvent writes it to disk and both parseRendererChatEvent
    // and isAgentEvent silently drop it — spend recorded nowhere anybody reads.
    const parsed = AgentEventSchema.safeParse(auxEvent())
    expect(parsed.success).toBe(true)
  })

  it('requires provider and model', () => {
    const noModel = { ...(auxEvent() as Record<string, unknown>) }
    delete noModel.model
    expect(AgentEventSchema.safeParse(noModel).success).toBe(false)
  })

  it('rejects an unknown site', () => {
    expect(AgentEventSchema.safeParse(auxEvent({ site: 'something_else' })).success).toBe(false)
  })

  it('carries no `step` field, so it cannot key the streamBatch coalescer', () => {
    const parsed = AgentEventSchema.parse(auxEvent({ atStep: 7 })) as Record<string, unknown>
    expect(parsed.atStep).toBe(7)
    expect('step' in parsed).toBe(false)
  })
})

describe('aux spend never enters turn accounting', () => {
  it('stepUsageFromEvent ignores it', () => {
    expect(stepUsageFromEvent(auxEvent())).toBeNull()
  })

  it('does not inflate steps or billedInputTokens in a rebuild', () => {
    const withoutAux = stepUsageTotalsFromPersistedEvents([
      { event: stepEvent(1, 1000, 100) },
      { event: stepEvent(2, 2000, 200) }
    ])
    const withAux = stepUsageTotalsFromPersistedEvents([
      { event: stepEvent(1, 1000, 100) },
      { event: auxEvent({ inputTokens: 999_999, outputTokens: 999_999 }) },
      { event: stepEvent(2, 2000, 200) }
    ])
    expect(withAux).toEqual(withoutAux)
    expect(withAux.steps).toBe(2)
    expect(withAux.billedInputTokens).toBe(3000)
  })

  it('leaves stepsWithCostReport === steps intact, so turnCost still renders', () => {
    // messageFooterStats.turnCost returns null unless every counted step
    // reported a cost. An aux row counted as a step would silently blank the
    // per-turn cost caption on every compacting run.
    const totals = stepUsageTotalsFromPersistedEvents([
      { event: { ...stepEvent(1, 1000, 100), billedCost: 0.01 } as AgentEvent },
      { event: auxEvent() },
      { event: { ...stepEvent(2, 2000, 200), billedCost: 0.02 } as AgentEvent }
    ])
    expect(totals.steps).toBe(2)
    expect(totals.stepsWithCostReport).toBe(2)
  })

  it('an empty rebuild with only aux rows is the empty totals', () => {
    expect(stepUsageTotalsFromPersistedEvents([{ event: auxEvent() }])).toEqual(
      emptyStepUsageTotals()
    )
  })
})

describe('recordAuxUsage', () => {
  it('folds into day totals and the per-site breakdown', () => {
    recordAuxUsage(
      root,
      { site: 'compaction_fork', inputTokens: 5000, outputTokens: 400, estimatedCost: 0.02 },
      NOW
    )
    const ledger = readUsageLedger(root)
    const day = ledger?.days['2026-09-21']
    expect(day?.inputTokens).toBe(5000)
    expect(day?.outputTokens).toBe(400)
    expect(day?.estimatedCost).toBeCloseTo(0.02)
    expect(day?.aux?.compaction_fork).toMatchObject({
      calls: 1,
      inputTokens: 5000,
      outputTokens: 400
    })
  })

  it('accumulates calls per site and keeps sites separate', () => {
    recordAuxUsage(root, { site: 'compaction_fork', inputTokens: 100, outputTokens: 10 }, NOW)
    recordAuxUsage(root, { site: 'compaction_fork', inputTokens: 200, outputTokens: 20 }, NOW)
    recordAuxUsage(
      root,
      { site: 'compaction_structured', inputTokens: 50, outputTokens: 5 },
      NOW
    )
    const day = readUsageLedger(root)?.days['2026-09-21']
    expect(day?.aux?.compaction_fork).toMatchObject({ calls: 2, inputTokens: 300 })
    expect(day?.aux?.compaction_structured).toMatchObject({ calls: 1, inputTokens: 50 })
    expect(day?.inputTokens).toBe(350)
  })

  it('never touches lastTotals, so turn deltas stay independent', () => {
    recordAuxUsage(root, { site: 'compaction_fork', inputTokens: 9000, outputTokens: 900 }, NOW)
    expect(readUsageLedger(root)?.lastTotals).toMatchObject({
      steps: 0,
      billedInputTokens: 0,
      outputTokens: 0
    })
  })

  it('does not double-count when turn deltas are recorded alongside it', () => {
    const turnTotals = {
      inputTokens: 1000,
      billedInputTokens: 1000,
      peakInputTokens: 1000,
      outputTokens: 100,
      cachedInputTokens: 0,
      billedCachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningTokens: 0,
      steps: 1,
      stepsWithCacheReport: 0,
      billedCost: 0,
      billedCostSaved: 0,
      stepsWithCostReport: 0,
      estimatedCost: 0,
      stepsWithEstimate: 0,
      generationMs: 0
    }
    recordUsageDeltas(root, turnTotals, NOW)
    recordAuxUsage(root, { site: 'compaction_fork', inputTokens: 500, outputTokens: 50 }, NOW)
    // A second turn-delta call must bill only the turn delta, unaffected by the
    // aux write that landed between them.
    recordUsageDeltas(root, { ...turnTotals, billedInputTokens: 3000, outputTokens: 300, steps: 2 }, NOW)

    const day = readUsageLedger(root)?.days['2026-09-21']
    // turn input 1000 + 2000 delta, plus aux 500
    expect(day?.inputTokens).toBe(3500)
    expect(day?.outputTokens).toBe(350)
    expect(day?.aux?.compaction_fork?.inputTokens).toBe(500)
    expect(readUsageLedger(root)?.lastTotals.billedInputTokens).toBe(3000)
  })

  it('writes nothing for an all-zero sample', () => {
    recordAuxUsage(root, { site: 'compaction_fork', inputTokens: 0, outputTokens: 0 }, NOW)
    expect(readUsageLedger(root)).toBeNull()
  })

  it('never throws on an unwritable run dir', () => {
    expect(() =>
      recordAuxUsage(
        join(root, 'does', 'not', 'exist'),
        { site: 'commit_message', inputTokens: 10, outputTokens: 1 },
        NOW
      )
    ).not.toThrow()
  })
})
