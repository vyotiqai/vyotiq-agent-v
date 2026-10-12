import { ipcMain, shell } from 'electron'
import { IPC } from '../../../shared/channels'
import { snapshotForUndo, undoDiscard } from '../../git/discardUndo'
import {
  GitDiscardUndoRequestSchema,
  GitStatusRequestSchema,
  GitInitRequestSchema,
  GitAllowRepoCommandsRequestSchema,
  GitGenerateCommitMessageRequestSchema,
  GitCommitRequestSchema,
  GitStageAllRequestSchema,
  GitStagePathsRequestSchema,
  GitUnstagePathsRequestSchema,
  GitDiscardPathsRequestSchema,
  GitBranchesRequestSchema,
  GitCheckoutRequestSchema,
  GitBranchStashRequestSchema,
  GitStashRestoreRequestSchema,
  GitStageHunkRequestSchema,
  GitLastCommitRequestSchema,
  GitAmendRequestSchema,
  GitFetchRequestSchema,
  GitPullRequestSchema,
  GitPushRequestSchema,
  GitCreateBranchRequestSchema,
  GitBranchDeleteRequestSchema,
  GitBranchRenameRequestSchema,
  GitStashApplyRequestSchema,
  GitIntegrateRequestSchema,
  type GitBranchDeleteResult,
  type GitStashEntry,
  type GitIntegrateResult,
  type GitStashRestoreResult,
  type GitFetchResult,
  type GitPullResult,
  type GitPushResult,
  type GitCreateBranchResult,
  GitDiffRequestSchema,
  GitBranchDiffRequestSchema,
  GitBranchDiffResultSchema,
  type GitBranchDiffResult,
  GitBlameRequestSchema,
  GitLogRequestSchema,
  GitCommitFilesRequestSchema,
  GitConflictFileRequestSchema,
  GitResolveConflictRequestSchema,
  ok,
  fail,
  type IpcResult,
  type GitConflictFileResult,
  type GitStatusResult,
  type GitCommitResult,
  type GitInitResult,
  type GitAllowRepoCommandsResult
} from '../../../shared/ipc'
import { formatError } from '../../../shared/errors'
import { settleTaskAfterCommit } from '../../agent/taskSettle'
import { discardUndoRoot } from '@main/storage/paths'
import { listActiveRuns } from '../../agent/runRegistry'
import { workspacePathsEqual } from '../../../shared/workspacePath'
import {
  checkoutBranch,
  commitAll,
  initGitRepo,
  allowWorkspaceRepoCommands,
  listLocalBranches,
  readGitCommitFiles,
  readGitBlame,
  readGitDiff,
  readBranchDiff,
  readGitLog,
  stageAll,
  stagePaths,
  unstagePaths,
  discardPaths,
  readConflictFile,
  resolveConflict,
  fetchRemotes,
  pullCurrentBranch,
  pushBranch,
  createGitBranch,
  deleteLocalBranch,
  renameLocalBranch,
  listAllStashes,
  applyAnyStash,
  dropAnyStash,
  integrateCommit,
  readBranchStash,
  restoreBranchStash,
  dropBranchStash,
  stageHunk,
  readLastCommit,
  amendLastCommit
} from '@main/git/git'
import { backgroundFetch, exclusiveFetch } from '@main/git/backgroundFetch'
import { invalidateGitStatusCache, readGitStatusCached } from '@main/git/gitStatusCache'
import { emitGitStatusChanged } from '@main/git/gitStatusEvents'
import { generateCommitMessage } from '@main/git/commitMessage'
import { failExpected, failFrom, isOpenWorkspace, senderOk } from '../ipcShared'

// ── Git sync (fetch / pull / push / new branch) — the person's click only ──
// A task live in this exact checkout is writing to its working tree, so a
// pull (or a branch started elsewhere) waits for it — as Commit does. A
// task in its own worktree has that worktree as its workspace and never
// matches here.
export const runLiveInCheckout = (workspacePath: string): boolean =>
  listActiveRuns().some((run) => workspacePathsEqual(run.workspacePath, workspacePath))

export const gitSyncSettled = (workspacePath: string): void => {
  invalidateGitStatusCache(workspacePath)
  emitGitStatusChanged(workspacePath)
}

