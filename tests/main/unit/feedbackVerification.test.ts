import { describe, expect, it } from 'vitest'
import {
  createVerificationTracker,
  evaluateVerificationGate,
  verificationNudgeText
} from '@main/agent/feedback/verification'

/** Real tsc-shaped diagnostic line — parseDiagnosticLines treats this as an error. */
const DIRTY_DIAGNOSTICS = "src/a.ts(3,10): error TS2345: Argument of type 'string' is not assignable."
const CLEAN_DIAGNOSTICS = 'No diagnostics found.'
const SKIPPED_TESTS = 'No test runner detected in this workspace; skipping.'
const PASSING_TESTS = 'Tests: 12 passed, 0 failed'
const FAILING_TESTS = 'Tests: 9 passed, 3 failed'
// The shapes the real tools return (tools/runTests.ts, tools/diagnostics.ts):
// a failing test run exits non-zero, so it arrives `ok: false`.
const FAILING_TESTS_RESULT =
  'command: pnpm run test\nexit: 1\nTests: 9 passed, 3 failed (exit 1)\n✖ adds two numbers'
const TESTS_TIMED_OUT = 'command: pnpm run test\nTest command was killed (timeout)\nRUN v4'
const SKIPPED_TYPECHECK = 'No TypeScript project (no tsconfig / typecheck script); typecheck skipped.'
const DENIED_DIAGNOSTICS =
  'diagnostics is denied for path_scope-shared inline instances without a worktree. Use edit/str_replace within path_scope.'
