import { useCallback, useEffect, useState } from 'react'
import type { DeletedRunSummary } from '@shared/ipc'
import { relativeTimeAgo } from '@shared/utils/timeFormat'
import { UNTITLED_TASK, taskTitleFromGoal } from '@shared/utils/taskTitle'
import { Dialog } from '@renderer/lib/a11y/Dialog'
import { Button, cn, pushToast } from '@renderer/lib/ui'
import { BORDER_DIVIDER } from '@renderer/lib/utils/layout'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'

const DAY_MS = 24 * 60 * 60 * 1000
const KEEP_DAYS = 30

let openRequest: ((workspacePath: string) => void) | null = null

/** Open Recently deleted for a workspace. False when nothing is mounted to show it. */
export function requestRecentlyDeleted(workspacePath: string): boolean {
  if (!openRequest) return false
  openRequest(workspacePath)
  return true
}

function daysLeft(deletedAt: string, now: number): number {
  const at = Date.parse(deletedAt)
  if (!Number.isFinite(at)) return 0
  return Math.max(0, Math.ceil((at + KEEP_DAYS * DAY_MS - now) / DAY_MS))
}

/**
 * Tasks deleted from a workspace in the last 30 days: Restore puts one back
 * where it was, Delete now removes it for good. Opened from the navigator's
 * View menu and the command palette.
 */
export function RecentlyDeletedDialog({ onRestored }: { onRestored?: (workspacePath: string, runId: string) => void }) {
  const [workspacePath, setWorkspacePath] = useState<string | null>(null)
  const [runs, setRuns] = useState<DeletedRunSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  /** When the list was read: what "N days left" counts from. */
  const [now, setNow] = useState(0)

  const load = useCallback(async (path: string): Promise<void> => {
    const res = await window.vyotiq.listDeletedRuns(path)
    if (res.ok) {
      setRuns(res.data)
      setNow(Date.now())
      setError(null)
    } else setError(res.error)
  }, [])

  useEffect(() => {
    openRequest = (path) => {
      setWorkspacePath(path)
      setRuns(null)
      void load(path)
    }
    return () => {
      openRequest = null
    }
  }, [load])

  const restore = async (run: DeletedRunSummary): Promise<void> => {
    if (!workspacePath) return
    setBusy(run.runId)
    const res = await window.vyotiq.restoreDeletedRun(workspacePath, run.runId)
    setBusy(null)
    if (!res.ok) {
      setError(res.error)
      return
    }
    setRuns((prev) => prev?.filter((r) => r.runId !== run.runId) ?? prev)
    pushToast(`Restored ${(run.goal && taskTitleFromGoal(run.goal)) || UNTITLED_TASK}`, { kind: 'success', icon: 'undo' })
    onRestored?.(workspacePath, run.runId)
  }

  const purge = async (run?: DeletedRunSummary): Promise<void> => {
    if (!workspacePath) return
    setBusy(run?.runId ?? '*')
    const res = await window.vyotiq.purgeDeletedRuns(workspacePath, run?.runId)
    setBusy(null)
    if (!res.ok) {
      setError(res.error)
      return
    }
    setRuns((prev) => (run ? (prev?.filter((r) => r.runId !== run.runId) ?? prev) : []))
  }

  return (
    <Dialog
      open={workspacePath != null}
      onClose={() => setWorkspacePath(null)}
      title="Recently deleted"
      icon="trash"
      className="vy-menu flex w-[min(36rem,calc(100vw_-_2rem))] flex-col overflow-hidden"
      footer={
        runs && runs.length > 0 ? (
          <Button size="sm" variant="ghost" disabled={busy != null} onClick={() => void purge()}>
            Empty Recently deleted
          </Button>
        ) : undefined
      }
    >
      <div className="scroll-thin max-h-[60vh] overflow-y-auto px-4 py-2" data-recently-deleted>
        <p className="m-0 mb-2 text-xs text-muted">
          Deleted tasks in {workspacePath ? formatWorkspaceName(workspacePath) : 'this workspace'} stay here {KEEP_DAYS} days,
          then go for good. Their worktree branches are not kept.
        </p>
        {error ? (
          <p role="alert" className="m-0 mb-2 text-xs text-danger">
            {error}
          </p>
        ) : null}
        {runs == null ? (
          <p className="m-0 py-4 text-xs text-tertiary">Reading…</p>
        ) : runs.length === 0 ? (
          <p className="m-0 py-4 text-xs text-tertiary">Nothing was deleted in the last {KEEP_DAYS} days.</p>
        ) : (
          <ul className="m-0 list-none p-0">
            {runs.map((run) => (
              <li
                key={run.runId}
                className={cn('flex items-center gap-2 border-b py-2', BORDER_DIVIDER)}
                data-deleted-run={run.runId}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-fg">
                    {(run.goal && taskTitleFromGoal(run.goal)) || UNTITLED_TASK}
                  </span>
                  <span className="block text-caption text-tertiary">
                    Deleted {relativeTimeAgo(run.deletedAt)} · {daysLeft(run.deletedAt, now)} days left
                    {run.instances.length > 0 ? ` · ${run.instances.length} helper${run.instances.length === 1 ? '' : 's'}` : ''}
                  </span>
                </span>
                <Button size="xs" disabled={busy != null} onClick={() => void restore(run)}>
                  Restore
                </Button>
                <Button size="xs" variant="ghost" disabled={busy != null} onClick={() => void purge(run)}>
                  Delete now
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  )
}
