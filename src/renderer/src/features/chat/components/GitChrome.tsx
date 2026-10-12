import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  GitCommitResult,
  GitPullResult,
  GitPullStrategy,
  GitStashRestoreResult,
  GitStatus,
  GitStatusResult,
  PrCreateResult
} from '@shared/ipc'
import type { HunkIdentity } from '@shared/utils/hunkPatch'
import { useGitStatus } from './useGitStatus'
import { pushToast } from '@renderer/lib/ui'

export type GitChrome = {
  status: GitStatus | null
  result: GitStatusResult | null
  error: string | null
  ready: boolean
  /** True until the first gitStatus answer arrives. */
  loading: boolean
  busy: boolean
  notice: string | null
  noticeFailed: boolean
  refresh: () => void
  /**
   * What main answered, or false when nothing was committed. With `runId`
   * (committed from that task's Changes) the answer says what it settled.
   */
  commit: (message: string, push: boolean, mode?: 'all' | 'staged', runId?: string | null) => Promise<GitCommitResult | false>
  /** Fold the changes into the last commit `sha` (still HEAD, not pushed) under `message`. */
  amend: (message: string, sha: string, mode?: 'all' | 'staged', runId?: string | null) => Promise<GitCommitResult | false>
  /** Stage one hunk of the unstaged diff, or (`unstage`) take one out of the staged diff. */
  stageHunk: (target: { path: string; hunk: HunkIdentity; diffHash: string }, unstage: boolean) => Promise<boolean>
  /**
   * Switch to an existing local branch. `leaveChanges` stashes uncommitted
   * changes on the branch being left instead of carrying them over.
   */
  checkout: (branch: string, leaveChanges?: boolean) => Promise<boolean>
  /**
   * Commit and open (or update) a pull request; false when it did not. With
   * `runId` the commit settles that task's edits, and `title`/`body` replace
   * gh's `--fill`.
   */
  createPr: (
    message: string,
    mode?: 'all' | 'staged',
    draft?: boolean,
    task?: { runId?: string | null; title?: string; body?: string }
  ) => Promise<PrCreateResult | false>
  stageAll: () => Promise<boolean>
  stagePaths: (paths: string[]) => Promise<boolean>
  unstagePaths: (paths: string[]) => Promise<boolean>
  /**
   * Throw away the person's own changes: `worktree` drops what is not staged,
   * `all` goes back to HEAD. Old copies go to the OS trash. Ask first.
   */
  discardPaths: (paths: string[], scope: 'worktree' | 'all') => Promise<boolean>
  reportNotice: (message: string, failed?: boolean) => void
  /** The sync action in flight, or null. Separate from `busy`: a fetch never blocks a commit. */
  syncing: GitSyncAction | null
  fetch: () => Promise<boolean>
  /**
   * Fast-forward by default. A `diverged` answer changed nothing; pass
   * `rebase` or `merge` to go on. False when the pull failed.
   */
  pull: (strategy?: GitPullStrategy) => Promise<GitPullResult | false>
  /** Push, publishing the branch when it has no upstream. Never forced. */
  push: () => Promise<boolean>
  createBranch: (name: string) => Promise<boolean>
  /** Put back the changes a switch left on this branch (`sha` is that stash), open files saved first. */
  restoreStash: (sha: string) => Promise<GitStashRestoreResult | false>
  /** Drop that stash: after a restore with conflicts, or to throw its changes away. */
  dropStash: (sha: string) => Promise<boolean>
}

export type GitSyncAction = 'fetch' | 'pull' | 'push' | 'branch'

const SYNC_WORDS: Record<GitSyncAction, string> = { fetch: 'fetch', pull: 'pull', push: 'push', branch: 'branch change' }

/** How often the app asks main for a background fetch while the window has focus; main spaces them out further. */
export const BACKGROUND_FETCH_EVERY_MS = 5 * 60_000
/**
 * The first ask once the counts are on screen (the chrome runs while Changes
 * is shown): at once, near enough. Main skips it after a fetch moments ago.
 */
const BACKGROUND_FETCH_FIRST_MS = 2_000

/**
 * The workspace's git state plus commit/stage actions for the Changes panel.
 */