const UNPARSEABLE_COMMAND = 'command: node -e console.log(1)\nDisallowed character in diagnostics command: ('

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

  // A failing test run is `ok: false`. Dropping it as if it never ran let the
  // earlier clean diagnostics stand, and the turn read verified.
  it('reads a failing test run after a clean check as a failed check', () => {
    const t = createVerificationTracker()
    t.noteMutation('src/a.ts', true)
    t.noteToolResult('diagnostics', CLEAN_DIAGNOSTICS, true)
    t.noteToolResult('run_tests', FAILING_TESTS_RESULT, false)

    expect(t.state().verifiedAfterLastMutation).toBe(false)
    expect(evaluateVerificationGate(t.state())).toMatchObject({
      wouldFire: true,
      reason: 'check_failed'
    })
  })

  it('reads a timed-out test run as a failed check', () => {
    const t = createVerificationTracker()
    t.noteMutation('src/a.ts', true)
    t.noteToolResult('run_tests', TESTS_TIMED_OUT, false)

    expect(evaluateVerificationGate(t.state()).reason).toBe('check_failed')
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

  it('does not let a skipped typecheck stamp the verified state', () => {
    const t = createVerificationTracker()
    t.noteMutation('src/main.py', true)
    t.noteToolResult('diagnostics', SKIPPED_TYPECHECK, true)

    expect(evaluateVerificationGate(t.state())).toMatchObject({
      wouldFire: true,
      reason: 'never_checked'
    })
  })

  // The same empty result the receipt refuses to read as a pass: `ok: true`
  // with no body proved nothing, and the gate said verified.
  it('does not let an empty-bodied check stamp the verified state', () => {
    const t = createVerificationTracker()
    t.noteMutation('src/a.ts', true)
    t.noteToolResult('diagnostics', '', true)

    expect(t.state().verifiedAfterLastMutation).toBe(false)
    expect(evaluateVerificationGate(t.state())).toMatchObject({
      wouldFire: true,
      reason: 'never_checked'
    })

    // Whitespace-only is the same: nothing ran, nothing was proven.
    const blank = createVerificationTracker()
    blank.noteMutation('src/a.ts', true)
    blank.noteToolResult('run_tests', '   \n ', true)
    expect(evaluateVerificationGate(blank.state()).reason).toBe('never_checked')

    // An earlier clean check still stands; the empty body adds no failure to it.
    const earlier = createVerificationTracker()
    earlier.noteMutation('src/a.ts', true)
    earlier.noteToolResult('run_tests', PASSING_TESTS, true)
    earlier.noteToolResult('diagnostics', '', true)
    expect(earlier.state().verifiedAfterLastMutation).toBe(true)
    expect(evaluateVerificationGate(earlier.state()).wouldFire).toBe(false)
  })

  it('treats a check that never started as absent, not failed', () => {
    const t = createVerificationTracker()
    t.noteMutation('src/a.ts', true)
    t.noteToolResult('diagnostics', CLEAN_DIAGNOSTICS, false)
    t.noteToolResult('diagnostics', DENIED_DIAGNOSTICS, false)
    t.noteToolResult('run_tests', UNPARSEABLE_COMMAND, false)

    expect(evaluateVerificationGate(t.state())).toMatchObject({
      wouldFire: true,
      reason: 'never_checked'
    })

    // …and a clean check before it still stands.
    const earlier = createVerificationTracker()
    earlier.noteMutation('src/a.ts', true)
    earlier.noteToolResult('run_tests', PASSING_TESTS, true)
    earlier.noteToolResult('diagnostics', DENIED_DIAGNOSTICS, false)
    expect(earlier.state().verifiedAfterLastMutation).toBe(true)
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
    t.noteOtherWriteCount(0)

    expect(t.state().mutated).toBe(false)
    expect(evaluateVerificationGate(t.state()).wouldFire).toBe(false)
  })

  it('catches a mutation that never passed through an edit-family tool', () => {
    // A terminal `sed -i`, an MCP writer or a watched out-of-band change
    // reaches the write checkpoint without any edit tool call.
    const t = createVerificationTracker()
    t.noteOtherWriteCount(2)
    t.noteToolResult('terminal', 'exit 0', true)

    expect(t.state().mutated).toBe(true)
    expect(evaluateVerificationGate(t.state())).toMatchObject({
      wouldFire: true,
      reason: 'never_checked'
    })
  })

  it('keeps an edit and a clean check in the same step verified', () => {
    // Edit tools never move the other-write count, so the step-end
    // reconciliation after a same-step check stamps nothing.
    const t = createVerificationTracker()
    t.noteMutation('src/a.ts', true)
    t.noteOtherWriteCount(0)
    t.noteToolResult('diagnostics', CLEAN_DIAGNOSTICS, true)
    t.noteOtherWriteCount(0)

    expect(evaluateVerificationGate(t.state()).wouldFire).toBe(false)
  })

  // Reconciled after every tool call, so a terminal write lands where it
  // happened: one before the check is verified, one after it is not.
  it('orders a non-edit write against the checks around it', () => {
    const before = createVerificationTracker()
    before.noteOtherWriteCount(1, 'cp-1') // terminal write
    before.noteOtherWriteCount(1, 'cp-1')
    before.noteToolResult('diagnostics', CLEAN_DIAGNOSTICS, true)
    before.noteOtherWriteCount(1, 'cp-1') // step end
    expect(evaluateVerificationGate(before.state()).wouldFire).toBe(false)

    const after = createVerificationTracker()
    after.noteMutation('src/a.ts', true)
    after.noteOtherWriteCount(0, 'cp-1')
    after.noteToolResult('run_tests', PASSING_TESTS, true)
    after.noteOtherWriteCount(1, 'cp-1') // terminal re-write of src/a.ts
    expect(evaluateVerificationGate(after.state())).toMatchObject({
      wouldFire: true,
      reason: 'never_checked'
    })
  })

  it('skips the reconciliation when no checkpoint session is open', () => {
    const t = createVerificationTracker()
    t.noteOtherWriteCount(3)
    t.noteToolResult('diagnostics', CLEAN_DIAGNOSTICS, true)
    // An absent session must not read as the count collapsing to zero and
    // then "growing" again into a phantom mutation.
    t.noteOtherWriteCount(undefined)
    t.noteOtherWriteCount(3)

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
    // one with a zero count at every follow-up / goal-continue boundary.
    // A stale high-water mark would swallow every later terminal write.
    const t = createVerificationTracker()
    t.noteOtherWriteCount(2, 'cp-1')
    t.noteToolResult('diagnostics', CLEAN_DIAGNOSTICS, true)
    expect(evaluateVerificationGate(t.state()).wouldFire).toBe(false)

    // New session, one new write — fewer than the old mark, but still a mutation.
    t.noteOtherWriteCount(1, 'cp-2')

    expect(evaluateVerificationGate(t.state())).toMatchObject({
      wouldFire: true,
      reason: 'never_checked'
    })
  })

  it('keeps the high-water mark within one checkpoint session', () => {
    const t = createVerificationTracker()
    t.noteOtherWriteCount(3, 'cp-1')
    t.noteToolResult('diagnostics', CLEAN_DIAGNOSTICS, true)
    // Same session reporting the same count is not a new mutation.
    t.noteOtherWriteCount(3, 'cp-1')

    expect(evaluateVerificationGate(t.state()).wouldFire).toBe(false)
  })

  it('still registers a later non-edit write after an absent session', () => {
    const t = createVerificationTracker()
    t.noteMutation('src/a.ts', true)
    t.noteOtherWriteCount(undefined)
    t.noteToolResult('diagnostics', CLEAN_DIAGNOSTICS, true)
    expect(evaluateVerificationGate(t.state()).wouldFire).toBe(false)

    // Next step: a terminal write with no edit tool must still register.
    t.noteOtherWriteCount(1, 'cp-1')
    expect(evaluateVerificationGate(t.state())).toMatchObject({
      wouldFire: true,
      reason: 'never_checked'
    })
  })
})

