import { describe, expect, it } from 'vitest'
import {
  createVerificationTracker,
  evaluateVerificationGate
} from '@main/agent/feedback/verification'

/** Real tsc-shaped diagnostic line — parseDiagnosticLines treats this as an error. */
const DIRTY_DIAGNOSTICS = "src/a.ts(3,10): error TS2345: Argument of type 'string' is not assignable."
const CLEAN_DIAGNOSTICS = 'No diagnostics found.'
const SKIPPED_TESTS = 'No test runner detected in this workspace; skipping.'
const PASSING_TESTS = 'Tests: 12 passed, 0 failed'
const FAILING_TESTS = 'Tests: 9 passed, 3 failed'

describe('verification tracker', () => {
  it('treats a clean check after a mutation as verified', () => {
    const t = createVerificationTracker()
    t.noteMutation('src/a.ts', true)
    t.noteToolResult('diagnostics', CLEAN_DIAGNOSTICS, true)

    expect(t.state().verifiedAfterLastMutation).toBe(true)
    expect(evaluateVerificationGate(t.state()).wouldFire).toBe(false)
  })

  it('does not credit a check that ran before the mutation', () => {
    const t = createVerificationTracker()
    t.noteToolResult('diagnostics', CLEAN_DIAGNOSTICS, true)
    t.noteMutation('src/a.ts', true)

    const verdict = evaluateVerificationGate(t.state())
    expect(verdict.wouldFire).toBe(true)
    expect(verdict.reason).toBe('never_checked')
    expect(verdict.paths).toEqual(['src/a.ts'])
  })

  it('treats a failing check after a mutation as unverified', () => {
    const t = createVerificationTracker()
    t.noteMutation('src/a.ts', true)
    t.noteToolResult('diagnostics', DIRTY_DIAGNOSTICS, true)

    expect(evaluateVerificationGate(t.state())).toMatchObject({
      wouldFire: true,
      reason: 'check_failed'
    })
  })

  it('reads failing run_tests as a failed check and passing as clean', () => {
    const failing = createVerificationTracker()
    failing.noteMutation('src/a.ts', true)
    failing.noteToolResult('run_tests', FAILING_TESTS, true)
    expect(evaluateVerificationGate(failing.state()).reason).toBe('check_failed')

    const passing = createVerificationTracker()
    passing.noteMutation('src/a.ts', true)
    passing.noteToolResult('run_tests', PASSING_TESTS, true)
    expect(evaluateVerificationGate(passing.state()).wouldFire).toBe(false)
  })

  it('does not let a skipped test runner stamp the verified state', () => {
    const t = createVerificationTracker()
    t.noteMutation('src/a.ts', true)
    t.noteToolResult('run_tests', SKIPPED_TESTS, true)

    // ok=true with no runner verified nothing — same rule the receipt applies.
    expect(evaluateVerificationGate(t.state())).toMatchObject({
      wouldFire: true,
      reason: 'never_checked'
    })
  })

  it('ignores a failed check result', () => {
    const t = createVerificationTracker()
    t.noteMutation('src/a.ts', true)
    t.noteToolResult('diagnostics', CLEAN_DIAGNOSTICS, false)

    expect(evaluateVerificationGate(t.state()).wouldFire).toBe(true)
  })

  it('does not count a mutation whose tool call failed', () => {
    const t = createVerificationTracker()
    t.noteMutation('src/a.ts', false)

    expect(t.state().mutated).toBe(false)
    expect(evaluateVerificationGate(t.state()).wouldFire).toBe(false)
  })

  it('never fires on a read-only turn', () => {
    const t = createVerificationTracker()
    t.noteToolResult('read', 'file contents', true)
    t.noteCheckpointFileCount(0)

    expect(t.state().mutated).toBe(false)
    expect(evaluateVerificationGate(t.state()).wouldFire).toBe(false)
  })

  it('catches a mutation that never passed through an edit-family tool', () => {
    // A terminal `sed -i`, an MCP writer or a watched out-of-band change
    // reaches the write checkpoint without any edit tool call.
    const t = createVerificationTracker()
    t.noteToolResult('terminal', 'exit 0', true)
    t.noteCheckpointFileCount(2)

    expect(t.state().mutated).toBe(true)
    expect(evaluateVerificationGate(t.state())).toMatchObject({
      wouldFire: true,
      reason: 'never_checked'
    })
  })

  it('keeps an edit and a clean check in the same step verified', () => {
    // Regression guard: the end-of-step checkpoint stamp must not re-order
    // itself after a same-step check and flip a verified turn to unverified.
    const t = createVerificationTracker()
    t.noteMutation('src/a.ts', true)
    t.noteToolResult('diagnostics', CLEAN_DIAGNOSTICS, true)
    t.noteCheckpointFileCount(1)

    expect(evaluateVerificationGate(t.state()).wouldFire).toBe(false)
  })

  it('skips the reconciliation when no checkpoint session is open', () => {
    const t = createVerificationTracker()
    t.noteCheckpointFileCount(3)
    t.noteToolResult('diagnostics', CLEAN_DIAGNOSTICS, true)
    // An absent session must not read as the count collapsing to zero and
    // then "growing" again into a phantom mutation.
    t.noteCheckpointFileCount(undefined)
    t.noteCheckpointFileCount(3)

    expect(evaluateVerificationGate(t.state()).wouldFire).toBe(false)
  })

  it('reports a later mutation as unverified once a check has gone stale', () => {
    const t = createVerificationTracker()
    t.noteMutation('src/a.ts', true)
    t.noteToolResult('diagnostics', CLEAN_DIAGNOSTICS, true)
    t.noteMutation('src/b.ts', true)

    const verdict = evaluateVerificationGate(t.state())
    expect(verdict.wouldFire).toBe(true)
    expect(verdict.paths).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('re-baselines when the write checkpoint is re-anchored mid-run', () => {
    // `flushWriteCheckpoint({reopen})` finalizes the session and opens a fresh
    // one with an empty file set at every follow-up / goal-continue boundary.
    // A stale high-water mark would swallow every later terminal write.
    const t = createVerificationTracker()
    t.noteCheckpointFileCount(2, 'cp-1')
    t.noteToolResult('diagnostics', CLEAN_DIAGNOSTICS, true)
    expect(evaluateVerificationGate(t.state()).wouldFire).toBe(false)

    // New session, one new file — fewer than the old mark, but still a mutation.
    t.noteCheckpointFileCount(1, 'cp-2')

    expect(evaluateVerificationGate(t.state())).toMatchObject({
      wouldFire: true,
      reason: 'never_checked'
    })
  })

  it('keeps the high-water mark within one checkpoint session', () => {
    const t = createVerificationTracker()
    t.noteCheckpointFileCount(3, 'cp-1')
    t.noteToolResult('diagnostics', CLEAN_DIAGNOSTICS, true)
    // Same session reporting the same count is not a new mutation.
    t.noteCheckpointFileCount(3, 'cp-1')

    expect(evaluateVerificationGate(t.state()).wouldFire).toBe(false)
  })

  it('closes the step even when no checkpoint session is open', () => {
    // The per-step "a tool already stamped this" flag must not leak forward,
    // or the next step's checkpoint growth is silently swallowed.
    const t = createVerificationTracker()
    t.noteMutation('src/a.ts', true)
    t.noteCheckpointFileCount(undefined)
    t.noteToolResult('diagnostics', CLEAN_DIAGNOSTICS, true)
    expect(evaluateVerificationGate(t.state()).wouldFire).toBe(false)

    // Next step: a terminal write with no edit tool must still register.
    t.noteCheckpointFileCount(1, 'cp-1')
    expect(evaluateVerificationGate(t.state())).toMatchObject({
      wouldFire: true,
      reason: 'never_checked'
    })
  })
})
