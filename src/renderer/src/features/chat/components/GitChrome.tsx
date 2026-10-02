import { useCallback, useMemo, useState } from 'react'
import type {
  GitCommitResult,
  GitPullResult,
  GitPullStrategy,
  GitStatus,
  GitStatusResult,
  PrCreateResult
} from '@shared/ipc'
import { useGitStatus } from './useGitStatus'

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
}

export type GitSyncAction = 'fetch' | 'pull' | 'push' | 'branch'

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
      if (!workspacePath || busy || syncing) return false
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
      createPr,
      stageAll,
      stagePaths,
      unstagePaths,
      reportNotice,
      syncing,
      fetch,
      pull,
      push,
      createBranch
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
      createPr,
      stageAll,
      stagePaths,
      unstagePaths,
      reportNotice,
      syncing,
      fetch,
      pull,
      push,
      createBranch
    ]
  )
}
