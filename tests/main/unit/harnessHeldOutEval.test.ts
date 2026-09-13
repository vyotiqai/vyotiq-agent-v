import { describe, expect, it } from 'vitest'
import {
  HELD_OUT_CASES,
  formatHeldOutEvalReport,
  gradeHeldOutCase,
  runHeldOutEval
} from '@main/agent/harnessHeldOutEval'

describe('harnessHeldOutEval', () => {
  it('pins a non-empty frozen held-out suite', () => {
    expect(HELD_OUT_CASES.length).toBeGreaterThanOrEqual(3)
    const ids = HELD_OUT_CASES.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('grades every held-out case successfully', () => {
    for (const heldOut of HELD_OUT_CASES) {
      const grade = gradeHeldOutCase(heldOut)
      expect(grade.ok, `${heldOut.id}: ${grade.errors.join('; ')}`).toBe(true)
    }
  })

  it('runHeldOutEval reports observed_only PASS for the frozen suite', () => {
    const report = runHeldOutEval()
    expect(report.observed_only).toBe(true)
    expect(report.ok).toBe(true)
    expect(report.failed).toBe(0)
    expect(report.passed).toBe(HELD_OUT_CASES.length)
    expect(formatHeldOutEvalReport(report)).toMatch(/PASS/)
    expect(formatHeldOutEvalReport(report)).toMatch(/never auto-applies/i)
  })

  it('fails a tampered expectation without writing harness files', () => {
    const base = HELD_OUT_CASES[0]
    expect(base).toBeDefined()
    const tampered = {
      ...base!,
      id: 'tampered-expect',
      expect: {
        buckets: ['memory'] as const,
        predictionTargets: ['memory'] as const
      }
    }
    const grade = gradeHeldOutCase(tampered)
    expect(grade.ok).toBe(false)
    expect(grade.errors.length).toBeGreaterThan(0)
  })
})