// Branch, stash and commit operations. Each one that moves the tree waits
// for a task working in this checkout to stop, like Pull and Discard.
export const gitMutation = async <T>(
  channel: string,
  workspacePath: string,
  what: string,
  run: () => Promise<T>
): Promise<IpcResult<T>> => {
  if (!isOpenWorkspace(workspacePath)) return fail('Workspace is not open')
  if (runLiveInCheckout(workspacePath)) {
    return failExpected(`A task is working in this checkout. ${what} when it stops.`, channel)
  }
  try {
    return ok(await run())
  } catch (err) {
    return failExpected(formatError(err), channel)
  } finally {
    invalidateGitStatusCache(workspacePath)
    emitGitStatusChanged(workspacePath)
  }
}

/** Git in an open workspace: status, staging, commits, sync, branches, stashes and discards. Registered once by registerIpc. */
export function registerGitIpc(): void {
  ipcMain.handle(IPC.gitStatus, async (event, raw): Promise<IpcResult<GitStatusResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitStatusRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await readGitStatusCached(req.workspacePath, req.limit))
    } catch (err) {
      return failFrom(err, IPC.gitStatus)
    }
  })

  ipcMain.handle(IPC.gitGenerateCommitMessage, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitGenerateCommitMessageRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(
        await generateCommitMessage(req.workspacePath, req.mode, req.force === true, {
          ...(req.runId ? { runId: req.runId } : {})
        })
      )
    } catch (err) {
      return failFrom(err, IPC.gitGenerateCommitMessage)
    }
  })

  ipcMain.handle(IPC.gitInit, async (event, raw): Promise<IpcResult<GitInitResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitInitRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      const result = await initGitRepo(req.workspacePath)
      if (!result.ok) return fail(result.error)
      invalidateGitStatusCache(req.workspacePath)
      emitGitStatusChanged(req.workspacePath)
      return ok({ branch: result.branch })
    } catch (err) {
      return failFrom(err, IPC.gitInit)
    }
  })

  ipcMain.handle(
    IPC.gitAllowRepoCommands,
    async (event, raw): Promise<IpcResult<GitAllowRepoCommandsResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = GitAllowRepoCommandsRequestSchema.parse(raw)
        if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
        const result = await allowWorkspaceRepoCommands(req.workspacePath)
        invalidateGitStatusCache(req.workspacePath)
        emitGitStatusChanged(req.workspacePath)
        return ok(result)
      } catch (err) {
        return failFrom(err, IPC.gitAllowRepoCommands)
      }
    }
  )

  ipcMain.handle(IPC.gitCommit, async (event, raw): Promise<IpcResult<GitCommitResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitCommitRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      try {
        const result = await commitAll(
          req.workspacePath,
          req.message,
          req.push === true,
          req.mode ?? 'all'
        )
        // Committed from a task's Changes: the commit settles what it took of that task.
        const task = req.runId ? await settleTaskAfterCommit(req.workspacePath, req.runId, result) : undefined
        return ok(task ? { ...result, task } : result)
      } finally {
        invalidateGitStatusCache(req.workspacePath)
        emitGitStatusChanged(req.workspacePath)
      }
    } catch (err) {
      return failFrom(err, IPC.gitCommit)
    }
  })

  ipcMain.handle(IPC.gitStageAll, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitStageAllRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      try {
        const result = await stageAll(req.workspacePath)
        return ok(result)
      } finally {
        invalidateGitStatusCache(req.workspacePath)
        emitGitStatusChanged(req.workspacePath)
      }
    } catch (err) {
      return failFrom(err, IPC.gitStageAll)
    }
  })

  ipcMain.handle(IPC.gitStagePaths, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitStagePathsRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      try {
        const result = await stagePaths(req.workspacePath, req.paths)
        return ok(result)
      } finally {
        invalidateGitStatusCache(req.workspacePath)
        emitGitStatusChanged(req.workspacePath)
      }
    } catch (err) {
      return failFrom(err, IPC.gitStagePaths)
    }
  })

  ipcMain.handle(IPC.gitUnstagePaths, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitUnstagePathsRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      try {
        const result = await unstagePaths(req.workspacePath, req.paths)
        return ok(result)
      } finally {
        invalidateGitStatusCache(req.workspacePath)
        emitGitStatusChanged(req.workspacePath)
      }
    } catch (err) {
      return failFrom(err, IPC.gitUnstagePaths)
    }
  })

  ipcMain.handle(IPC.gitDiscardPaths, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitDiscardPathsRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      // A discard rewrites the files a running task is writing.
      if (runLiveInCheckout(req.workspacePath)) {
        return failExpected('A task is working in this checkout. Discard changes when it stops.', IPC.gitDiscardPaths)
      }
      try {
        // Every file git overwrites, and every untracked one removed, goes to the
        // OS trash — and a copy is kept here so Undo can put it back in place.
        let pending: Awaited<ReturnType<typeof snapshotForUndo>> | null = null
        try {
          pending = await snapshotForUndo(discardUndoRoot(), req.workspacePath, req.paths)
        } catch {
          pending = null
        }
        const result = await discardPaths(req.workspacePath, req.paths, req.scope, (abs) => shell.trashItem(abs))
        const undoId = pending ? await pending.finish(result.discarded).catch(() => null) : null
        return ok(undoId ? { ...result, undoId } : result)
      } catch (err) {
        return failExpected(formatError(err), IPC.gitDiscardPaths)
      } finally {
        invalidateGitStatusCache(req.workspacePath)
        emitGitStatusChanged(req.workspacePath)
      }
    } catch (err) {
      return failFrom(err, IPC.gitDiscardPaths)
    }
  })

  ipcMain.handle(IPC.gitDiscardUndo, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitDiscardUndoRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      if (runLiveInCheckout(req.workspacePath)) {
        return failExpected('A task is working in this checkout. Undo the discard when it stops.', IPC.gitDiscardUndo)
      }
      try {
        return ok(await undoDiscard(discardUndoRoot(), req.workspacePath, req.id))
      } catch (err) {
        return failExpected(formatError(err), IPC.gitDiscardUndo)
      } finally {
        invalidateGitStatusCache(req.workspacePath)
        emitGitStatusChanged(req.workspacePath)
      }
    } catch (err) {
      return failFrom(err, IPC.gitDiscardUndo)
    }
  })

  ipcMain.handle(IPC.gitBranches, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitBranchesRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await listLocalBranches(req.workspacePath))
    } catch (err) {
      return failFrom(err, IPC.gitBranches)
    }
  })

  ipcMain.handle(IPC.gitCheckout, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitCheckoutRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      // A switch swaps the files a running task is writing.
      if (runLiveInCheckout(req.workspacePath)) {
        return failExpected('A task is working in this checkout. Switch branches when it stops.', IPC.gitCheckout)
      }
      try {
        const result = await checkoutBranch(req.workspacePath, req.branch, { leaveChanges: req.leaveChanges === true })
        return ok(result)
      } catch (err) {
        return failExpected(formatError(err), IPC.gitCheckout)
      } finally {
        invalidateGitStatusCache(req.workspacePath)
        emitGitStatusChanged(req.workspacePath)
      }
    } catch (err) {
      return failFrom(err, IPC.gitCheckout)
    }
  })

  ipcMain.handle(IPC.gitBranchStash, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitBranchStashRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await readBranchStash(req.workspacePath))
    } catch (err) {
      return failFrom(err, IPC.gitBranchStash)
    }
  })

  ipcMain.handle(IPC.gitStashRestore, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitStashRestoreRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      if (runLiveInCheckout(req.workspacePath)) {
        return failExpected('A task is working in this checkout. Restore the changes when it stops.', IPC.gitStashRestore)
      }
      try {
        return ok(await restoreBranchStash(req.workspacePath, req.sha))
      } catch (err) {
        return failExpected(formatError(err), IPC.gitStashRestore)
      } finally {
        invalidateGitStatusCache(req.workspacePath)
        emitGitStatusChanged(req.workspacePath)
      }
    } catch (err) {
      return failFrom(err, IPC.gitStashRestore)
    }
  })

  ipcMain.handle(IPC.gitStashDrop, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitStashRestoreRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      try {
        return ok(await dropBranchStash(req.workspacePath, req.sha))
      } catch (err) {
        return failExpected(formatError(err), IPC.gitStashDrop)
      } finally {
        emitGitStatusChanged(req.workspacePath)
      }
    } catch (err) {
      return failFrom(err, IPC.gitStashDrop)
    }
  })

  ipcMain.handle(IPC.gitStageHunk, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitStageHunkRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      try {
        return ok(await stageHunk(req.workspacePath, req.path, req.hunk, req.diffHash, req.unstage === true))
      } catch (err) {
        return failExpected(formatError(err), IPC.gitStageHunk)
      } finally {
        invalidateGitStatusCache(req.workspacePath)
        emitGitStatusChanged(req.workspacePath)
      }
    } catch (err) {
      return failFrom(err, IPC.gitStageHunk)
    }
  })

  ipcMain.handle(IPC.gitLastCommit, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitLastCommitRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await readLastCommit(req.workspacePath))
    } catch (err) {
      return failFrom(err, IPC.gitLastCommit)
    }
  })

  ipcMain.handle(IPC.gitAmend, async (event, raw): Promise<IpcResult<GitCommitResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitAmendRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      try {
        const result = await amendLastCommit(req.workspacePath, req.message, req.sha, req.mode ?? 'all')
        // Amended from a task's Changes: the new commit settles what it took of that task, as Commit does.
        const task = req.runId ? await settleTaskAfterCommit(req.workspacePath, req.runId, result) : undefined
        return ok(task ? { ...result, task } : result)
      } catch (err) {
        return failExpected(formatError(err), IPC.gitAmend)
      } finally {
        invalidateGitStatusCache(req.workspacePath)
        emitGitStatusChanged(req.workspacePath)
      }
    } catch (err) {
      return failFrom(err, IPC.gitAmend)
    }
  })

  ipcMain.handle(IPC.gitFetch, async (event, raw): Promise<IpcResult<GitFetchResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitFetchRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      if (req.background) {
        // The app's own periodic fetch: quiet when it fails, and the
        // renderer hears about it only when the branch's counts moved.
        try {
          const result = await backgroundFetch(req.workspacePath)
          if (result.changed || result.refsMoved) gitSyncSettled(req.workspacePath)
          const { changed: _changed, ...rest } = result
          return ok(rest)
        } catch (err) {
          return fail(formatError(err))
        }
      }
      try {
        return ok(await exclusiveFetch(req.workspacePath, () => fetchRemotes(req.workspacePath)))
      } catch (err) {
        return failExpected(formatError(err), IPC.gitFetch)
      } finally {
        gitSyncSettled(req.workspacePath)
      }
    } catch (err) {
      return failFrom(err, IPC.gitFetch)
    }
  })

  ipcMain.handle(IPC.gitPull, async (event, raw): Promise<IpcResult<GitPullResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitPullRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      if (runLiveInCheckout(req.workspacePath)) {
        return failExpected('A task is working in this checkout. Pull when it stops.', IPC.gitPull)
      }
      try {
        // Pull fetches first: it waits for a background fetch rather than racing it for the refs.
        return ok(await exclusiveFetch(req.workspacePath, () => pullCurrentBranch(req.workspacePath, req.strategy ?? 'ff-only')))
      } catch (err) {
        return failExpected(formatError(err), IPC.gitPull)
      } finally {
        gitSyncSettled(req.workspacePath)
      }
    } catch (err) {
      return failFrom(err, IPC.gitPull)
    }
  })

  ipcMain.handle(IPC.gitPush, async (event, raw): Promise<IpcResult<GitPushResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitPushRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      try {
        return ok(await pushBranch(req.workspacePath, { setUpstream: req.setUpstream !== false }))
      } catch (err) {
        return failExpected(formatError(err), IPC.gitPush)
      } finally {
        gitSyncSettled(req.workspacePath)
      }
    } catch (err) {
      return failFrom(err, IPC.gitPush)
    }
  })

  ipcMain.handle(IPC.gitBranchDelete, async (event, raw): Promise<IpcResult<GitBranchDeleteResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitBranchDeleteRequestSchema.parse(raw)
      return await gitMutation(IPC.gitBranchDelete, req.workspacePath, 'Delete the branch', () =>
        deleteLocalBranch(req.workspacePath, req.branch, { force: req.force === true })
      )
    } catch (err) {
      return failFrom(err, IPC.gitBranchDelete)
    }
  })

  ipcMain.handle(IPC.gitBranchRename, async (event, raw): Promise<IpcResult<{ detail: string }>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitBranchRenameRequestSchema.parse(raw)
      return await gitMutation(IPC.gitBranchRename, req.workspacePath, 'Rename the branch', () =>
        renameLocalBranch(req.workspacePath, req.from, req.to)
      )
    } catch (err) {
      return failFrom(err, IPC.gitBranchRename)
    }
  })

  ipcMain.handle(IPC.gitStashList, async (event, raw): Promise<IpcResult<GitStashEntry[]>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitBranchesRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await listAllStashes(req.workspacePath))
    } catch (err) {
      return failFrom(err, IPC.gitStashList)
    }
  })

  ipcMain.handle(IPC.gitStashApply, async (event, raw): Promise<IpcResult<GitStashRestoreResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitStashApplyRequestSchema.parse(raw)
      return await gitMutation(IPC.gitStashApply, req.workspacePath, 'Apply the stash', () =>
        applyAnyStash(req.workspacePath, req.sha, { drop: req.drop === true })
      )
    } catch (err) {
      return failFrom(err, IPC.gitStashApply)
    }
  })

  ipcMain.handle(IPC.gitStashDropAny, async (event, raw): Promise<IpcResult<{ detail: string }>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitStashRestoreRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await dropAnyStash(req.workspacePath, req.sha))
    } catch (err) {
      return failFrom(err, IPC.gitStashDropAny)
    }
  })

  ipcMain.handle(IPC.gitIntegrate, async (event, raw): Promise<IpcResult<GitIntegrateResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitIntegrateRequestSchema.parse(raw)
      const what = req.op === 'merge' ? 'Merge' : req.op === 'revert' ? 'Revert' : 'Cherry-pick'
      return await gitMutation(IPC.gitIntegrate, req.workspacePath, what, () =>
        integrateCommit(req.workspacePath, req.op, req.target)
      )
    } catch (err) {
      return failFrom(err, IPC.gitIntegrate)
    }
  })

  ipcMain.handle(IPC.gitCreateBranch, async (event, raw): Promise<IpcResult<GitCreateBranchResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitCreateBranchRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      if (req.from && req.checkout !== false && runLiveInCheckout(req.workspacePath)) {
        return failExpected(
          'A task is working in this checkout. Start a branch from elsewhere when it stops.',
          IPC.gitCreateBranch
        )
      }
      try {
        return ok(
          await createGitBranch(req.workspacePath, req.name, {
            ...(req.from ? { from: req.from } : {}),
            checkout: req.checkout !== false
          })
        )
      } catch (err) {
        return failExpected(formatError(err), IPC.gitCreateBranch)
      } finally {
        gitSyncSettled(req.workspacePath)
      }
    } catch (err) {
      return failFrom(err, IPC.gitCreateBranch)
    }
  })

  ipcMain.handle(IPC.gitLog, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitLogRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await readGitLog(req.workspacePath, req.limit))
    } catch (err) {
      return failFrom(err, IPC.gitLog)
    }
  })

  ipcMain.handle(IPC.gitCommitFiles, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitCommitFilesRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok({ files: await readGitCommitFiles(req.workspacePath, req.sha) })
    } catch (err) {
      return failFrom(err, IPC.gitCommitFiles)
    }
  })

  ipcMain.handle(IPC.gitBranchDiff, async (event, raw): Promise<IpcResult<GitBranchDiffResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitBranchDiffRequestSchema.parse(raw ?? {})
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      const result = await readBranchDiff(req.workspacePath)
      if (!result.ok) return fail(result.error)
      // Both sides of the channel agree on the shape: nothing leaves main that
      // the renderer's `GitBranchDiffResult` consumer could not read.
      return ok(GitBranchDiffResultSchema.parse(result.data))
    } catch (err) {
      return failFrom(err, IPC.gitBranchDiff)
    }
  })

  ipcMain.handle(IPC.gitDiff, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitDiffRequestSchema.parse(raw ?? {})
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      const result = await readGitDiff(req.workspacePath, {
        path: req.path,
        staged: req.staged,
        ignoreWhitespace: req.ignoreWhitespace,
        sha: req.sha,
        vsHead: req.vsHead
      })
      if (!result.ok) return fail(result.error)
      return ok({ content: result.content })
    } catch (err) {
      return failFrom(err, IPC.gitDiff)
    }
  })

  ipcMain.handle(IPC.gitBlame, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitBlameRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await readGitBlame(req.workspacePath, req.path))
    } catch (err) {
      return failFrom(err, IPC.gitBlame)
    }
  })

  ipcMain.handle(
    IPC.gitConflictFile,
    async (event, raw): Promise<IpcResult<GitConflictFileResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = GitConflictFileRequestSchema.parse(raw)
        if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
        return ok(await readConflictFile(req.workspacePath, req.path))
      } catch (err) {
        return failFrom(err, IPC.gitConflictFile)
      }
    }
  )

  ipcMain.handle(IPC.gitResolveConflict, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitResolveConflictRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      const result = await resolveConflict(req.workspacePath, req.path, req.content)
      invalidateGitStatusCache(req.workspacePath)
      return ok(result)
    } catch (err) {
      return failFrom(err, IPC.gitResolveConflict)
    }
  })
}
