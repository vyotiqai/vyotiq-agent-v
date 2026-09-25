import { describe, expect, it } from 'vitest'
import {
  formatGoalContinueMessage,
  formatGoalInvocation,
  formatLoopStatusLine,
  GOAL_CONTINUE_PREFIX,
  loopUsageMessage,
  parseGoalInvocation,
  parseLoopCommand,
  shouldAutoContinueActiveGoal,
  GOAL_CONTINUE_BUDGET
} from '@shared/goalRuntime'

describe('goalRuntime', () => {
  it('parses /goal invocation text', () => {
    const text = formatGoalInvocation('fix flaky tests')
    expect(parseGoalInvocation(text)).toEqual({ objective: 'fix flaky tests' })
    // The /goal path seeds the goal itself, so the message must not send the
    // model to create_goal — that tool proposes, and a live user goal refuses
    // to be replaced, so the instruction would only produce a failed call.
    expect(text).not.toMatch(/create_goal/)
    expect(text).toMatch(/now active/i)
    expect(parseGoalInvocation('plain chat')).toBeNull()
    expect(formatGoalContinueMessage('fix flaky tests').startsWith(GOAL_CONTINUE_PREFIX)).toBe(true)
  })

  it('parses /loop intervals and bounds', () => {
    expect(parseLoopCommand('')).toEqual({ kind: 'status' })
    expect(parseLoopCommand('stop')).toEqual({ kind: 'stop' })
    expect(parseLoopCommand('check CI')).toEqual({ kind: 'usage' })
    expect(parseLoopCommand('30s check CI')).toEqual({
      kind: 'arm',
      intervalMs: 30_000,
      prompt: 'check CI'
    })
    expect(parseLoopCommand('5m ping')).toEqual({
      kind: 'arm',
      intervalMs: 300_000,
      prompt: 'ping'
    })
    expect(parseLoopCommand('29s too fast').kind).toBe('error')
    expect(parseLoopCommand('2d too long').kind).toBe('error')
    expect(loopUsageMessage()).toMatch(/30s/)
    expect(formatLoopStatusLine(null)).toMatch(/No loop/)
  })

  it('auto-continues once then waits after two no-tool finishes', () => {
    expect(
      shouldAutoContinueActiveGoal({
        goalStatus: 'active',
        agentMode: 'agent',
        incomplete: false,
        consecutiveNoToolFinishes: 1
      })
    ).toBe('continue')
    expect(
      shouldAutoContinueActiveGoal({
        goalStatus: 'active',
        agentMode: 'agent',
        incomplete: false,
        consecutiveNoToolFinishes: 2
      })
    ).toBe('stop_wait')
    // Was asserted for Plan, which behaved exactly like Agent here and is now
    // merged into it. Ask is the only mode that diverges — covered below.
    expect(
      shouldAutoContinueActiveGoal({
        goalStatus: 'active',
        agentMode: 'agent',
        incomplete: false,
        consecutiveNoToolFinishes: 1
      })
    ).toBe('continue')
    expect(
      shouldAutoContinueActiveGoal({
        goalStatus: 'active',
        agentMode: 'ask',
        incomplete: false,
        consecutiveNoToolFinishes: 1
      })
    ).toBe('none')
    expect(
      shouldAutoContinueActiveGoal({
        goalStatus: 'paused',
        agentMode: 'agent',
        incomplete: false,
        consecutiveNoToolFinishes: 1
      })
    ).toBe('none')
    expect(
      shouldAutoContinueActiveGoal({
        goalStatus: 'active',
        agentMode: 'agent',
        incomplete: true,
        consecutiveNoToolFinishes: 1
      })
    ).toBe('none')
  })
  it('holds a proposed goal inert', () => {
    // Every unattended power keys off `active`; a proposal must never continue.
    expect(
      shouldAutoContinueActiveGoal({
        goalStatus: 'proposed',
        agentMode: 'agent',
        incomplete: false,
        consecutiveNoToolFinishes: 0
      })
    ).toBe('none')
  })

  it('stops on the auto-continue budget even while tools keep the streak at zero', () => {
    const base = {
      goalStatus: 'active' as const,
      agentMode: 'agent' as const,
      incomplete: false,
      consecutiveNoToolFinishes: 0
    }
    expect(
      shouldAutoContinueActiveGoal({ ...base, continueCount: GOAL_CONTINUE_BUDGET - 1 })
    ).toBe('continue')
    expect(shouldAutoContinueActiveGoal({ ...base, continueCount: GOAL_CONTINUE_BUDGET })).toBe(
      'stop_budget'
    )
    expect(
      shouldAutoContinueActiveGoal({ ...base, continueCount: GOAL_CONTINUE_BUDGET + 10 })
    ).toBe('stop_budget')
  })
})
