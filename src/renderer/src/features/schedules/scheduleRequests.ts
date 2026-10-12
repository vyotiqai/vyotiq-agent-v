/**
 * Open requests for the two schedule dialogs. They come from the palette, the
 * navigator's View menu and a task row's menu; the dialogs that answer them
 * are mounted once, in the app shell.
 */

/**
 * What to repeat: a task (its first brief and checks are read from its record),
 * or — from New task — a brief not started yet, with its checks.
 */
export type RepeatTaskRequest =
  | { workspacePath: string; runId: string; title: string }
  | { workspacePath: string; runId?: undefined; title: string; instruction: string; doneWhen?: string[]; worktree?: boolean }

const listRequests = new Set<() => void>()
const repeatRequests = new Set<(task: RepeatTaskRequest) => void>()

/** Register the mounted Scheduled tasks list; returns the unregister. */
export function onScheduledTasksRequest(open: () => void): () => void {
  listRequests.add(open)
  return () => {
    listRequests.delete(open)
  }
}

/** Show the Scheduled tasks list. False when nothing is mounted to show it. */
export function requestScheduledTasks(): boolean {
  if (listRequests.size === 0) return false
  for (const open of listRequests) open()
  return true
}

/** Register the mounted Repeat task dialog; returns the unregister. */
export function onRepeatTaskRequest(open: (task: RepeatTaskRequest) => void): () => void {
  repeatRequests.add(open)
  return () => {
    repeatRequests.delete(open)
  }
}

/** Ask when to repeat a task. False when nothing is mounted to ask. */
export function requestRepeatTask(task: RepeatTaskRequest): boolean {
  if (repeatRequests.size === 0) return false
  for (const open of repeatRequests) open(task)
  return true
}
