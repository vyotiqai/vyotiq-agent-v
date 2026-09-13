import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  USAGE_LEDGER_FILENAME,
  readUsageLedger,
  recordUsageDeltas
} from '@main/agent/usageLedger'

let root: string

beforeEach(() => {
  root = join(tmpdir(), `vyotiq-usage-ledger-${process.pid}-${Date.now()}`)
  mkdirSync(root, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function totals(overrides: Partial<Parameters<typeof recordUsageDeltas>[1]> = {}) {
  return {
    inputTokens: 0,
    billedInputTokens: 0,
    peakInputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    billedCachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningTokens: 0,
    steps: 0,
    stepsWithCacheReport: 0,
    billedCost: 0,
    billedCostSaved: 0,
    stepsWithCostReport: 0,
    generationMs: 0,
    ...overrides
  }
}

const NOW = new Date('2026-09-09T12:00:00.000Z')
const NEXT_DAY = new Date('2026-09-10T12:00:00.000Z')

describe('recordUsageDeltas', () => {
  it('records step deltas into the local day bucket', () => {
    recordUsageDeltas(root, totals({ steps: 1, billedInputTokens: 100, outputTokens: 10 }), NOW)
    recordUsageDeltas(
      root,
      totals({ steps: 2, billedInputTokens: 350, outputTokens: 25 }),
      NOW
    )

    const ledger = readUsageLedger(root)!
    expect(ledger.days['2026-09-09']).toMatchObject({
      inputTokens: 350,
      outputTokens: 25
    })
    expect(ledger.lastTotals).toMatchObject({
      steps: 2,
      billedInputTokens: 350,
      outputTokens: 25
    })
  })

  it('attributes deltas to the local day they accrued on', () => {
    recordUsageDeltas(root, totals({ steps: 1, billedInputTokens: 100, outputTokens: 10 }), NOW)
    recordUsageDeltas(
      root,
      totals({ steps: 2, billedInputTokens: 400, outputTokens: 40 }),
      NEXT_DAY
    )

    const ledger = readUsageLedger(root)!
    expect(ledger.days['2026-09-09']).toMatchObject({ inputTokens: 100, outputTokens: 10 })
    expect(ledger.days['2026-09-10']).toMatchObject({ inputTokens: 300, outputTokens: 30 })
  })

  it('records cost and cache deltas only when positive', () => {
    recordUsageDeltas(
      root,
      totals({
        steps: 1,
        billedInputTokens: 100,
        outputTokens: 10,
        billedCost: 0.5,
        billedCachedInputTokens: 40
      }),
      NOW
    )

    const day = readUsageLedger(root)!.days['2026-09-09']!
    expect(day.billedCost).toBe(0.5)
    expect(day.cachedInputTokens).toBe(40)
  })

  it('ignores cumulative totals that went backwards (fresh re-seed)', () => {
    recordUsageDeltas(root, totals({ steps: 3, billedInputTokens: 500 }), NOW)
    recordUsageDeltas(root, totals({ steps: 1, billedInputTokens: 50 }), NOW)

    const ledger = readUsageLedger(root)!
    // Negative delta contributes nothing; snapshot stays at the high-water mark.
    expect(ledger.days['2026-09-09']).toMatchObject({ inputTokens: 500 })
    expect(ledger.lastTotals.billedInputTokens).toBe(500)
  })

  it('skips the write when nothing new is reported', () => {
    recordUsageDeltas(root, totals({ steps: 1, billedInputTokens: 100 }), NOW)
    const before = readFileSync(join(root, USAGE_LEDGER_FILENAME), 'utf8')
    recordUsageDeltas(root, totals({ steps: 1, billedInputTokens: 100 }), NOW)
    expect(readFileSync(join(root, USAGE_LEDGER_FILENAME), 'utf8')).toBe(before)
  })

  it('never throws on a corrupt existing ledger (rebuilds from scratch)', () => {
    recordUsageDeltas(root, totals({ steps: 1, billedInputTokens: 100 }), NOW)
    // Corrupt the file between calls.
    rmSync(join(root, USAGE_LEDGER_FILENAME))
    recordUsageDeltas(root, totals({ steps: 2, billedInputTokens: 200 }), NOW)

    const ledger = readUsageLedger(root)!
    expect(ledger.days['2026-09-09']).toMatchObject({ inputTokens: 200 })
    expect(existsSync(join(root, USAGE_LEDGER_FILENAME))).toBe(true)
  })

  it('readUsageLedger returns null for absent or malformed files', () => {
    expect(readUsageLedger(root)).toBeNull()
    recordUsageDeltas(root, totals({ steps: 1 }), NOW)
    const raw = JSON.parse(readFileSync(join(root, USAGE_LEDGER_FILENAME), 'utf8'))
    raw.version = 99
    writeFileSync(join(root, USAGE_LEDGER_FILENAME), JSON.stringify(raw))
    expect(readUsageLedger(root)).toBeNull()
  })
})
