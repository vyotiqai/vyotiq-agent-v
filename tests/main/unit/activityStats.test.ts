import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectHomeActivity } from '@main/agent/activityStats'
import { resetJsonDocCacheForTests } from '@main/agent/jsonDocCache'
import { workspaceSessionsRoot } from '@main/storage/paths'

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => join(tmpdir(), `vyotiq-${name}`),
    getAppPath: () => join(tmpdir(), 'vyotiq-app'),
    isPackaged: false
  }
}))

const WS = 'C:\\vyotiq-activity-test'
const NOW = new Date('2026-09-09T12:00:00.000Z') // local day 2026-09-09 in tests

/** Real sessions root for the test workspace (same resolution as main). */
function sessionsRoot(): string {
  return workspaceSessionsRoot(WS)
}

function makeRun(id: string, files: Record<string, string>): void {
  const dir = join(sessionsRoot(), id)
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content)
  }
}

function receipt(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    version: 5,
    writtenAt: '2026-09-09T10:00:00.000Z',
    runId: 'r',
    status: 'done',
    step: 1,
    compactionCount: 0,
    toolStats: { totalCalls: 0, ok: 0, failed: 0, byName: {} },
    failureClusters: [],
    unreadEditPaths: [],
    wroteFiles: [],
    diagnostics: { calls: 0, ok: 0, clean: 0 },
    contractExcerpt: '',
    ...overrides
  })
}

const CHECKPOINT_TOTALS = {
  billedInputTokens: 100,
  peakInputTokens: 100,
  outputTokens: 10,
  billedCachedInputTokens: 0,
  cacheCreationInputTokens: 0,
  reasoningTokens: 0,
  steps: 2,
  stepsWithCacheReport: 0,
  billedCost: 0.42,
  billedCostSaved: 0,
  stepsWithCostReport: 1,
  generationMs: 1000,
  lastStepInputTokens: 100
}

function ledgerFile(
  days: Record<string, Record<string, number>>,
  totalsOverrides: Record<string, number> = {}
): string {
  return JSON.stringify({
    version: 1,
    lastTotals: {
      steps: 2,
      billedInputTokens: 400,
      outputTokens: 40,
      billedCost: 0.5,
      cachedInputTokens: 30,
      ...totalsOverrides
    },
    days
  })
}

afterEach(() => {
  rmSync(sessionsRoot(), { recursive: true, force: true })
  resetJsonDocCacheForTests()
})

