import { describe, expect, it } from 'vitest'
import {
  registerRunAbort,
  cancelRun,
  clearRunAbort,
  resetActiveRunsForTests,
  chatCancelResult,
  isActive,
  markRunTurnComplete,
  listActiveRuns
} from '@main/agent/runRegistry'

describe('cancel registry', () => {
  it('registers, cancels, and reuses controllers within the same invoke', () => {
    resetActiveRunsForTests()
    const a = registerRunAbort('run-1', '/ws')
    const again = registerRunAbort('run-1', '/ws')
    expect(again.invokeId).toBe(a.invokeId)
    expect(again.controller).toBe(a.controller)
    expect(cancelRun('run-1')).toBe(true)
    expect(a.controller.signal.aborted).toBe(true)
    expect(cancelRun('missing')).toBe(false)
    clearRunAbort('run-1', a.invokeId)
  })

  it('chatCancelResult returns not found for missing runs', () => {
    resetActiveRunsForTests()
    const active = registerRunAbort('active', '/ws')
    expect(chatCancelResult('active')).toEqual({ ok: true, data: true })
    expect(chatCancelResult('gone')).toEqual({ ok: false, error: 'Run not found' })
    clearRunAbort('active', active.invokeId)
    expect(chatCancelResult('ephemeral')).toEqual({ ok: false, error: 'Run not found' })
  })

  it('allows re-registering a run after terminal clear', () => {
    resetActiveRunsForTests()
    const runId = 'session-run'
    const first = registerRunAbort(runId, '/ws')
    expect(isActive(runId)).toBe(true)
    clearRunAbort(runId, first.invokeId)
    expect(isActive(runId)).toBe(false)
    const second = registerRunAbort(runId, '/ws')
    expect(second.invokeId).not.toBe(first.invokeId)
    expect(isActive(runId)).toBe(true)
    clearRunAbort(runId, second.invokeId)
  })

  it('blocks a second invoke until the prior unwind clears', () => {
    resetActiveRunsForTests()
    const runId = 'session-run'
    const first = registerRunAbort(runId, '/ws')
    expect(isActive(runId)).toBe(true)

    markRunTurnComplete(runId, first.invokeId)
    // Still active while finally runs — chatStart must not overlap.
    expect(isActive(runId)).toBe(true)

    const second = registerRunAbort(runId, '/ws')
    expect(second.invokeId).toBe(first.invokeId)

    clearRunAbort(runId, first.invokeId)
    expect(isActive(runId)).toBe(false)

    const third = registerRunAbort(runId, '/ws')
    expect(third.invokeId).not.toBe(first.invokeId)
    clearRunAbort(runId, third.invokeId)
  })

  it('listActiveRuns includes turn-complete runs until clear', () => {
    resetActiveRunsForTests()
    const runId = 'session-run'
    const first = registerRunAbort(runId, '/ws')
    markRunTurnComplete(runId, first.invokeId)
    expect(listActiveRuns()).toEqual([
      { runId, workspacePath: '/ws', invokeId: first.invokeId, pendingFollowUps: [] }
    ])
    clearRunAbort(runId, first.invokeId)
    expect(listActiveRuns()).toEqual([])
  })
})
