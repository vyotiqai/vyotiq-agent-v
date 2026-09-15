import { describe, expect, it } from 'vitest'
import { needsDraftChatAfterWorkspaceAdd } from '../../../src/renderer/src/app/workspaceAddHandoff'

describe('needsDraftChatAfterWorkspaceAdd', () => {
  it('opens a draft chat when the added workspace has no active run', () => {
    expect(needsDraftChatAfterWorkspaceAdd(null)).toBe(true)
  })

  it('keeps the persisted run when re-adding a workspace with an active run', () => {
    expect(needsDraftChatAfterWorkspaceAdd('run-abc')).toBe(false)
  })
})
