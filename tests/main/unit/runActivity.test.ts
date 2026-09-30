import { afterEach, describe, expect, it } from 'vitest'
import type { AgentEvent } from '@shared/ipc'
import { activityOf, clearRunActivity, noteRunActivity, resetRunActivityForTests, runActivityOf } from '@main/agent/runActivity'

const usage = (step: number): AgentEvent =>
  ({ type: 'context_usage', step, usedTokens: 1, maxTokens: 10 }) as unknown as AgentEvent
const toolStart = (name: string, summary: string): AgentEvent =>
  ({ type: 'tool_start', toolCallId: `call-${name}`, name, summary }) as unknown as AgentEvent

afterEach(resetRunActivityForTests)

describe('run activity', () => {
  it('names a tool by its running verb, on one line', () => {
    expect(activityOf('edit', 'src/login.ts')).toBe('Editing src/login.ts')
    expect(activityOf('read', '  a.ts\n  b.ts ')).toBe('Reading a.ts b.ts')
    expect(activityOf('mcp__x__y', 'thing')).toBe('mcp__x__y thing')
    expect(activityOf('read', 'x'.repeat(400))).toHaveLength(200)
  })

  it('thinks at a new step until it calls a tool, and keeps the tool through that step', () => {
    noteRunActivity('r', usage(1))
    expect(runActivityOf('r')).toBe('Thinking')
    noteRunActivity('r', toolStart('edit', 'src/a.ts'))
    expect(runActivityOf('r')).toBe('Editing src/a.ts')
    // A second usage report in the same step is not a new step.
    noteRunActivity('r', usage(1))
    expect(runActivityOf('r')).toBe('Editing src/a.ts')
    noteRunActivity('r', usage(2))
    expect(runActivityOf('r')).toBe('Thinking')
  })

  it('keeps runs apart and forgets one when it ends', () => {
    noteRunActivity('a', toolStart('read', 'x.ts'))
    noteRunActivity('b', usage(1))
    expect(runActivityOf('a')).toBe('Reading x.ts')
    clearRunActivity('a')
    expect(runActivityOf('a')).toBeUndefined()
    expect(runActivityOf('b')).toBe('Thinking')
  })
})