export function useGitChrome(
  workspacePath: string | null,
  revision: number,
  enabled = true,
  deferStartupMs?: number,
  beforeMutation?: () => Promise<boolean>
): GitChrome {
  const { status, result, error, loading, refresh } = useGitStatus(
    workspacePath,
    revision,
    enabled,
    deferStartupMs
  )
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [noticeFailed, setNoticeFailed] = useState(false)

  const flushFilesBeforeMutation = useCallback(async (): Promise<boolean> => {
    if (!beforeMutation) return true
    let ok = false
    try {
      ok = await beforeMutation()
    } catch {
      ok = false
    }
    if (!ok) {
      setNotice('File autosave could not complete. Resolve file conflicts or errors first.')
      setNoticeFailed(true)
    }
    return ok
  }, [beforeMutation])

  const commit = useCallback(
    async (
      message: string,
      push: boolean,
      mode: 'all' | 'staged' = 'all',
      runId?: string | null
    ): Promise<GitCommitResult | false> => {
      if (!workspacePath || !message.trim() || busy) return false
      setBusy(true)
      setNotice(null)
      setNoticeFailed(false)
      if (!(await flushFilesBeforeMutation())) {
        setBusy(false)
        return false
      }
      try {
        const commitResult = runId
          ? await window.vyotiq.gitCommit(workspacePath, message.trim(), push, mode, runId)
          : await window.vyotiq.gitCommit(workspacePath, message.trim(), push, mode)
        setNotice(commitResult.ok ? commitResult.data.detail : commitResult.error)
        setNoticeFailed(!commitResult.ok)
        return commitResult.ok ? commitResult.data : false
      } finally {
        setBusy(false)
        refresh()
      }
    },
    [busy, flushFilesBeforeMutation, refresh, workspacePath]
  )

  const amend = useCallback(
    async (
      message: string,
      sha: string,
      mode: 'all' | 'staged' = 'all',
      runId?: string | null
    ): Promise<GitCommitResult | false> => {
      if (!workspacePath || !message.trim() || busy) return false
      setBusy(true)
      setNotice(null)
      setNoticeFailed(false)
      if (!(await flushFilesBeforeMutation())) {
        setBusy(false)
        return false
      }
      try {
        const res = await window.vyotiq.gitAmend({
          workspacePath,
          message: message.trim(),
          sha,
          mode,
          ...(runId ? { runId } : {})
        })
        setNotice(res.ok ? res.data.detail : res.error)
        setNoticeFailed(!res.ok)
        return res.ok ? res.data : false
      } finally {
        setBusy(false)
        refresh()
      }
    },
    [busy, flushFilesBeforeMutation, refresh, workspacePath]
  )

  const stageHunk = useCallback(
    async (target: { path: string; hunk: HunkIdentity; diffHash: string }, unstage: boolean): Promise<boolean> => {
      if (!workspacePath || busy) return false
      setBusy(true)
      setNotice(null)
      setNoticeFailed(false)
      // The diff on screen is the file on disk; an editor's unsaved text would make it stale.
      if (!(await flushFilesBeforeMutation())) {
        setBusy(false)
        return false
      }
      try {
        const res = await window.vyotiq.gitStageHunk({
          workspacePath,
          path: target.path,
          hunk: target.hunk,
          diffHash: target.diffHash,
          ...(unstage ? { unstage: true } : {})
        })
        setNotice(res.ok ? res.data.detail : res.error)
        setNoticeFailed(!res.ok)
        return res.ok
      } finally {
        setBusy(false)
        refresh()
      }
    },
    [busy, flushFilesBeforeMutation, refresh, workspacePath]
  )

  const ensureGithubCli = useCallback(async (): Promise<boolean> => {
    if (!window.vyotiq?.githubAuthStatus || !window.vyotiq.githubCliInstall) return true
    const auth = await window.vyotiq.githubAuthStatus()
    if (!auth.ok || auth.data.ghAvailable) return true

    setNotice('Installing GitHub CLI…')
    setNoticeFailed(false)
    const install = await window.vyotiq.githubCliInstall()
    if (install.ok && install.data.ghAvailable) {
      setNotice(install.data.detail || 'GitHub CLI is ready.')
      return true
    }
    setNotice(install.ok ? 'GitHub CLI installation did not complete.' : install.error)
    setNoticeFailed(true)
    return false
  }, [])

  const createPr = useCallback(
    async (
      message: string,
      mode: 'all' | 'staged' = 'all',
      draft = true,
      task?: { runId?: string | null; title?: string; body?: string }
    ): Promise<PrCreateResult | false> => {
      if (!workspacePath || !message.trim() || busy) return false
      setBusy(true)
      setNotice(null)
      setNoticeFailed(false)
      if (!(await flushFilesBeforeMutation())) {
        setBusy(false)
        return false
      }
      try {
        if (!(await ensureGithubCli())) return false
        const result = await window.vyotiq.prCreate(workspacePath, {
          message: message.trim(),
          mode,
          draft,
          ...(task?.runId ? { runId: task.runId } : {}),
          ...(task?.title?.trim() ? { title: task.title.trim(), body: task.body ?? '' } : {})
        })
        setNotice(result.ok ? `${result.data.detail}: ${result.data.url}` : result.error)
        setNoticeFailed(!result.ok)
        return result.ok ? result.data : false
      } finally {
        setBusy(false)
        refresh()
      }
    },
    [busy, ensureGithubCli, flushFilesBeforeMutation, refresh, workspacePath]
  )

  const stageAll = useCallback(async (): Promise<boolean> => {
    if (!workspacePath || busy) return false
    setBusy(true)
    setNotice(null)
    setNoticeFailed(false)
    if (!(await flushFilesBeforeMutation())) {
      setBusy(false)
      return false
    }
    try {
      const stageResult = await window.vyotiq.gitStageAll(workspacePath)
      setNotice(stageResult.ok ? stageResult.data.detail : stageResult.error)
      setNoticeFailed(!stageResult.ok)
      return stageResult.ok
    } finally {
      setBusy(false)
      refresh()
    }
  }, [busy, flushFilesBeforeMutation, refresh, workspacePath])

  const stagePaths = useCallback(
    async (paths: string[]): Promise<boolean> => {
      if (!workspacePath || busy || paths.length === 0) return false
      setBusy(true)
      setNotice(null)
      setNoticeFailed(false)
      if (!(await flushFilesBeforeMutation())) {
        setBusy(false)
        return false
      }
      try {
        const stageResult = await window.vyotiq.gitStagePaths({ workspacePath, paths })
        setNotice(stageResult.ok ? stageResult.data.detail : stageResult.error)
        setNoticeFailed(!stageResult.ok)
        return stageResult.ok
      } finally {
        setBusy(false)
        refresh()
      }
    },
    [busy, flushFilesBeforeMutation, refresh, workspacePath]
  )

  const unstagePaths = useCallback(
    async (paths: string[]): Promise<boolean> => {
      if (!workspacePath || busy || paths.length === 0) return false
      setBusy(true)
      setNotice(null)
      setNoticeFailed(false)
      if (!(await flushFilesBeforeMutation())) {
        setBusy(false)
        return false
      }
      try {
        const result = await window.vyotiq.gitUnstagePaths({ workspacePath, paths })
        setNotice(result.ok ? result.data.detail : result.error)
        setNoticeFailed(!result.ok)
        return result.ok
      } finally {
        setBusy(false)
        refresh()
      }
    },
    [busy, flushFilesBeforeMutation, refresh, workspacePath]
  )

  const discardPaths = useCallback(
    async (paths: string[], scope: 'worktree' | 'all'): Promise<boolean> => {
      if (!workspacePath || busy || paths.length === 0) return false
      setBusy(true)
      setNotice(null)
      setNoticeFailed(false)
      // An open editor's unsaved text is saved first, so its copy is the one kept in the trash.
      if (!(await flushFilesBeforeMutation())) {
        setBusy(false)
        return false
      }
      try {
        const result = await window.vyotiq.gitDiscardPaths({ workspacePath, paths, scope })
        setNotice(result.ok ? result.data.detail : result.error)
        setNoticeFailed(!result.ok)
        const undoId = result.ok ? result.data.undoId : undefined
        if (undoId) {
          const where = workspacePath
          pushToast(result.ok ? result.data.detail : '', {
            kind: 'info',
            durationMs: 12_000,
            action: {
              label: 'Undo',
              onClick: () => {
                void window.vyotiq.gitDiscardUndo({ workspacePath: where, id: undoId }).then((res) => {
                  setNotice(res.ok ? res.data.detail : res.error)
                  setNoticeFailed(!res.ok)
                  refresh()
                })
              }
            }
          })
        }
        return result.ok
      } finally {
        setBusy(false)
        refresh()
      }
    },
    [busy, flushFilesBeforeMutation, refresh, workspacePath]
  )

  const reportNotice = useCallback((message: string, failed = false) => {
    setNotice(message)
    setNoticeFailed(failed)
  }, [])

  const [syncing, setSyncing] = useState<GitSyncAction | null>(null)
  /**
   * One sync at a time, never during a commit. `touchesTree` (pull, a new
   * branch) saves open editors first, as a commit does: git rewrites files.
   */
  const runSync = useCallback(
    async <T,>(
      action: GitSyncAction,
      touchesTree: boolean,
      call: (path: string) => Promise<{ ok: true; data: T } | { ok: false; error: string }>,
      describe: (data: T) => { text: string; failed?: boolean }
    ): Promise<T | false> => {
      if (!workspacePath) return false
      if (busy || syncing) {
        // Said, not dropped: a branch picked during a slow fetch used to snap back with no word.
        setNotice(`Wait for the ${syncing ? SYNC_WORDS[syncing] : 'git action in progress'} to finish, then try again`)
        setNoticeFailed(true)
        return false
      }
      setSyncing(action)
      setNotice(null)
      setNoticeFailed(false)
      try {
        if (touchesTree && !(await flushFilesBeforeMutation())) return false
        const res = await call(workspacePath)
        if (!res.ok) {
          setNotice(res.error)
          setNoticeFailed(true)
          return false
        }
        const said = describe(res.data)
        setNotice(said.text)
        setNoticeFailed(said.failed === true)
        return res.data
      } catch (err) {
        setNotice(err instanceof Error ? err.message : String(err))
        setNoticeFailed(true)
        return false
      } finally {
        setSyncing(null)
        refresh()
      }
    },
    [busy, flushFilesBeforeMutation, refresh, syncing, workspacePath]
  )

  const fetch = useCallback(
    async (): Promise<boolean> =>
      (await runSync('fetch', false, (path) => window.vyotiq.gitFetch({ workspacePath: path }), (d) => ({ text: d.detail }))) !==
      false,
    [runSync]
  )

  const pull = useCallback(
    (strategy?: GitPullStrategy): Promise<GitPullResult | false> =>
      runSync(
        'pull',
        true,
        (path) => window.vyotiq.gitPull(strategy ? { workspacePath: path, strategy } : { workspacePath: path }),
        // A merge left conflicts: the pull did not finish, and says so as a failure.
        (d) => ({ text: d.detail, failed: d.kind === 'conflicted' })
      ),
    [runSync]
  )

  const push = useCallback(
    async (): Promise<boolean> =>
      (await runSync('push', false, (path) => window.vyotiq.gitPush({ workspacePath: path }), (d) => ({ text: d.detail }))) !==
      false,
    [runSync]
  )

  const checkout = useCallback(
    async (branch: string, leaveChanges = false): Promise<boolean> =>
      (await runSync(
        'branch',
        true,
        (path) => window.vyotiq.gitCheckout(path, branch, leaveChanges ? { leaveChanges: true } : undefined),
        (d) => ({ text: d.detail })
      )) !== false,
    [runSync]
  )

  // The app's own fetch, so "N to pull" is true without a click. Asked only
  // while the window has focus; main keeps it to one every few minutes per
  // repository, holds off after a failure, and stays quiet either way.
  useEffect(() => {
    if (!workspacePath || !enabled) return undefined
    const ask = (): void => {
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return
      void window.vyotiq
        ?.gitFetch?.({ workspacePath, background: true })
        // A fetch that ran moved the remote-tracking refs: read ahead/behind
        // again. So did one from another worktree of the repository, just now.
        .then((res) => {
          if (res.ok && (!res.data.skipped || res.data.refsMoved)) refresh()
        })
        .catch(() => undefined)
    }
    const first = window.setTimeout(ask, BACKGROUND_FETCH_FIRST_MS)
    const every = window.setInterval(ask, BACKGROUND_FETCH_EVERY_MS)
    // Coming back to the window asks too, so a fetch skipped while it was in
    // the background is not five minutes late; main's spacing still holds.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') ask()
    }
    window.addEventListener('focus', ask)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(every)
      window.removeEventListener('focus', ask)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [workspacePath, enabled, refresh])

  const restoreStash = useCallback(
    (sha: string): Promise<GitStashRestoreResult | false> =>
      runSync(
        'branch',
        true,
        (path) => window.vyotiq.gitStashRestore({ workspacePath: path, sha }),
        (d) => ({ text: d.detail, failed: d.conflicted })
      ),
    [runSync]
  )

  const dropStash = useCallback(
    async (sha: string): Promise<boolean> =>
      (await runSync('branch', false, (path) => window.vyotiq.gitStashDrop({ workspacePath: path, sha }), (d) => ({ text: d.detail }))) !==
      false,
    [runSync]
  )

  const createBranch = useCallback(
    async (name: string): Promise<boolean> =>
      (await runSync(
        'branch',
        true,
        (path) => window.vyotiq.gitCreateBranch({ workspacePath: path, name: name.trim() }),
        (d) => ({ text: d.detail })
      )) !== false,
    [runSync]
  )

  return useMemo(
    () => ({
      status,
      result,
      error,
      ready: !loading && result != null,
      loading,
      busy,
      notice,
      noticeFailed,
      refresh,
      commit,
      amend,
      stageHunk,
      checkout,
      createPr,
      stageAll,
      stagePaths,
      unstagePaths,
      discardPaths,
      reportNotice,
      syncing,
      fetch,
      pull,
      push,
      createBranch,
      restoreStash,
      dropStash
    }),
    [
      status,
      result,
      error,
      loading,
      busy,
      notice,
      noticeFailed,
      refresh,
      commit,
      amend,
      stageHunk,
      checkout,
      createPr,
      stageAll,
      stagePaths,
      unstagePaths,
      discardPaths,
      reportNotice,
      syncing,
      fetch,
      pull,
      push,
      createBranch,
      restoreStash,
      dropStash
    ]
  )
}