describe('collectHomeActivity', () => {
  it('buckets legacy receipts into local days and sums tokens within the window', async () => {
    makeRun('run-a', {
      'receipt.json': receipt({
        runId: 'run-a',
        tokenUsage: { billedInputTokens: 1500, outputTokens: 120 }
      })
    })
    makeRun('run-b', {
      'receipt.json': receipt({
        runId: 'run-b',
        status: 'error',
        tokenUsage: { billedInputTokens: 500, outputTokens: 30 }
      })
    })

    const res = await collectHomeActivity([WS], NOW)

    expect(res.days).toHaveLength(1)
    expect(res.days[0]).toMatchObject({
      runs: 2,
      billedInputTokens: 2000,
      outputTokens: 150
    })
    expect(res.outcomes).toEqual({ done: 1, error: 1, cancelled: 0, running: 0 })
    expect(res.totals).toEqual({
      runs: 2,
      billedInputTokens: 2000,
      outputTokens: 150
    })
  })

  it('attributes multi-day usage via the per-day ledger, not the receipt write day', async () => {
    makeRun('run-a', {
      'receipt.json': receipt({
        runId: 'run-a',
        writtenAt: '2026-09-09T10:00:00.000Z',
        model: 'glm-5.3',
        // Cumulative receipt totals — must NOT be double-counted on top of
        // the ledger (legacy fallback is skipped when a ledger exists).
        tokenUsage: { billedInputTokens: 400, outputTokens: 40 }
      }),
      'usage.json': ledgerFile({
        '2026-09-08': { inputTokens: 100, outputTokens: 10 },
        '2026-09-09': {
          inputTokens: 300,
          outputTokens: 30,
          billedCost: 0.5,
          cachedInputTokens: 30
        }
      })
    })

    const res = await collectHomeActivity([WS], NOW)

    // Two distinct ledger days, exactly their deltas — nothing re-attributed
    // to the receipt write day.
    expect(res.days).toHaveLength(2)
    expect(res.days[0]).toMatchObject({ date: '2026-09-08', billedInputTokens: 100, outputTokens: 10 })
    expect(res.days[1]).toMatchObject({
      date: '2026-09-09',
      billedInputTokens: 300,
      outputTokens: 30,
      billedCost: 0.5
    })
    // Model split applies per ledger day from the receipt tag.
    expect(res.days[1]!.byModel).toEqual({ 'glm-5.3': 30 })
    expect(res.totals).toMatchObject({
      runs: 1,
      billedInputTokens: 400,
      outputTokens: 40,
      billedCost: 0.5
    })
    expect(res.outcomes).toEqual({ done: 1, error: 0, cancelled: 0, running: 0 })
  })

  it('keeps a live (receiptless) run in the window through its per-step ledger', async () => {
    makeRun('run-live', {
      'status.json': JSON.stringify({
        status: 'running',
        step: 2,
        updatedAt: '2026-09-09T10:00:00.000Z'
      }),
      'usage.json': ledgerFile(
        { '2026-09-09': { inputTokens: 900, outputTokens: 60, billedCost: 0.1 } },
        { billedInputTokens: 900, outputTokens: 60, billedCost: 0.1, cachedInputTokens: 0 }
      )
    })

    const res = await collectHomeActivity([WS], NOW)

    expect(res.outcomes.running).toBe(1)
    expect(res.days[0]).toMatchObject({
      date: '2026-09-09',
      runs: 1, // distinct runs with activity that day (receipt or ledger)
      billedInputTokens: 900,
      outputTokens: 60
    })
    expect(res.totals.runs).toBe(1)
    expect(res.totals.billedCost).toBe(0.1)
  })

  it('excludes inline instance runs entirely', async () => {
    makeRun('inst-a', {
      'status.json': JSON.stringify({
        status: 'done',
        step: 1,
        updatedAt: '2026-09-09T10:00:00.000Z',
        inlineInstance: true
      }),
      'receipt.json': receipt({
        runId: 'inst-a',
        tokenUsage: { billedInputTokens: 5000, outputTokens: 500 }
      })
    })

    const res = await collectHomeActivity([WS], NOW)

    expect(res.days).toEqual([])
    expect(res.totals.runs).toBe(0)
    expect(res.outcomes).toEqual({ done: 0, error: 0, cancelled: 0, running: 0 })
  })

  it('uses receipt billedCost for completed runs (checkpoint cleared on done)', async () => {
    makeRun('run-a', {
      'receipt.json': receipt({
        runId: 'run-a',
        billedCost: 1.25,
        tokenUsage: { billedInputTokens: 100, outputTokens: 10 }
      })
    })

    const res = await collectHomeActivity([WS], NOW)

    expect(res.totals.billedCost).toBe(1.25)
    expect(res.days[0]!.billedCost).toBe(1.25)
  })

  it('falls back to the durable checkpoint for interrupted legacy runs without receipt cost', async () => {
    makeRun('run-a', {
      'receipt.json': receipt({
        runId: 'run-a',
        status: 'error',
        tokenUsage: { billedInputTokens: 100, outputTokens: 10 }
      }),
      'loopCheckpoint.json': JSON.stringify({
        version: 3,
        step: 2,
        invokeId: 1,
        updatedAt: '2026-09-09T10:00:00.000Z',
        usageTotals: CHECKPOINT_TOTALS
      })
    })
    // Zero-cost checkpoint must never fabricate a cost line.
    makeRun('run-b', {
      'receipt.json': receipt({
        runId: 'run-b',
        tokenUsage: { billedInputTokens: 100, outputTokens: 10 }
      }),
      'loopCheckpoint.json': JSON.stringify({
        version: 3,
        step: 1,
        invokeId: 1,
        updatedAt: '2026-09-09T10:00:00.000Z',
        usageTotals: { ...CHECKPOINT_TOTALS, billedCost: 0, stepsWithCostReport: 0 }
      })
    })

    const res = await collectHomeActivity([WS], NOW)

    expect(res.totals.billedCost).toBe(0.42)
  })

  it('counts legacy out-of-window cost without double-counting usage', async () => {
    makeRun('run-old', {
      'receipt.json': receipt({
        runId: 'run-old',
        status: 'done',
        writtenAt: '2026-08-01T10:00:00.000Z',
        billedCost: 2.5,
        tokenUsage: { billedInputTokens: 99_999, outputTokens: 9_999 }
      })
    })

    const res = await collectHomeActivity([WS], NOW)

    expect(res.days).toEqual([])
    expect(res.outcomes.done).toBe(0)
    // Everything, including outcomes, is scoped to the selected window.
    expect(res.totals).toEqual({
      runs: 0,
      billedInputTokens: 0,
      outputTokens: 0
    })
  })

  it('shows by-model split only for receipts that recorded a model', async () => {
    makeRun('run-a', {
      'receipt.json': receipt({
        runId: 'run-a',
        model: 'glm-5.3',
        tokenUsage: { billedInputTokens: 100, outputTokens: 40 }
      })
    })
    makeRun('run-b', {
      // No model — legacy receipt. Must not fabricate a bucket.
      'receipt.json': receipt({
        runId: 'run-b',
        tokenUsage: { billedInputTokens: 100, outputTokens: 60 }
      })
    })

    const res = await collectHomeActivity([WS], NOW)

    expect(res.days[0]!.byModel).toEqual({ 'glm-5.3': 40 })
  })

  it('counts a validated receiptless running status, never as usage', async () => {
    makeRun('run-live', {
      'status.json': JSON.stringify({
        status: 'running',
        step: 1,
        updatedAt: '2026-09-09T10:00:00.000Z'
      })
    })

    const res = await collectHomeActivity([WS], NOW)

    expect(res.outcomes.running).toBe(1)
    expect(res.days).toHaveLength(0)
    expect(res.totals.runs).toBe(0)
  })

  it('skips corrupt receipts and ledgers instead of failing the aggregate', async () => {
    makeRun('run-a', { 'receipt.json': '{not json' })
    makeRun('run-b', {
      'receipt.json': receipt({ runId: 'run-b' }),
      'usage.json': '{not json'
    })

    const res = await collectHomeActivity([WS], NOW)

    expect(res.outcomes.running).toBe(0)
    expect(res.totals.runs).toBe(1) // run-b falls back to its receipt
  })

  it('omits billedCost/cachedInputTokens unless reported somewhere in the window', async () => {
    makeRun('run-a', {
      'receipt.json': receipt({
        runId: 'run-a',
        tokenUsage: { billedInputTokens: 100, outputTokens: 10, cachedInputTokens: 0 }
      })
    })

    const res = await collectHomeActivity([WS], NOW)

    expect('billedCost' in res.totals).toBe(false)
    expect('cachedInputTokens' in res.totals).toBe(false)
  })

  it('returns an empty honest result when the workspace has no sessions', async () => {
    mkdirSync(sessionsRoot(), { recursive: true })

    const res = await collectHomeActivity([WS], NOW)

    expect(res.days).toEqual([])
    expect(res.outcomes).toEqual({ done: 0, error: 0, cancelled: 0, running: 0 })
    expect(res.totals.runs).toBe(0)
  })

  it('surfaces reasoning/peak/contextWindow from ledger days into day buckets and totals', async () => {
    makeRun('run-a', {
      'receipt.json': receipt({
        runId: 'run-a',
        model: 'glm-5.3',
        contextWindow: 131072
      }),
      'usage.json': ledgerFile(
        {
          '2026-09-09': {
            inputTokens: 300,
            outputTokens: 60,
            reasoningTokens: 24,
            peakInputTokens: 98304,
            contextWindow: 131072
          }
        },
        { billedInputTokens: 300, outputTokens: 60 }
      )
    })

    const res = await collectHomeActivity([WS], NOW)

    expect(res.days[0]).toMatchObject({
      reasoningTokens: 24,
      peakInputTokens: 98304,
      contextWindow: 131072
    })
    expect(res.totals).toMatchObject({
      reasoningTokens: 24,
      peakInputTokens: 98304,
      contextWindow: 131072
    })
  })

  it('keeps the context window paired with the run that reported the largest peak', async () => {
    makeRun('run-large-peak', {
      'receipt.json': receipt({ runId: 'run-large-peak', model: 'large-window' }),
      'usage.json': ledgerFile({
        '2026-09-09': {
          inputTokens: 100,
          outputTokens: 10,
          peakInputTokens: 90_000,
          contextWindow: 120_000
        }
      })
    })
    makeRun('run-small-peak', {
      'receipt.json': receipt({ runId: 'run-small-peak', model: 'small-window' }),
      'usage.json': ledgerFile({
        '2026-09-09': {
          inputTokens: 100,
          outputTokens: 10,
          peakInputTokens: 20_000,
          contextWindow: 30_000
        }
      })
    })

    const res = await collectHomeActivity([WS], NOW)

    expect(res.totals.peakInputTokens).toBe(90_000)
    expect(res.totals.contextWindow).toBe(120_000)
  })

  it('honors windowDays=30, computes activeDays and the previous-window trend', async () => {
    makeRun('run-a', {
      'receipt.json': receipt({ runId: 'run-a' }),
      'usage.json': ledgerFile({
        '2026-09-09': { inputTokens: 300, outputTokens: 30 }, // current window (8/11..9/9)
        '2026-08-01': { inputTokens: 120, outputTokens: 12 }, // previous window (7/12..8/10) → trend
        '2026-07-01': { inputTokens: 9_999, outputTokens: 999 } // outside both
      })
    })

    const res = await collectHomeActivity([WS], NOW, 30)

    expect(res.windowDays).toBe(30)
    // Only the in-window ledger day lands in days; the previous-window day
    // feeds the trend and the out-of-both day contributes nothing.
    expect(res.days).toHaveLength(1)
    expect(res.days[0]!.date).toBe('2026-09-09')
    expect(res.activeDays).toBe(1)
    expect(res.totals.previousTokens).toBe(132)
  })

  it('emits per-workspace slices only for multi-workspace requests', async () => {
    makeRun('run-a', {
      'receipt.json': receipt({
        runId: 'run-a',
        billedCost: 1.5,
        tokenUsage: { billedInputTokens: 700, outputTokens: 70 }
      })
    })

    const single = await collectHomeActivity([WS], NOW)
    expect(single.workspaces).toBeUndefined()

    const multi = await collectHomeActivity([WS, 'C:\\vyotiq-activity-test-2'], NOW)
    expect(multi.workspaces).toHaveLength(1)
    expect(multi.workspaces![0]).toMatchObject({
      path: WS,
      runs: 1,
      billedInputTokens: 700,
      outputTokens: 70,
      billedCost: 1.5
    })
  })

  it('surfaces attention signals from window receipts (unverified runs + top tools)', async () => {
    makeRun('run-a', {
      'receipt.json': receipt({
        runId: 'run-a',
        verification: {
          lastMutationAt: '2026-09-09T09:00:00.000Z',
          lastCheckAt: '2026-09-09T08:00:00.000Z',
          verifiedAfterLastMutation: false
        },
        toolStats: {
          totalCalls: 9,
          ok: 7,
          failed: 2,
          byName: {
            edit: { ok: 3, failed: 2 },
            read: { ok: 4, failed: 0 }
          }
        }
      })
    })
    makeRun('run-b', {
      'receipt.json': receipt({
        runId: 'run-b',
        verification: {
          lastCheckAt: '2026-09-09T09:30:00.000Z',
          verifiedAfterLastMutation: true
        },
        toolStats: {
          totalCalls: 5,
          ok: 5,
          failed: 0,
          byName: { edit: { ok: 5, failed: 0 } }
        }
      })
    })

    const res = await collectHomeActivity([WS], NOW)

    // Only run-a is unverified (run-b verified after its last mutation).
    expect(res.attention).toEqual({
      unverifiedRuns: 1,
      topTools: [
        { name: 'edit', ok: 8, failed: 2 },
        { name: 'read', ok: 4, failed: 0 }
      ]
    })
  })

  it('counts the gate verdict over the raw receipt field when both are present', async () => {
    // A read-only turn whose check merely failed. The raw field reports
    // `verifiedAfterLastMutation: false` because the last check was unclean,
    // but nothing was mutated, so there is nothing to have verified — and the
    // guarded gate says so. Counting it would inflate the rate that decides
    // whether the gate is safe to arm.
    makeRun('run-readonly', {
      'receipt.json': receipt({
        runId: 'run-readonly',
        verification: {
          lastCheckAt: '2026-09-09T09:00:00.000Z',
          verifiedAfterLastMutation: false
        },
        verificationGate: { wouldFire: false },
        // Present only so the attention block is emitted at all; without some
        // signal it is omitted, which would make a 0 assertion vacuous.
        toolStats: { totalCalls: 1, ok: 1, failed: 0, byName: { read: { ok: 1, failed: 0 } } }
      })
    })

    const res = await collectHomeActivity([WS], NOW)

    expect(res.attention).toMatchObject({ unverifiedRuns: 0 })
  })

  it('counts a run the gate flagged even when the raw field is absent', async () => {
    makeRun('run-opaque', {
      'receipt.json': receipt({
        runId: 'run-opaque',
        // A terminal write reaches the write checkpoint without an edit tool,
        // so the gate fires on evidence the event-scan field never sees.
        verificationGate: { wouldFire: true, reason: 'never_checked' }
      })
    })

    const res = await collectHomeActivity([WS], NOW)

    expect(res.attention?.unverifiedRuns).toBe(1)
  })

  it('keeps the legacy reading for receipts written before the gate existed', async () => {
    makeRun('run-legacy', {
      'receipt.json': receipt({
        runId: 'run-legacy',
        verification: {
          lastMutationAt: '2026-09-09T09:00:00.000Z',
          lastCheckAt: '2026-09-09T08:00:00.000Z',
          verifiedAfterLastMutation: false
        }
      })
    })

    const res = await collectHomeActivity([WS], NOW)

    expect(res.attention?.unverifiedRuns).toBe(1)
  })

  it('omits the attention block when no receipt reports verification or tools', async () => {
    makeRun('run-a', { 'receipt.json': receipt({ runId: 'run-a' }) })

    const res = await collectHomeActivity([WS], NOW)

    expect(res.attention).toBeUndefined()
  })

  it('digests error runs newest-first with workspace and goal, capped at 3', async () => {
    for (const [id, at] of [
      ['err-1', '2026-09-09T08:00:00.000Z'],
      ['err-2', '2026-09-09T09:00:00.000Z'],
      ['err-3', '2026-09-09T10:00:00.000Z'],
      ['err-4', '2026-09-09T07:00:00.000Z']
    ] as const) {
      makeRun(id, {
        'receipt.json': receipt({
          runId: id,
          status: 'error',
          writtenAt: at,
          ...(id === 'err-2' ? {} : { goal: `goal ${id}` })
        })
      })
    }

    const res = await collectHomeActivity([WS], NOW)

    expect(res.attention?.errorRuns).toEqual([
      { runId: 'err-3', workspacePath: WS, goal: 'goal err-3' },
      { runId: 'err-2', workspacePath: WS },
      { runId: 'err-1', workspacePath: WS, goal: 'goal err-1' }
    ])
  })

  it('never lists non-error runs in the digest', async () => {
    makeRun('ok-run', { 'receipt.json': receipt({ runId: 'ok-run' }) })

    const res = await collectHomeActivity([WS], NOW)

    expect(res.attention?.errorRuns).toBeUndefined()
  })
})

