import { describe, expect, it } from 'vitest'
import type { ActiveRun } from '@shared/ipc'
import { sameActiveRuns } from '@renderer/lib/chat/activeRunsSignal'

const run = (over: Partial<ActiveRun> = {}): ActiveRun => ({
  runId: 'r1',
  workspacePath: 'C:/ws',
  invokeId: 1,
  pendingFollowUps: [],
  ...over
})
const samePath = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

describe('sameActiveRuns', () => {
  it('re-renders when a running task starts doing something else', () => {
    expect(sameActiveRuns([run({ activity: 'Thinking' })], [run({ activity: 'Thinking' })], samePath)).toBe(true)
    expect(sameActiveRuns([run({ activity: 'Thinking' })], [run({ activity: 'Editing a.ts' })], samePath)).toBe(false)
    expect(sameActiveRuns([run()], [run({ activity: 'Thinking' })], samePath)).toBe(false)
  })

  it('ignores what the navigator does not show', () => {
    expect(sameActiveRuns([run({ invokeId: 1 })], [run({ invokeId: 2, workspacePath: 'c:/WS' })], samePath)).toBe(true)
  })
})
