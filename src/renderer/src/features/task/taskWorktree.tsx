import { useCallback, useEffect, useState } from 'react'
import type { TaskWorktreeInfo } from '@shared/ipc'
import { workspacePathsEqual } from '@shared/workspacePathMatch'
import { Icon } from '@renderer/lib/icons'
import { Button, pushToast } from '@renderer/lib/ui'
import { useConfirm } from '@renderer/lib/hooks/useConfirm'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'

/**
 * Ask App to close a task worktree's workspace and delete the worktree — the
 * workspace has to close first, so nothing of the app still holds its files.
 */
export const DISCARD_TASK_WORKTREE_EVENT = 'vyotiq:discard-task-worktree'
export type DiscardTaskWorktreeDetail = { workspacePath: string; parentPath: string; branch: string; merged: boolean }

/**
 * The task worktree this workspace is, read again when `revision` changes, when
 * git says the worktree or its parent changed, and when the window regains
 * focus (a commit made outside the app changes what Merge has to bring).
 */
export function useTaskWorktree(
  workspacePath: string | null,
  revision: number
): { info: TaskWorktreeInfo | null; refresh: () => void } {
  const [info, setInfo] = useState<TaskWorktreeInfo | null>(null)

  const refresh = useCallback(() => {
    const ask = window.vyotiq?.taskWorktreeInfo
    if (!workspacePath || !ask) {
      setInfo(null)
      return
    }
    void ask(workspacePath).then((res) => setInfo(res.ok ? res.data : null))
  }, [workspacePath])

  useEffect(() => {
    refresh()
  }, [refresh, revision])

  useEffect(() => {
    const onFocus = (): void => refresh()
    window.addEventListener('focus', onFocus)
    const off = window.vyotiq?.onGitStatusChanged?.((payload) => {
      if (workspacePath && workspacePathsEqual(payload.workspacePath, workspacePath)) refresh()
    })
    return () => {
      window.removeEventListener('focus', onFocus)
      off?.()
    }
  }, [refresh, workspacePath])

  return { info, refresh }
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** What the worktree holds that its base doesn't: "2 commits · 3 uncommitted files". */
export function worktreeUnmerged(info: Pick<TaskWorktreeInfo, 'ahead' | 'uncommitted'>): string | null {
  const parts = [
    info.ahead > 0 ? count(info.ahead, 'commit', 'commits') : null,
    info.uncommitted > 0 ? count(info.uncommitted, 'uncommitted file', 'uncommitted files') : null
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : null
}

/** Merged, and nothing new since: all that is left to do is remove it. */
export function worktreeIsMerged(
  info: Pick<TaskWorktreeInfo, 'ahead' | 'uncommitted' | 'mergedAt'> & { baseMissing?: boolean }
): boolean {
  return Boolean(info.mergedAt) && !info.baseMissing && info.ahead === 0 && info.uncommitted === 0
}

/**
 * Under a finished task in a worktree: where it works, what it holds that its
 * base doesn't, and the two ways out — Merge back into the branch it came
 * from, or Discard it. Merged, it offers only to remove the worktree.
 */
export function TaskWorktreeStrip({ info, title, onChanged }: { info: TaskWorktreeInfo; title: string; onChanged: () => void }) {
  const { confirm, dialog } = useConfirm()
  const [merging, setMerging] = useState(false)
  const merged = worktreeIsMerged(info)
  const unmerged = worktreeUnmerged(info)
  const parentName = formatWorkspaceName(info.parentPath)

  const onMerge = async (): Promise<void> => {
    const commitNote =
      info.uncommitted > 0 ? `Commits the ${count(info.uncommitted, 'uncommitted file', 'uncommitted files')} as “${title}”, then merges` : 'Merges'
    const ok = await confirm(`${commitNote} ${info.branch} into ${info.baseBranch} in ${parentName}. The worktree stays until you remove it.`, {
      title: `Merge into ${info.baseBranch}?`,
      confirmLabel: 'Merge'
    })
    if (!ok) return
    setMerging(true)
    const res = await window.vyotiq.mergeTaskWorktree(info.workspacePath, title)
    setMerging(false)
    onChanged()
    if (!res.ok) {
      pushToast(res.error, 'error')
      return
    }
    if (!res.data.merged) {
      const files = res.data.conflicts
      const listed = files.slice(0, 5).join(', ') + (files.length > 5 ? ', …' : '')
      pushToast(`Merging would conflict in ${count(files.length, 'file', 'files')} — nothing was merged`, {
        kind: 'error',
        // The worktree's own commit did happen: say so, it is on the branch now.
        detail: res.data.committedFirst ? `${listed}. Its uncommitted files were committed on ${info.branch} first.` : listed
      })
      return
    }
    pushToast(`Merged ${count(res.data.commits, 'commit', 'commits')} into ${info.baseBranch}`, { kind: 'success', icon: 'merge' })
  }

  const onDiscard = async (): Promise<void> => {
    const loses = merged ? null : unmerged
    const ok = await confirm(
      loses
        ? info.baseMissing
          ? `Deletes the worktree’s folder and its branch ${info.branch}, with ${loses} that no other branch has. This workspace closes.`
          : `Deletes the worktree’s folder and its branch ${info.branch}, with ${loses} that ${info.baseBranch} doesn’t have. This workspace closes.`
        : `Deletes the worktree’s folder and its branch ${info.branch} — ${info.baseBranch} already has everything on it. This workspace closes.`,
      {
        title: merged ? 'Remove this worktree?' : 'Discard this worktree?',
        confirmLabel: merged ? 'Remove' : 'Discard',
        danger: Boolean(loses)
      }
    )
    if (!ok) return
    window.dispatchEvent(
      new CustomEvent<DiscardTaskWorktreeDetail>(DISCARD_TASK_WORKTREE_EVENT, {
        detail: { workspacePath: info.workspacePath, parentPath: info.parentPath, branch: info.branch, merged }
      })
    )
  }

  return (
    <div className="mt-3 flex items-center gap-2 text-xs text-muted" data-task-worktree>
      <Icon name={merged ? 'merge' : 'branch'} size={13} className="shrink-0 text-tertiary" />
      <span className="min-w-0 flex-1 truncate" title={info.branch}>
        {merged ? (
          <>Merged into {info.baseBranch}. The worktree has nothing {info.baseBranch} doesn’t.</>
        ) : info.baseMissing ? (
          <>
            Works in its own worktree; its base branch <span className="font-mono">{info.baseBranch}</span> is gone
            {unmerged ? ` · ${unmerged}` : ''}
          </>
        ) : (
          <>
            Works in its own worktree, from <span className="font-mono">{info.baseBranch}</span>
            {unmerged ? ` · ${unmerged}` : ' · nothing to merge yet'}
          </>
        )}
      </span>
      {merged ? null : (
        <Button
          size="xs"
          variant="ghost"
          icon="merge"
          disabled={!unmerged || !info.parentExists || info.baseMissing || merging}
          pending={merging}
          title={
            !info.parentExists
              ? 'The folder it came from is gone'
              : info.baseMissing
                ? `Its base branch ${info.baseBranch} is gone — there is nothing to merge into`
                : unmerged
                  ? undefined
                  : 'Nothing to merge yet'
          }
          onClick={() => void onMerge()}
        >
          Merge into {info.baseBranch}
        </Button>
      )}
      <Button size="xs" variant="ghost" icon="trash" disabled={merging} onClick={() => void onDiscard()}>
        {merged ? 'Remove worktree' : 'Discard'}
      </Button>
      {dialog}
    </div>
  )
}