describe('window pruning (mtime-keyed)', () => {
  /** Before the earliest previous-window local day for any windowDays ≤ 30. */
  const LONG_AGO = new Date('2026-08-01T10:00:00.000Z')

  function backdate(runId: string, files: string[]): void {
    for (const name of files) {
      utimesSync(join(sessionsRoot(), runId, name), LONG_AGO, LONG_AGO)
    }
  }

  it('aggregates identically whether or not ancient run dirs exist', async () => {
    makeRun('fresh-run', {
      'receipt.json': receipt({
        runId: 'fresh-run',
        tokenUsage: { billedInputTokens: 900, outputTokens: 60 }
      })
    })
    // A fully ancient run: receipt + ledger both last written before the
    // previous window's start. Physically every day key it holds predates
    // the cutoff, so it must contribute nothing at all.
    makeRun('ancient-run', {
      'receipt.json': receipt({
        runId: 'ancient-run',
        writtenAt: '2026-07-20T10:00:00.000Z',
        tokenUsage: { billedInputTokens: 444444, outputTokens: 4444 }
      }),
      'usage.json': ledgerFile({
        '2026-07-20': { inputTokens: 444444, outputTokens: 4444 }
      })
    })
    backdate('ancient-run', ['receipt.json', 'usage.json'])

    const withAncient = await collectHomeActivity([WS], NOW)
    rmSync(join(sessionsRoot(), 'ancient-run'), { recursive: true, force: true })
    const withoutAncient = await collectHomeActivity([WS], NOW)

    expect(withAncient).toEqual(withoutAncient)
    expect(withAncient.days).toHaveLength(1)
    expect(withAncient.days[0]).toMatchObject({ runs: 1, billedInputTokens: 900 })
  })

  it('still counts a stale receiptless running dir (window-independent rule)', async () => {
    makeRun('zombie-run', {
      'status.json': JSON.stringify({
        status: 'running',
        step: 1,
        updatedAt: '2026-07-15T00:00:00.000Z'
      })
    })
    backdate('zombie-run', ['status.json'])

    const res = await collectHomeActivity([WS], NOW)

    expect(res.outcomes.running).toBe(1)
    expect(res.days).toHaveLength(0)
  })

  it('keeps previous-window ledger days in the trend when the run is out-of-window', async () => {
    // Day inside the previous 7-day window, written while it happened — the
    // mtime respects the cutoff, so pruning must not drop the trend sample.
    makeRun('trend-run', {
      'usage.json': ledgerFile({
        '2026-08-30': { inputTokens: 700, outputTokens: 70 }
      })
    })
    backdate('trend-run', ['usage.json'])
    utimesSync(
      join(sessionsRoot(), 'trend-run', 'usage.json'),
      new Date('2026-08-30T10:00:00.000Z'),
      new Date('2026-08-30T10:00:00.000Z')
    )

    const res = await collectHomeActivity([WS], NOW)

    expect(res.totals.previousTokens).toBe(770)
    expect(res.days).toHaveLength(0)
  })
})
