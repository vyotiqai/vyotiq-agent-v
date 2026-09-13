/**
 * Frozen held-out Self-Harness experiment grader.
 *
 * Scores receipt → evidence-bucket mining and observational prediction targets
 * against pinned fixtures. Never writes harness files and never auto-applies.
 * Changing cases / grader logic requires a normal PR (listed in gate sources).
 */

import type { RunReceipt } from '../../shared/ipc'
import { RUN_RECEIPT_VERSION } from '../../shared/ipc'
import {
  summarizeWeaknesses,
  type HarnessEvidenceBucket
} from './harnessReview'
import { buildPredictionManifest, type PredictionManifest } from './runTrajectory'

export type HeldOutPredictionTarget = PredictionManifest['predictions'][number]['target']

export type HeldOutCase = {
  id: string
  description: string
  receipts: RunReceipt[]
  expect: {
    /** Buckets that must appear in summarizeWeaknesses. */
    buckets: HarnessEvidenceBucket[]
    /** Buckets that must not appear. */
    absentBuckets?: HarnessEvidenceBucket[]
    /** Observational prediction targets (from first receipt heuristics). */
    predictionTargets?: HeldOutPredictionTarget[]
  }
}

export type HeldOutCaseGrade = {
  id: string
  ok: boolean
  errors: string[]
  actualBuckets: HarnessEvidenceBucket[]
  actualPredictionTargets: HeldOutPredictionTarget[]
}

export type HeldOutEvalReport = {
  /** Always true — this grader never mutates default.md. */
  observed_only: true
  ok: boolean
  passed: number
  failed: number
  cases: HeldOutCaseGrade[]
}

function baseReceipt(overrides: Partial<RunReceipt> & Pick<RunReceipt, 'runId'>): RunReceipt {
  return {
    version: RUN_RECEIPT_VERSION,
    writtenAt: '2026-07-30T00:00:00.000Z',
    status: 'done',
    step: 1,
    compactionCount: 0,
    toolStats: { totalCalls: 0, ok: 0, failed: 0, byName: {} },
    failureClusters: [],
    unreadEditPaths: [],
    wroteFiles: [],
    diagnostics: { calls: 0, ok: 0, clean: 0 },
    contractExcerpt: '## Done when',
    ...overrides
  }
}

/**
 * Pinned held-out cases. Treat as frozen experiment data — edit only via PR.
 * Keep ids stable so regressions are obvious in CI / harness-apply gate.
 */
export const HELD_OUT_CASES: readonly HeldOutCase[] = [
  {
    id: 'unread-edit-work-style',
    description: 'Unread-before-edit paths map to loop notices, not durable harness policy',
    receipts: [
      baseReceipt({
        runId: 'held-out-unread',
        toolStats: { totalCalls: 2, ok: 2, failed: 0, byName: { edit: { ok: 2, failed: 0 } } },
        unreadEditPaths: ['src/held-out/unread.ts'],
        wroteFiles: ['src/held-out/unread.ts']
      })
    ],
    expect: {
      buckets: ['loop_notices'],
      absentBuckets: ['system_prompt', 'tool_policy', 'memory'],
      predictionTargets: ['work_style']
    }
  },
  {
    id: 'tool-failure-policy',
    description: 'Tool failure clusters map to tool policy, not durable harness policy',
    receipts: [
      baseReceipt({
        runId: 'held-out-fail',
        toolStats: {
          totalCalls: 5,
          ok: 1,
          failed: 4,
          byName: { shell: { ok: 1, failed: 4 } }
        },
        failureClusters: [{ key: 'shell: ENOENT', count: 4 }]
      })
    ],
    expect: {
      buckets: ['tool_policy'],
      absentBuckets: ['system_prompt', 'loop_notices', 'memory'],
      predictionTargets: ['tool_policy']
    }
  },
  {
    id: 'compaction-memory',
    description: 'Compaction and memory-tool failures map to their runtime owners',
    receipts: [
      baseReceipt({
        runId: 'held-out-memory',
        compactionCount: 3,
        toolStats: {
          totalCalls: 3,
          ok: 2,
          failed: 1,
          byName: { memory_write: { ok: 0, failed: 1 }, read: { ok: 2, failed: 0 } }
        },
        failureClusters: [{ key: 'memory_write: EACCES', count: 1 }]
      })
    ],
    expect: {
      buckets: ['memory', 'tool_policy'],
      absentBuckets: ['system_prompt', 'loop_notices'],
      predictionTargets: ['memory', 'tool_policy']
    }
  },
  {
    id: 'clean-receipt-no-signals',
    description: 'Clean receipt yields no evidence-bucket signals',
    receipts: [
      baseReceipt({
        runId: 'held-out-clean',
        toolStats: { totalCalls: 2, ok: 2, failed: 0, byName: { read: { ok: 2, failed: 0 } } }
      })
    ],
    expect: {
      buckets: [],
      absentBuckets: ['loop_notices', 'tool_policy', 'memory', 'system_prompt'],
      predictionTargets: []
    }
  }
] as const

