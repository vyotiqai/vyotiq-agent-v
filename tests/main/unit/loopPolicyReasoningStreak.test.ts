import { describe, expect, it } from 'vitest'
import {
  MAX_IDENTICAL_REASONING_STREAK_HINT,
  MAX_IDENTICAL_REASONING_STREAK_TERMINAL,
  loopHintForIdenticalReasoningStreak,
  loopStopDecision,
  nextIdenticalReasoningStreak,
  stepReasoningFingerprint
} from '../../../src/main/agent/loopPolicy'

/** Long shared reasoning body (> 1024 collapsed chars) so the tail dominates. */
const longSharedReasoning =
  'the task list already reflects current statuses so take the next concrete action. '.repeat(14)

describe('stepReasoningFingerprint', () => {
  it('is stable under case and whitespace differences', () => {
    const a = stepReasoningFingerprint(
      "I've gone in circles again. Let me reconstruct the task list.",
      'Recreating the plan now.'
    )
    const b = stepReasoningFingerprint(
      "  I'VE   GONE IN CIRCLES\tagain.\nLet me reconstruct the task list.  ",
      'Recreating  the plan\t now.'
    )
    expect(b).toBe(a)
  })

  it('is stable when prefixed with unrelated text (tail normalization)', () => {
    const a = stepReasoningFingerprint('totally unrelated preamble one. ' + longSharedReasoning, '')
    const b = stepReasoningFingerprint('a different unrelated preamble two. ' + longSharedReasoning, '')
    expect(b).toBe(a)
  })

  it('gives different fingerprints for different reasoning', () => {
    const a = stepReasoningFingerprint('first reasoning body', 'assistant text one')
    const b = stepReasoningFingerprint('second reasoning body', 'assistant text two')
    expect(b).not.toBe(a)
  })

  it("gives '' for empty (or whitespace-only) input", () => {
    expect(stepReasoningFingerprint('', '')).toBe('')
    expect(stepReasoningFingerprint('', '   ')).toBe('')
    expect(stepReasoningFingerprint(' \n\t ', ' \t ')).toBe('')
  })
})

describe('nextIdenticalReasoningStreak', () => {
  const fingerprint = stepReasoningFingerprint('repeat me', 'same assistant text')
  const other = stepReasoningFingerprint('other reasoning', 'different assistant text')

  it('resets to 0 on an empty fingerprint (nothing to compare must never accumulate)', () => {
    expect(nextIdenticalReasoningStreak(fingerprint, 5, '')).toBe(0)
    expect(nextIdenticalReasoningStreak('', 3, '')).toBe(0)
  })

  it('increments on an equal non-empty fingerprint', () => {
    expect(nextIdenticalReasoningStreak(fingerprint, 2, fingerprint)).toBe(3)
  })

  it('restarts at 1 on a different fingerprint', () => {
    expect(nextIdenticalReasoningStreak(fingerprint, 4, other)).toBe(1)
  })

  it('starts at 1 on the first step with reasoning', () => {
    expect(nextIdenticalReasoningStreak('', 0, fingerprint)).toBe(1)
  })
})

describe('loopHintForIdenticalReasoningStreak', () => {
  it('is undefined below the hint threshold', () => {
    expect(loopHintForIdenticalReasoningStreak(0)).toBeUndefined()
    expect(loopHintForIdenticalReasoningStreak(1)).toBeUndefined()
    expect(loopHintForIdenticalReasoningStreak(2)).toBeUndefined()
    expect(loopHintForIdenticalReasoningStreak(MAX_IDENTICAL_REASONING_STREAK_HINT - 1)).toBeUndefined()
  })

  it('is defined from the hint threshold on', () => {
    const hint = loopHintForIdenticalReasoningStreak(MAX_IDENTICAL_REASONING_STREAK_HINT)
    expect(hint).toBe(
      'You are repeating the same reasoning. The task list in your context already reflects current statuses; take the next concrete action instead of restating the plan.'
    )
    expect(loopHintForIdenticalReasoningStreak(MAX_IDENTICAL_REASONING_STREAK_TERMINAL)).toBe(hint)
  })
})

describe('loopStopDecision identical_reasoning_streak wiring', () => {
  it("returns 'identical_reasoning_streak' at the terminal threshold", () => {
    const stop = loopStopDecision({
      step: 10,
      identicalStepStreak: 1,
      identicalReasoningStreak: MAX_IDENTICAL_REASONING_STREAK_TERMINAL
    })
    expect(stop?.reason).toBe('identical_reasoning_streak')
    expect(stop?.message).toContain('near-identical reasoning repeated 6 steps in a row')
    expect(stop?.message).toContain('Resume from the task list with fresh actions.')
  })

  it("does not stop on reasoning at terminal threshold - 1 (identical_step_streak not reached either)", () => {
    const stop = loopStopDecision({
      step: 10,
      identicalStepStreak: 1,
      identicalReasoningStreak: MAX_IDENTICAL_REASONING_STREAK_TERMINAL - 1
    })
    expect(stop?.reason).not.toBe('identical_reasoning_streak')
    expect(stop).toBeUndefined()
  })

  it('returns identical_reasoning_streak over identical_step_streak when both are terminal', () => {
    const stop = loopStopDecision({
      step: 40,
      identicalStepStreak: 99,
      identicalReasoningStreak: MAX_IDENTICAL_REASONING_STREAK_TERMINAL
    })
    expect(stop?.reason).toBe('identical_reasoning_streak')
  })

  it('existing reasons still work', () => {
    const stepStop = loopStopDecision({ step: 20, identicalStepStreak: 8 })
    expect(stepStop?.reason).toBe('identical_step_streak')

    const failureStop = loopStopDecision({
      step: 30,
      identicalStepStreak: 1,
      consecutiveToolFailureSteps: 4
    })
    expect(failureStop?.reason).toBe('tool_failure_streak')
  })
})
