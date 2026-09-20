import { useSyncExternalStore } from 'react'
import type { DelegatedTask, TaskEnqueueRequest } from '@shared/ipc'

/**
 * One delegated-task queue for the whole renderer.
 *
 * This was a per-component `useState` + `useEffect`, which worked only because
 * exactly one surface read it. Every extra reader would have meant another
 * `tasksList` fetch and another `onTasksChanged` subscription, and — the real
 * hazard — the optimistic insert in `enqueueTask`/`retryTask` would land in the
 * caller's copy alone, so until the push arrived one surface would show a task
 * another did not. That is the same divergence `useAgentProfiles` was converted
 * to fix, so this matches it exactly.
 */

/** Result of assigning a task: the stored record, or why main refused it. */
export type EnqueueTaskOutcome = { ok: true; task: DelegatedTask } | { ok: false; error: string }

type TasksState = {
  tasks: DelegatedTask[]
  ready: boolean
  error: string | null
}

const EMPTY: TasksState = { tasks: [], ready: false, error: null }

let state: TasksState = EMPTY
const listeners = new Set<() => void>()
let started = false

/**
 * useSyncExternalStore compares snapshots by identity, so this must return a
 * stable reference and must not build a fresh object per call.
 */
function getSnapshot(): TasksState {
  return state
}

function setState(patch: Partial<TasksState>): void {
  const next: TasksState = { ...state, ...patch }
  if (next.tasks === state.tasks && next.ready === state.ready && next.error === state.error) {
    return
  }
  state = next
  for (const listener of listeners) listener()
}

/**
 * Newest first — the order main's `listTasks` returns. Re-sorting after an
 * optimistic insert makes the local array match the push that follows, so no
 * row visibly jumps when the two arrive in either order.
 */
function byNewest(tasks: DelegatedTask[]): DelegatedTask[] {
  return [...tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

function start(): void {
  if (started) return
  // Do not latch before the preload bridge exists. Marking the load as started
  // when there is nothing to call would leave the queue empty for the rest of
  // the session; leaving it unlatched lets the next subscribe retry.
  if (!window.vyotiq?.tasksList) return
  started = true
  void window.vyotiq?.tasksList?.().then((res) => {
    // `ready` flips even on failure: a queue that failed to load should say so,
    // not spin forever behind a loading state that will never resolve.
    if (res?.ok) setState({ tasks: res.data, ready: true })
    else if (res && !res.ok) setState({ error: res.error, ready: true })
    else setState({ ready: true })
  })
  // Never torn down on purpose: one listener for the app's lifetime. Dropping
  // it when the last subscriber unmounts would leave whatever mounts next
  // reading a queue that silently stopped receiving updates.
  window.vyotiq?.onTasksChanged?.((event) => {
    setState({ tasks: event.tasks, ready: true })
  })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  start()
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Apply a record main just returned. `state` is read after the await, never
 * captured before it, so a push that landed while the call was in flight is
 * not overwritten with a stale array. Filtering by id makes this idempotent
 * when that push already carried the same record.
 */
function applyTask(task: DelegatedTask): void {
  setState({ tasks: byNewest([task, ...state.tasks.filter((t) => t.id !== task.id)]) })
}

async function enqueueTask(request: TaskEnqueueRequest): Promise<EnqueueTaskOutcome> {
  const res = await window.vyotiq?.tasksEnqueue?.(request)
  if (res?.ok) {
    applyTask(res.data)
    return { ok: true, task: res.data }
  }
  // Main's reason ("Workspace is not open", a validation message) is returned
  // rather than stored: the caller has a channel for it and reports it itself,
  // so storing it too would show the same failure twice.
  return { ok: false, error: res?.error ?? 'Task service unavailable' }
}

async function retryTask(id: string): Promise<EnqueueTaskOutcome> {
  const res = await window.vyotiq?.tasksRetry?.({ id })
  if (res?.ok) {
    applyTask(res.data)
    return { ok: true, task: res.data }
  }
  return { ok: false, error: res?.error ?? 'Task service unavailable' }
}

async function cancelTask(id: string): Promise<boolean> {
  const res = await window.vyotiq?.tasksCancel?.({ id })
  // `ok` only says the call reached main. Main answers `false` when the task
  // was already terminal or its run had gone — reporting that as success let
  // the UI claim it had stopped work that was never stopped.
  const stopped = res?.ok === true && res.data === true
  if (!stopped) {
    // The one failure with no other route to the user: cancel returns a bare
    // boolean the callers discard, and a refused stop emits no push, so
    // without this the click does nothing and says nothing.
    setState({
      error:
        res && !res.ok
          ? res.error
          : 'That task had already finished — there was nothing to stop.'
    })
  }
  return stopped
}

/** Dismiss a surfaced error once the user has read it. */
function clearError(): void {
  setState({ error: null })
}

/** Test hook — drop the shared queue so suites cannot leak state into each other. */
export function resetDelegatedTasksStoreForTests(): void {
  state = EMPTY
  listeners.clear()
  started = false
}

/**
 * Delegated-task state: one shared load plus a live push subscription. The
 * mutators are module-level, so their identities are stable and a consumer can
 * depend on them without re-subscribing.
 */
export function useDelegatedTasks(): {
  tasks: DelegatedTask[]
  ready: boolean
  error: string | null
  enqueueTask: (request: TaskEnqueueRequest) => Promise<EnqueueTaskOutcome>
  cancelTask: (id: string) => Promise<boolean>
  retryTask: (id: string) => Promise<EnqueueTaskOutcome>
  clearError: () => void
} {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return {
    tasks: snapshot.tasks,
    ready: snapshot.ready,
    error: snapshot.error,
    enqueueTask,
    cancelTask,
    retryTask,
    clearError
  }
}
