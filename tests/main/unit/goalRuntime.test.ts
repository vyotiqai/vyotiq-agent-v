import { describe, expect, it } from 'vitest'
import {
  formatGoalContinueMessage,
  formatGoalInvocation,
  formatLoopStatusLine,
  GOAL_CONTINUE_PREFIX,
  loopUsageMessage,
  parseGoalInvocation,
  parseLoopCommand,
  shouldAutoContinueActiveGoal
} from '@shared/goalRuntime'

describe('goalRuntime', () => {
  it('parses /goal invocation text', () => {
    const text = formatGoalInvocation('fix flaky tests')
    expect(parseGoalInvocation(text)).toEqual({ objective: 'fix flaky tests' })
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
    expect(
      shouldAutoContinueActiveGoal({
        goalStatus: 'active',
        agentMode: 'plan',
        incomplete: false,
        consecutiveNoToolFinishes: 1
      })
    ).toBe('continue')
    expect(
      shouldAutoContinueActiveGoal({
        goalStatus: 'active',
        agentMode: 'plan',
        incomplete: false,
        consecutiveNoToolFinishes: 2
      })
    ).toBe('stop_wait')
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
})
