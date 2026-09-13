import type { UiItem } from '@shared/transcript'

/**
 * User prompt that owns this run's task list: the user message preceding the
 * first non-failed `todo_write` in the transcript.
 *
 * Uses raw `items` (before successful todo_write rows are coalesced away).
 * Tasks UI mounts under this prompt in normal transcript order (no pin).
 */
export function resolveTasksAnchorUserId(items: readonly UiItem[]): string | null {
  let todoIdx = -1
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!
    if (item.kind !== 'tool') continue
    if (item.tool.name !== 'todo_write') continue
    if (item.tool.status === 'fail') continue
    todoIdx = i
    break
  }
  if (todoIdx < 0) return null

  for (let i = todoIdx - 1; i >= 0; i -= 1) {
    const item = items[i]!
    if (item.kind === 'message' && item.role === 'user') return item.id
  }
  return null
}

/** Show the rail-side task lane only when the inline band is gone and Plan is not already showing tasks. */
export function shouldShowFloatingTasks(opts: {
  tasksAnchorUserId: string | null
  anchorVisible: boolean
  planPanelVisible: boolean
}): boolean {
  return opts.tasksAnchorUserId != null && !opts.anchorVisible && !opts.planPanelVisible
}

/** Most recent user message in the transcript. */
export function resolveLatestUserPromptId(items: readonly UiItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!
    if (item.kind === 'message' && item.role === 'user') return item.id
  }
  return null
}
