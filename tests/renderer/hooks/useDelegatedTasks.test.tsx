/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import {
  resetDelegatedTasksStoreForTests,
  useDelegatedTasks
} from '@renderer/lib/hooks/useDelegatedTasks'
import type { DelegatedTask } from '@shared/ipc'

/**
 * The queue is read by the sidebar roster, the teammate detail and the task
 * inbox at once. These tests pin the property that makes that safe: they all
 * read ONE store, so no surface can show work another has already lost.
 */

function task(id: string, createdAt: string, patch: Partial<DelegatedTask> = {}): DelegatedTask {
  return {
    id,
    profileId: 'scout',
    workspacePath: '/ws-a',
    prompt: 'do ' + id,
    status: 'queued',
    createdAt,
    ...patch
  } as DelegatedTask
}

let pushHandler: ((event: { tasks: DelegatedTask[] }) => void) | null = null
let listCalls = 0

beforeEach(() => {
  resetDelegatedTasksStoreForTests()
  pushHandler = null
  listCalls = 0
  // @ts-expect-error test bridge
  window.vyotiq = {
    tasksList: vi.fn(async () => {
      listCalls += 1
      return { ok: true as const, data: [task('task-1', '2026-09-18T00:00:00.000Z')] }
    }),
    tasksEnqueue: vi.fn(async () => ({
      ok: true as const,
      data: task('task-2', '2026-09-19T00:00:00.000Z')
    })),
    tasksRetry: vi.fn(async () => ({
      ok: true as const,
      data: task('task-3', '2026-09-20T00:00:00.000Z', { retryOf: 'task-1' })
    })),
    tasksCancel: vi.fn(async () => ({ ok: true as const, data: true })),
    onTasksChanged: vi.fn((handler: (event: { tasks: DelegatedTask[] }) => void) => {
      pushHandler = handler
      return () => {
        pushHandler = null
      }
    })
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('useDelegatedTasks shared store', () => {
  it('loads the queue once no matter how many surfaces read it', async () => {
    const a = renderHook(() => useDelegatedTasks())
    const b = renderHook(() => useDelegatedTasks())
    const c = renderHook(() => useDelegatedTasks())

    await waitFor(() => expect(a.result.current.ready).toBe(true))
    expect(listCalls).toBe(1)
    expect(window.vyotiq.onTasksChanged).toHaveBeenCalledTimes(1)
    for (const hook of [a, b, c]) {
      expect(hook.result.current.tasks.map((t) => t.id)).toEqual(['task-1'])
    }
  })

  it('shows a task assigned on one surface to every other surface', async () => {
    const sidebar = renderHook(() => useDelegatedTasks())
    const inbox = renderHook(() => useDelegatedTasks())
    await waitFor(() => expect(sidebar.result.current.ready).toBe(true))

    await act(async () => {
      await inbox.result.current.enqueueTask({
        profileId: 'scout',
        workspacePath: '/ws-a',
        prompt: 'do task-2'
      })
    })

    expect(sidebar.result.current.tasks.map((t) => t.id)).toEqual(['task-2', 'task-1'])
    expect(inbox.result.current.tasks).toBe(sidebar.result.current.tasks)
  })

  it('keeps the queue newest-first after an optimistic insert', async () => {
    // main's listTasks sorts by createdAt descending. A bare prepend would put
    // an older record above a newer one until the next push re-sorted it, and
    // the row would visibly jump.
    // @ts-expect-error test bridge
    window.vyotiq.tasksEnqueue = vi.fn(async () => ({
      ok: true as const,
      data: task('task-old', '2020-01-01T00:00:00.000Z')
    }))
    const hook = renderHook(() => useDelegatedTasks())
    await waitFor(() => expect(hook.result.current.ready).toBe(true))

    await act(async () => {
      await hook.result.current.enqueueTask({
        profileId: 'scout',
        workspacePath: '/ws-a',
        prompt: 'do task-old'
      })
    })

    expect(hook.result.current.tasks.map((t) => t.id)).toEqual(['task-1', 'task-old'])
  })

  it('does not duplicate a record a push already delivered', async () => {
    const hook = renderHook(() => useDelegatedTasks())
    await waitFor(() => expect(hook.result.current.ready).toBe(true))

    act(() =>
      pushHandler?.({
        tasks: [
          task('task-2', '2026-09-19T00:00:00.000Z'),
          task('task-1', '2026-09-18T00:00:00.000Z')
        ]
      })
    )
    await act(async () => {
      await hook.result.current.enqueueTask({
        profileId: 'scout',
        workspacePath: '/ws-a',
        prompt: 'do task-2'
      })
    })

    expect(hook.result.current.tasks.map((t) => t.id)).toEqual(['task-2', 'task-1'])
  })

  it('applies a push to every subscriber', async () => {
    const a = renderHook(() => useDelegatedTasks())
    const b = renderHook(() => useDelegatedTasks())
    await waitFor(() => expect(a.result.current.ready).toBe(true))

    act(() => pushHandler?.({ tasks: [task('task-9', '2026-09-21T00:00:00.000Z')] }))

    expect(a.result.current.tasks.map((t) => t.id)).toEqual(['task-9'])
    expect(b.result.current.tasks.map((t) => t.id)).toEqual(['task-9'])
  })

  it('surfaces a refused cancel, which has no other route to the user', async () => {
    // Main answers `false` when the task was already terminal, and emits no
    // push in that case. Callers discard the boolean, so without this the
    // click does nothing and explains nothing.
    // @ts-expect-error test bridge
    window.vyotiq.tasksCancel = vi.fn(async () => ({ ok: true as const, data: false }))
    const sidebar = renderHook(() => useDelegatedTasks())
    const inbox = renderHook(() => useDelegatedTasks())
    await waitFor(() => expect(sidebar.result.current.ready).toBe(true))

    let stopped: boolean | undefined
    await act(async () => {
      stopped = await inbox.result.current.cancelTask('task-1')
    })

    expect(stopped).toBe(false)
    expect(sidebar.result.current.error).toBe(
      'That task had already finished — there was nothing to stop.'
    )
  })

  it('passes a failed cancel call through with main own reason', async () => {
    // @ts-expect-error test bridge
    window.vyotiq.tasksCancel = vi.fn(async () => ({
      ok: false as const,
      error: 'Workspace is not open'
    }))
    const hook = renderHook(() => useDelegatedTasks())
    await waitFor(() => expect(hook.result.current.ready).toBe(true))

    await act(async () => {
      await hook.result.current.cancelTask('task-1')
    })

    expect(hook.result.current.error).toBe('Workspace is not open')
    act(() => hook.result.current.clearError())
    expect(hook.result.current.error).toBeNull()
  })

  it('returns an assign failure to the caller instead of storing it twice', async () => {
    // enqueue/retry hand the reason back through EnqueueTaskOutcome and the
    // caller reports it, so storing it as well would show one failure twice.
    // @ts-expect-error test bridge
    window.vyotiq.tasksEnqueue = vi.fn(async () => ({
      ok: false as const,
      error: 'Workspace is not open'
    }))
    const hook = renderHook(() => useDelegatedTasks())
    await waitFor(() => expect(hook.result.current.ready).toBe(true))

    let outcome: { ok: boolean; error?: string } | undefined
    await act(async () => {
      outcome = await hook.result.current.enqueueTask({
        profileId: 'scout',
        workspacePath: '/ws-a',
        prompt: 'nope'
      })
    })

    expect(outcome).toEqual({ ok: false, error: 'Workspace is not open' })
    expect(hook.result.current.error).toBeNull()
  })

  it('records a retry clone so its provenance reaches every surface', async () => {
    const hook = renderHook(() => useDelegatedTasks())
    await waitFor(() => expect(hook.result.current.ready).toBe(true))

    await act(async () => {
      await hook.result.current.retryTask('task-1')
    })

    const clone = hook.result.current.tasks.find((t) => t.id === 'task-3')
    expect(clone?.retryOf).toBe('task-1')
    expect(hook.result.current.tasks.map((t) => t.id)).toEqual(['task-3', 'task-1'])
  })

  it('reports a failed load instead of spinning forever', async () => {
    resetDelegatedTasksStoreForTests()
    // @ts-expect-error test bridge
    window.vyotiq.tasksList = vi.fn(async () => ({
      ok: false as const,
      error: 'Task service unavailable'
    }))
    const hook = renderHook(() => useDelegatedTasks())

    await waitFor(() => expect(hook.result.current.ready).toBe(true))
    expect(hook.result.current.error).toBe('Task service unavailable')
  })

  it('retries the load if the preload bridge was not there yet', async () => {
    // Latching "started" with no bridge to call would leave the queue empty
    // for the rest of the session rather than for one render.
    const bridge = window.vyotiq
    // @ts-expect-error test bridge
    window.vyotiq = undefined
    const early = renderHook(() => useDelegatedTasks())
    expect(early.result.current.ready).toBe(false)
    expect(listCalls).toBe(0)
    early.unmount()

    // @ts-expect-error test bridge
    window.vyotiq = bridge
    const later = renderHook(() => useDelegatedTasks())
    await waitFor(() => expect(later.result.current.ready).toBe(true))
    expect(later.result.current.tasks.map((t) => t.id)).toEqual(['task-1'])
  })

  it('keeps receiving pushes after one subscriber unmounts', async () => {
    const staying = renderHook(() => useDelegatedTasks())
    const leaving = renderHook(() => useDelegatedTasks())
    await waitFor(() => expect(staying.result.current.ready).toBe(true))

    leaving.unmount()
    act(() => pushHandler?.({ tasks: [task('task-9', '2026-09-21T00:00:00.000Z')] }))

    // The push subscription is app-lifetime on purpose: tearing it down with
    // the last unmount would leave the next mount silently stale.
    expect(staying.result.current.tasks.map((t) => t.id)).toEqual(['task-9'])
  })
})