/** Grade a single held-out case (pure; no I/O). */
export function gradeHeldOutCase(heldOut: HeldOutCase): HeldOutCaseGrade {
  const collected = heldOut.receipts.map((receipt) => ({
    runId: receipt.runId,
    receipt
  }))
  const summary = summarizeWeaknesses(collected)
  const actualBuckets = summary.evidenceBuckets.map((b) => b.component)

  const primary = heldOut.receipts[0]
  const actualPredictionTargets: HeldOutPredictionTarget[] = primary
    ? buildPredictionManifest(primary.runId, primary).predictions.map((p) => p.target)
    : []

  const errors: string[] = []
  for (const bucket of heldOut.expect.buckets) {
    if (!actualBuckets.includes(bucket)) {
      errors.push(`missing expected bucket: ${bucket}`)
    }
  }
  for (const bucket of heldOut.expect.absentBuckets ?? []) {
    if (actualBuckets.includes(bucket)) {
      errors.push(`unexpected bucket: ${bucket}`)
    }
  }
  if (heldOut.expect.predictionTargets) {
    for (const target of heldOut.expect.predictionTargets) {
      if (!actualPredictionTargets.includes(target)) {
        errors.push(`missing expected prediction target: ${target}`)
      }
    }
    for (const target of actualPredictionTargets) {
      if (!heldOut.expect.predictionTargets.includes(target)) {
        errors.push(`unexpected prediction target: ${target}`)
      }
    }
  }

  return {
    id: heldOut.id,
    ok: errors.length === 0,
    errors,
    actualBuckets,
    actualPredictionTargets
  }
}

/**
 * Run the full frozen held-out suite.
 * Does not write `resources/harness/default.md` and does not auto-apply.
 */
export function runHeldOutEval(
  cases: readonly HeldOutCase[] = HELD_OUT_CASES
): HeldOutEvalReport {
  const graded = cases.map((c) => gradeHeldOutCase(c))
  const passed = graded.filter((g) => g.ok).length
  const failed = graded.length - passed
  return {
    observed_only: true,
    ok: failed === 0,
    passed,
    failed,
    cases: graded
  }
}

/** Markdown report for operators / proposal footers. */
export function formatHeldOutEvalReport(report: HeldOutEvalReport): string {
  const lines = [
    `Held-out eval: ${report.ok ? 'PASS' : 'FAIL'} (${report.passed}/${report.passed + report.failed})`,
    '_Frozen grader — observational only; never auto-applies harness text._',
    ''
  ]
  for (const c of report.cases) {
    lines.push(`- ${c.ok ? '✓' : '✗'} \`${c.id}\`${c.errors.length ? ` — ${c.errors.join('; ')}` : ''}`)
  }
  return lines.join('\n')
}
