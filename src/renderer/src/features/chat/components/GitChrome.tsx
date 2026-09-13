import { useCallback, useMemo, useState } from 'react'
import type { GitStatus, GitStatusResult } from '@shared/ipc'
import { useGitStatus } from './useGitStatus'
import { defaultCommitMessageFromStatus } from './CommitComposer'

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
  commit: (message: string, push: boolean, mode?: 'all' | 'staged') => Promise<boolean>
  createPr: (message: string, mode?: 'all' | 'staged', draft?: boolean) => Promise<boolean>
  stageAll: () => Promise<boolean>
  stagePaths: (paths: string[]) => Promise<boolean>
  unstagePaths: (paths: string[]) => Promise<boolean>
  reportNotice: (message: string, failed?: boolean) => void
}

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
    async (message: string, push: boolean, mode: 'all' | 'staged' = 'all'): Promise<boolean> => {
      if (!workspacePath || !message.trim() || busy) return false
      setBusy(true)
      setNotice(null)
      setNoticeFailed(false)
      if (!(await flushFilesBeforeMutation())) {
        setBusy(false)
        return false
      }
      try {
        const commitResult = await window.vyotiq.gitCommit(
          workspacePath,
          message.trim(),
          push,
          mode
        )
        setNotice(commitResult.ok ? commitResult.data.detail : commitResult.error)
        setNoticeFailed(!commitResult.ok)
        return commitResult.ok
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
      draft = true
    ): Promise<boolean> => {
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
          draft
        })
        setNotice(result.ok ? `${result.data.detail}: ${result.data.url}` : result.error)
        setNoticeFailed(!result.ok)
        return result.ok
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
      reportNotice
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
      reportNotice
    ]
  )
}

export { defaultCommitMessageFromStatus }
