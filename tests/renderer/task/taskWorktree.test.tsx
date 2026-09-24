/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { TaskWorktreeInfo } from '@shared/ipc'
import {
  DISCARD_TASK_WORKTREE_EVENT,
  TaskWorktreeStrip,
  worktreeIsMerged,
  worktreeUnmerged,
  type DiscardTaskWorktreeDetail
} from '@renderer/features/task/taskWorktree'
import { getToasts, resetToastStoreForTests } from '@renderer/lib/ui/toastStore'

const INFO: TaskWorktreeInfo = {
  workspacePath: '/data/task-worktrees/abc/add-backpressure',
  worktreeRoot: '/data/task-worktrees/abc/add-backpressure',
  parentPath: '/ws/app',
  branch: 'vyotiq/add-backpressure',
  baseBranch: 'main',
  createdAt: '2026-09-24T10:00:00Z',
  ahead: 2,
  uncommitted: 3,
  parentExists: true
}

beforeEach(() => {
  window.vyotiq = {
    mergeTaskWorktree: vi.fn(async () => ({ ok: true as const, data: { merged: true as const, commits: 3, committedFirst: true } }))
  } as unknown as typeof window.vyotiq
})

afterEach(() => {
  cleanup()
  resetToastStoreForTests()
})

describe('worktree strip wording', () => {
  it('counts what the base does not have, and knows merged from nothing yet', () => {
    expect(worktreeUnmerged(INFO)).toBe('2 commits · 3 uncommitted files')
    expect(worktreeUnmerged({ ahead: 1, uncommitted: 0 })).toBe('1 commit')
    expect(worktreeUnmerged({ ahead: 0, uncommitted: 0 })).toBeNull()
    expect(worktreeIsMerged({ ahead: 0, uncommitted: 0, mergedAt: '2026-09-24T11:00:00Z' })).toBe(true)
    // Never merged: nothing yet is not "merged".
    expect(worktreeIsMerged({ ahead: 0, uncommitted: 0 })).toBe(false)
    // Merged, then worked on again.
    expect(worktreeIsMerged({ ahead: 1, uncommitted: 0, mergedAt: '2026-09-24T11:00:00Z' })).toBe(false)
  })
})

describe('TaskWorktreeStrip', () => {
  it('says where the task works and merges after asking, committing what is left under the task’s title', async () => {
    const onChanged = vi.fn()
    render(<TaskWorktreeStrip info={INFO} title="Add backpressure to the chat stream" onChanged={onChanged} />)
    const strip = document.querySelector('[data-task-worktree]') as HTMLElement
    expect(strip.textContent).toContain('Works in its own worktree, from main · 2 commits · 3 uncommitted files')

    fireEvent.click(within(strip).getByRole('button', { name: 'Merge into main' }))
    const dialog = await screen.findByRole('dialog', { name: 'Merge into main?' })
    expect(dialog.textContent).toContain(
      'Commits the 3 uncommitted files as “Add backpressure to the chat stream”, then merges vyotiq/add-backpressure into main in app.'
    )
    fireEvent.click(within(dialog).getByRole('button', { name: 'Merge' }))
    await waitFor(() =>
      expect(window.vyotiq.mergeTaskWorktree).toHaveBeenCalledWith(INFO.workspacePath, 'Add backpressure to the chat stream')
    )
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(getToasts().some((t) => t.message === 'Merged 3 commits into main')).toBe(true)
  })

  it('names the files when the merge would conflict, and says nothing changed', async () => {
    window.vyotiq.mergeTaskWorktree = vi.fn(async () => ({
      ok: true as const,
      data: { merged: false as const, conflicts: ['src/a.ts', 'src/b.ts'] }
    })) as unknown as typeof window.vyotiq.mergeTaskWorktree
    render(<TaskWorktreeStrip info={{ ...INFO, uncommitted: 0 }} title="T" onChanged={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Merge into main' }))
    const dialog = await screen.findByRole('dialog', { name: 'Merge into main?' })
    expect(dialog.textContent).toContain('Merges vyotiq/add-backpressure into main in app.')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Merge' }))
    await waitFor(() =>
      expect(getToasts().some((t) => t.message === 'Merging would conflict in 2 files — nothing was changed' && t.detail === 'src/a.ts, src/b.ts')).toBe(
        true
      )
    )
  })

  it('has nothing to merge before the task changed anything', () => {
    render(<TaskWorktreeStrip info={{ ...INFO, ahead: 0, uncommitted: 0 }} title="T" onChanged={() => {}} />)
    const merge = screen.getByRole('button', { name: 'Merge into main' }) as HTMLButtonElement
    expect(merge.disabled).toBe(true)
    expect(document.querySelector('[data-task-worktree]')!.textContent).toContain('Works in its own worktree, from main · nothing to merge yet')
  })

  it('Discard asks, naming what is lost, then hands the close to App', async () => {
    const seen: DiscardTaskWorktreeDetail[] = []
    const on = (e: Event): void => void seen.push((e as CustomEvent<DiscardTaskWorktreeDetail>).detail)
    window.addEventListener(DISCARD_TASK_WORKTREE_EVENT, on)
    render(<TaskWorktreeStrip info={INFO} title="T" onChanged={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    const dialog = await screen.findByRole('dialog', { name: 'Discard this worktree?' })
    expect(dialog.textContent).toContain(
      'Deletes the worktree’s folder and its branch vyotiq/add-backpressure, with 2 commits · 3 uncommitted files that main doesn’t have. This workspace closes.'
    )
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toEqual({ workspacePath: INFO.workspacePath, parentPath: '/ws/app', branch: INFO.branch, merged: false })
    window.removeEventListener(DISCARD_TASK_WORKTREE_EVENT, on)
  })

  it('merged, it only offers to remove the worktree', async () => {
    const seen: DiscardTaskWorktreeDetail[] = []
    const on = (e: Event): void => void seen.push((e as CustomEvent<DiscardTaskWorktreeDetail>).detail)
    window.addEventListener(DISCARD_TASK_WORKTREE_EVENT, on)
    render(
      <TaskWorktreeStrip info={{ ...INFO, ahead: 0, uncommitted: 0, mergedAt: '2026-09-24T11:00:00Z' }} title="T" onChanged={() => {}} />
    )
    const strip = document.querySelector('[data-task-worktree]') as HTMLElement
    expect(strip.textContent).toContain('Merged into main. The worktree has nothing main doesn’t.')
    expect(within(strip).queryByRole('button', { name: 'Merge into main' })).toBeNull()
    fireEvent.click(within(strip).getByRole('button', { name: 'Remove worktree' }))
    const dialog = await screen.findByRole('dialog', { name: 'Remove this worktree?' })
    expect(dialog.textContent).toContain('main already has everything on it')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(seen[0]?.merged).toBe(true))
    window.removeEventListener(DISCARD_TASK_WORKTREE_EVENT, on)
  })
})