describe('terminal checks', () => {
  const PASS = 'cwd: /ws\n\n Test Files  1 passed (1)\n      Tests  4 passed (4)\n\nexit_code: 0\n\n[Tool hint] use read'
  const FAIL = 'cwd: /ws\n\n Tests  1 failed | 3 passed (4)\n\nexit_code: 1'
  const RUNNING = 'session_id: s1\nstatus: running\ncommand: pnpm vitest\n\nRUN v4\n\nexit_code: -1'

  it('counts a recognised test run by its exit code', () => {
    const t = createVerificationTracker()
    t.noteMutation('src/a.ts', true)
    t.noteToolResult('terminal', PASS, true, 'pnpm vitest run tests/a.test.ts')
    expect(t.state().verifiedAfterLastMutation).toBe(true)

    const failed = createVerificationTracker()
    failed.noteMutation('src/a.ts', true)
    failed.noteToolResult('terminal', FAIL, false, 'pnpm vitest run')
    expect(evaluateVerificationGate(failed.state()).reason).toBe('check_failed')
  })

  it('does not count other commands, or a run still going', () => {
    const t = createVerificationTracker()
    t.noteMutation('src/a.ts', true)
    t.noteToolResult('terminal', 'cwd: /ws\n\nPython 3.12\n\nexit_code: 0', true, 'python --version')
    t.noteToolResult('terminal', RUNNING, true, 'pnpm vitest')
    expect(evaluateVerificationGate(t.state()).reason).toBe('never_checked')
  })

  it('reads the command from a session poll header when the call has none', () => {
    const t = createVerificationTracker()
    t.noteMutation('src/a.ts', true)
    t.noteToolResult('terminal', 'session_id: s1\nstatus: done\ncommand: pnpm test\n\nok\n\nexit_code: 0', true)
    expect(t.state().verifiedAfterLastMutation).toBe(true)
  })
})

describe('verificationNudgeText', () => {
  it('names a sample of the changed paths and asks for a check or an honest answer', () => {
    const text = verificationNudgeText({
      wouldFire: true,
      reason: 'never_checked',
      paths: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts']
    })
    expect(text).toContain('(a.ts, b.ts, c.ts, d.ts, e.ts, +2 more)')
    expect(text).toContain('run the narrowest check')
    expect(text).toContain('say in your answer exactly what is unverified')
  })

  it('asks to fix a failed check', () => {
    const text = verificationNudgeText({ wouldFire: true, reason: 'check_failed', paths: [] })
    expect(text).toContain('did not pass')
    expect(text).not.toContain('()')
  })
})
