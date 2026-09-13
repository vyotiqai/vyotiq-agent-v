import { describe, expect, it } from 'vitest'
import {
  resolveLatestUserPromptId,
  resolveTasksAnchorUserId,
  shouldShowFloatingTasks
} from '@renderer/features/chat/utils/tasksAnchor'
import type { UiItem } from '@shared/transcript'

function user(id: string, content: string): UiItem {
  return { kind: 'message', id, role: 'user', content }
}

function todo(id: string, status: 'running' | 'done' | 'fail' = 'done'): UiItem {
  return {
    kind: 'tool',
    id,
    tool: { id, name: 'todo_write', summary: 'tasks', status }
  }
}

describe('resolveLatestUserPromptId', () => {
  it('returns the latest user prompt id', () => {
    expect(
      resolveLatestUserPromptId([
        user('user-0', 'first'),
        { kind: 'message', id: 'a1', role: 'assistant', content: 'ok' },
        user('user-2', 'follow-up')
      ])
    ).toBe('user-2')
  })

  it('returns null when there is no user prompt', () => {
    expect(resolveLatestUserPromptId([])).toBeNull()
  })
})

describe('resolveTasksAnchorUserId', () => {
  it('anchors to the user prompt preceding the first successful todo_write', () => {
    const items: UiItem[] = [
      user('user-0', 'first'),
      todo('t1'),
      { kind: 'message', id: 'a1', role: 'assistant', content: 'ok' },
      user('user-2', 'follow-up'),
      todo('t2')
    ]
    expect(resolveTasksAnchorUserId(items)).toBe('user-0')
  })

  it('does not move to a later follow-up user prompt', () => {
    const items: UiItem[] = [
      user('user-0', 'create tasks'),
      todo('t1', 'done'),
      user('user-2', 'something else'),
      { kind: 'message', id: 'a2', role: 'assistant', content: 'sure' }
    ]
    expect(resolveTasksAnchorUserId(items)).toBe('user-0')
  })

  it('skips failed todo_write when finding the creating turn', () => {
    const items: UiItem[] = [
      user('user-0', 'try'),
      todo('t-fail', 'fail'),
      user('user-2', 'retry'),
      todo('t-ok', 'done')
    ]
    expect(resolveTasksAnchorUserId(items)).toBe('user-2')
  })

  it('treats running todo_write as ownership', () => {
    const items: UiItem[] = [user('user-0', 'go'), todo('t1', 'running')]
    expect(resolveTasksAnchorUserId(items)).toBe('user-0')
  })

  it('returns null when no non-failed todo_write exists', () => {
    expect(
      resolveTasksAnchorUserId([
        user('user-0', 'hi'),
        { kind: 'message', id: 'a1', role: 'assistant', content: 'yo' }
      ])
    ).toBeNull()
    expect(resolveTasksAnchorUserId([user('user-0', 'hi'), todo('t1', 'fail')])).toBeNull()
  })
})

describe('shouldShowFloatingTasks', () => {
  it('shows when the anchor exists and the ceiling band is off-screen', () => {
    expect(
      shouldShowFloatingTasks({
        tasksAnchorUserId: 'user-0',
        anchorVisible: false,
        planPanelVisible: false
      })
    ).toBe(true)
  })

  it('hides when the ceiling band is still in view', () => {
    expect(
      shouldShowFloatingTasks({
        tasksAnchorUserId: 'user-0',
        anchorVisible: true,
        planPanelVisible: false
      })
    ).toBe(false)
  })

  it('hides when the Plan dock is already showing tasks', () => {
    expect(
      shouldShowFloatingTasks({
        tasksAnchorUserId: 'user-0',
        anchorVisible: false,
        planPanelVisible: true
      })
    ).toBe(false)
  })

  it('hides when there is no task-owning prompt', () => {
    expect(
      shouldShowFloatingTasks({
        tasksAnchorUserId: null,
        anchorVisible: false,
        planPanelVisible: false
      })
    ).toBe(false)
  })
})
