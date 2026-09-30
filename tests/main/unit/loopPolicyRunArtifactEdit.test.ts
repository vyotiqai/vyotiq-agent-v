import { describe, expect, it } from 'vitest'
import {
  isMechanicalStep,
  isNonMutatingWriteFailure,
  isRunArtifactEditPath
} from '@main/agent/loopPolicy'

describe('isRunArtifactEditPath', () => {
  it('matches plan.md and contract.md', () => {
    expect(isRunArtifactEditPath('plan.md')).toBe(true)
    expect(isRunArtifactEditPath('contract.md')).toBe(true)
  })

  it('normalizes a Windows-style backslash path', () => {
    expect(isRunArtifactEditPath('.\\plan.md')).toBe(true)
    expect(isRunArtifactEditPath('sub\\plan.md')).toBe(false)
  })

  it('normalizes a leading ./', () => {
    expect(isRunArtifactEditPath('./plan.md')).toBe(true)
    expect(isRunArtifactEditPath('./contract.md')).toBe(true)
  })

  it('does not match an unrelated path', () => {
    expect(isRunArtifactEditPath('docs/plan.md')).toBe(false)
    expect(isRunArtifactEditPath('src/main/agent/loopPolicy.ts')).toBe(false)
  })

  it('does not throw on undefined', () => {
    expect(isRunArtifactEditPath(undefined)).toBe(false)
  })
})

describe('todo_write is not a read-only mechanical tool', () => {
  it('keeps a todo-only step out of the mechanical streak', () => {
    expect(isMechanicalStep(['todo_write'], '')).toBe(false)
    expect(isMechanicalStep(['read', 'todo_write'], '')).toBe(false)
  })

  it('still counts a read-only navigation step as mechanical', () => {
    expect(isMechanicalStep(['read', 'grep'], '')).toBe(true)
  })
})

describe('isNonMutatingWriteFailure on a cancelled write', () => {
  it('treats an abort stub as a possible mutation, not a clean non-mutation', () => {
    expect(isNonMutatingWriteFailure('Cancelled')).toBe(false)
    expect(isNonMutatingWriteFailure('Interrupted')).toBe(false)
  })

  it('keeps the gate refusals classified as non-mutating', () => {
    expect(
      isNonMutatingWriteFailure(
        'Plan mode may only edit plan.md or contract.md (run plan artifacts).'
      )
    ).toBe(true)
    expect(isNonMutatingWriteFailure('Path escapes workspace')).toBe(true)
    expect(isNonMutatingWriteFailure('Diff hunk failed to match near line 150')).toBe(false)
  })
})
