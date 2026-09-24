/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { TaskDraft } from '@shared/ipc'
import {
  briefStateFor,
  deleteTaskDraftFor,
  resetTaskDraftStoreForTests,
  saveTaskDraftFor,
  setBriefChecks,
  setBriefState,
  setBriefWorktree,
  useTaskDrafts
} from '@renderer/lib/drafts/taskDraftStore'

afterEach(() => resetTaskDraftStoreForTests())

const draft = (id: string, brief: string, updatedAt = '2026-09-24T10:00:00Z'): TaskDraft => ({
  id,
  brief,
  doneWhen: [],
  createdAt: updatedAt,
  updatedAt
})

const A = 'd0000000-0000-4000-8000-0000000000a1'
const B = 'd0000000-0000-4000-8000-0000000000b2'

describe('task draft store', () => {
  it('loads a workspace’s drafts once, and again when the revision moves', async () => {
    let onDisk = [draft(A, 'First')]
    const listTaskDrafts = vi.fn(async () => ({ ok: true as const, data: { drafts: onDisk } }))
    window.vyotiq = { listTaskDrafts } as unknown as typeof window.vyotiq
    const { result, rerender } = renderHook(({ revision }) => useTaskDrafts(['/ws'], revision), { initialProps: { revision: 1 } })
    await waitFor(() => expect(result.current.map((d) => d.draft.brief)).toEqual(['First']))
    rerender({ revision: 1 })
    expect(listTaskDrafts).toHaveBeenCalledTimes(1)
    onDisk = []
    rerender({ revision: 2 })
    await waitFor(() => expect(result.current).toEqual([]))
    expect(listTaskDrafts).toHaveBeenCalledTimes(2)
  })

  it('a save shows at once, newest first; a delete drops it and ends continuing it', async () => {
    const saved = draft(B, 'Second', '2026-09-24T11:00:00Z')
    window.vyotiq = {
      listTaskDrafts: vi.fn(async () => ({ ok: true as const, data: { drafts: [draft(A, 'First')] } })),
      saveTaskDraft: vi.fn(async () => ({ ok: true as const, data: saved })),
      deleteTaskDraft: vi.fn(async () => ({ ok: true as const, data: true }))
    } as unknown as typeof window.vyotiq
    const { result } = renderHook(() => useTaskDrafts(['/ws']))
    await waitFor(() => expect(result.current).toHaveLength(1))
    await act(async () => {
      await saveTaskDraftFor({ workspacePath: '/ws', brief: 'Second', doneWhen: [] })
    })
    expect(result.current.map((d) => d.draft.id)).toEqual([B, A])

    setBriefState('/ws', { draftId: B, checks: ['Typed on the page'] })
    await act(async () => {
      await deleteTaskDraftFor('/ws', B)
    })
    expect(result.current.map((d) => d.draft.id)).toEqual([A])
    // Not continuing a draft that is gone — but what is on the page stays.
    expect(briefStateFor('/ws')).toEqual({ draftId: null, checks: ['Typed on the page'], worktree: false })
  })

  it('an empty page state is no state at all', () => {
    setBriefState('/ws', { draftId: null, checks: [] })
    expect(briefStateFor('/ws')).toEqual({ draftId: null, checks: [], worktree: false })
    setBriefState('/ws', { draftId: A, checks: [] })
    expect(briefStateFor('/ws').draftId).toBe(A)
    setBriefState('/ws', null)
    expect(briefStateFor('/ws').draftId).toBeNull()
  })

  it('keeps New worktree picked on its own, and through its checks changing', () => {
    setBriefWorktree('/ws', true)
    expect(briefStateFor('/ws')).toEqual({ draftId: null, checks: [], worktree: true })
    setBriefChecks('/ws', ['A check'])
    expect(briefStateFor('/ws').worktree).toBe(true)
    setBriefWorktree('/ws', false)
    setBriefChecks('/ws', [])
    expect(briefStateFor('/ws')).toEqual({ draftId: null, checks: [], worktree: false })
  })
})
