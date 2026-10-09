import { describe, expect, it } from 'vitest'
import type { RunSummary } from '@shared/ipc'
import { branchesLostOnDelete, deleteTasksMessage } from '@renderer/app/deleteTaskCopy'

function instance(runId: string, parentRunId: string, worktreeBranch?: string): RunSummary {
  return { runId, parentRunId, status: 'done', updatedAt: '2026-10-09T00:00:00Z', ...(worktreeBranch ? { worktreeBranch } : {}) }
}

describe('delete task confirmation', () => {
  it('says the task goes to Recently deleted, from the header and the navigator alike', () => {
    // The header used to say the record "is removed" while the navigator said
    // Recently deleted — the same delete, told two ways.
    expect(deleteTasksMessage({ count: 1, title: 'Fix add()', branches: 0 })).toBe(
      'Delete “Fix add()”? It goes to Recently deleted for 30 days; files it changed stay as they are.'
    )
    expect(deleteTasksMessage({ count: 1, branches: 0 })).toMatch(/^Delete this task\? It goes to Recently deleted/)
    expect(deleteTasksMessage({ count: 3, branches: 0 })).toBe(
      'Delete these 3 tasks? They go to Recently deleted for 30 days; files they changed stay as they are.'
    )
  })

  it('warns that helper-instance branches do not come back', () => {
    expect(deleteTasksMessage({ count: 1, branches: 1 })).toContain(
      'The branch its helper instances kept is deleted for good, with any commits not merged yet.'
    )
    expect(deleteTasksMessage({ count: 2, branches: 3 })).toContain('The 3 branches their helper instances kept are deleted for good')
  })

  it('counts only the branches of the deleted tasks’ own instances', () => {
    const runs = [instance('c1', 'p1', 'agent/c1'), instance('c2', 'p1'), instance('c3', 'p2', 'agent/c3')]
    expect(branchesLostOnDelete(['p1'], runs)).toBe(1)
    expect(branchesLostOnDelete(['p1', 'p2'], runs)).toBe(2)
    expect(branchesLostOnDelete(['other'], runs)).toBe(0)
    expect(branchesLostOnDelete(['p1'])).toBe(0)
  })
})
