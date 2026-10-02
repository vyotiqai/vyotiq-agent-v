import { useEffect } from 'react'
import { pushToast } from '@renderer/lib/ui'

type AddWorkspace = (path: string, opts: { onError: (message: string) => void }) => Promise<unknown>

/**
 * A scheduled run set to a new worktree: main has made the worktree (the same
 * createTaskWorktree Start task in a new worktree calls) and asks the window
 * to open it as a workspace — the step main can't take, since the window owns
 * which workspaces are open. Opened (or not), main is told, and it starts the
 * run there or records why it didn't.
 */
export function useScheduledWorktreeOpener(addWorkspace: AddWorkspace): void {
  useEffect(() => {
    return window.vyotiq?.onScheduleWorktreeOpen?.((request) => {
      void (async () => {
        let openError: string | null = null
        const added = await addWorkspace(request.workspacePath, {
          onError: (message) => {
            openError = message
          }
        })
        const reply = added
          ? { token: request.token }
          : { token: request.token, error: (openError ?? 'unknown error').slice(0, 400) }
        const res = await window.vyotiq.scheduleWorktreeOpened(reply)
        if (!res.ok) pushToast(`Scheduled task didn’t start: ${res.error}`, 'error')
      })()
    })
  }, [addWorkspace])
}
