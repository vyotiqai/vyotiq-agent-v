import type { IpcResult, UpdateRunExtraRootsResult } from '@shared/ipc'
import { extraRootLabel } from '@shared/extraRoots'
import { pushToast } from '@renderer/lib/ui'
import { signalRunListChanged } from '@renderer/lib/chat/runListSignal'

/**
 * Added folders on a task that has already started: `/add-dir` in its
 * composer, and Add folder… / Remove in its header menu. Main checks the
 * folder and saves the list on the run (runExtraRootsEdit.ts). A running
 * invoke keeps the folders it began with, so the toast says when the change
 * takes hold: the next time the task starts for a live one, the next
 * follow-up for a finished one.
 */

export type TaskFolderNotice = { message: string; detail: string }

/** What the toast says after a folder was added to or removed from a started task. */
export function taskFolderNotice(change: 'added' | 'removed', root: string, live: boolean): TaskFolderNotice {
  const label = extraRootLabel(root)
  if (change === 'added') {
    return {
      message: `Added ${label}`,
      detail: live
        ? 'The task works there from when it next starts — this run keeps the folders it began with.'
        : 'Your next follow-up can work there.'
    }
  }
  return {
    message: `Removed ${label}`,
    detail: live
      ? 'This run can still reach it until it ends; the task won’t work there after that.'
      : 'Your next follow-up won’t work there.'
  }
}

function settle(workspacePath: string, verb: 'add' | 'remove', res: IpcResult<UpdateRunExtraRootsResult>): boolean {
  if (!res.ok) {
    pushToast(res.error, 'error')
    return false
  }
  const data = res.data
  if (data.cancelled) return true
  if (data.refused) {
    pushToast(`Can’t ${verb} ${data.refused}`, 'error')
    return false
  }
  const root = data.added ?? data.removed
  if (!root) return false
  const notice = taskFolderNotice(data.added ? 'added' : 'removed', root, data.live)
  pushToast(notice.message, { kind: 'info', detail: notice.detail, icon: data.added ? 'folderPlus' : 'folderMinus' })
  signalRunListChanged(workspacePath)
  return true
}

/** Add a folder to a started task: the OS picker, or `path` as typed (`/add-dir <path>`). */
export async function addTaskFolder(workspacePath: string, runId: string, path?: string): Promise<boolean> {
  const set = window.vyotiq?.setRunExtraRoots
  if (!set) return false
  const res = await set({ action: 'add', workspacePath, runId, ...(path ? { path } : {}) })
  return settle(workspacePath, 'add', res)
}

/** Take one of a started task's added folders away. */
export async function removeTaskFolder(workspacePath: string, runId: string, root: string): Promise<boolean> {
  const set = window.vyotiq?.setRunExtraRoots
  if (!set) return false
  const res = await set({ action: 'remove', workspacePath, runId, root })
  return settle(workspacePath, 'remove', res)
}
