import { ipcMain } from 'electron'
import { IPC } from '../../../shared/channels'
import {
  PrViewRequestSchema,
  PrCreateRequestSchema,
  PrMergeRequestSchema,
  PrDiffRequestSchema,
  PrCloseRequestSchema,
  PrReadyRequestSchema,
  PrEditTitleRequestSchema,
  PrReviewThreadsRequestSchema,
  PrReviewThreadResolveRequestSchema,
  PrReviewThreadReplyRequestSchema,
  PrListRequestSchema,
  PrCheckoutRequestSchema,
  PrCheckLogRequestSchema,
  PrCheckRerunRequestSchema,
  PrCleanupMergedRequestSchema,
  PrCommentRequestSchema,
  PrNumberRequestSchema,
  PrEditBodyRequestSchema,
  PrReviewersRequestSchema,
  PrReviewerSuggestionsRequestSchema,
  PrAutoMergeRequestSchema,
  GithubAuthStartRequestSchema,
  PrReviewRequestSchema,
  GithubIssuesListRequestSchema,
  GithubIssueCreateRequestSchema,
  GithubIssueViewRequestSchema,
  ok,
  fail,
  type IpcResult,
  type GithubIssuesListResult,
  type GithubIssueCreateResult,
  type TaskCommitSettled
} from '../../../shared/ipc'
import { formatError } from '../../../shared/errors'
import { settleTaskAfterCommit } from '../../agent/taskSettle'
import { listActiveRuns } from '../../agent/runRegistry'
import { workspacePathsEqual } from '../../../shared/workspacePath'
import { invalidateGitStatusCache } from '@main/git/gitStatusCache'
import { emitGitStatusChanged } from '@main/git/gitStatusEvents'
import {
  prClose,
  prReady,
  prCreate,
  prCreateFromChanges,
  prDiff,
  prEditTitle,
  prMerge,
  prView,
  prReviewThreads,
  prReviewThreadResolve,
  prReviewThreadReply,
  prList,
  prCheckout,
  prCheckLog,
  prCheckRerun,
  prCleanupMerged,
  prComment,
  prAllComments,
  prLeaveMergeQueue,
  prEditBody,
  prEditReviewers,
  prReviewerSuggestions,
  prSetAutoMerge,
  reviewPullRequest,
  listGithubIssues,
  createGithubIssue,
  viewGithubIssue
} from '@main/git/gh'
import {
  cancelGithubAuth,
  githubAuthStatus,
  logoutGithubAuth,
  startGithubAuth
} from '@main/git/githubAuth'
import { installGithubCli } from '@main/git/ghBinary'
import { collectProcessMetrics } from '../../perf/loadSnapshot'
import { failExpected, failFrom, isOpenWorkspace, senderOk } from '../ipcShared'

/** Pull requests and issues on GitHub, through the gh CLI. Registered once by registerIpc. */
export function registerPrIpc(): void {
  ipcMain.handle(IPC.prView, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PrViewRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await prView(req.workspacePath, req.number))
    } catch (err) {
      return failFrom(err, IPC.prView)
    }
  })

  ipcMain.handle(IPC.prCreate, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    let workspacePath: string | null = null
    try {
      const req = PrCreateRequestSchema.parse(raw)
      workspacePath = req.workspacePath
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      if (!req.message) {
        return ok(await prCreate(req.workspacePath, { draft: req.draft, title: req.title, body: req.body }))
      }
      // Committed from a task's Changes: the commit settles what it took of that task, as Commit does.
      let task: TaskCommitSettled | undefined
      const runId = req.runId
      const result = await prCreateFromChanges(req.workspacePath, req.message, req.mode, {
        draft: req.draft,
        title: req.title,
        body: req.body,
        ...(runId
          ? {
              onCommitted: async (outcome) => {
                task = await settleTaskAfterCommit(req.workspacePath, runId, outcome)
              }
            }
          : {})
      })
      return ok(task ? { ...result, task } : result)
    } catch (err) {
      return failFrom(err, IPC.prCreate)
    } finally {
      if (workspacePath) invalidateGitStatusCache(workspacePath)
    }
  })

  ipcMain.handle(IPC.prMerge, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PrMergeRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await prMerge(req.workspacePath, req.method, req.number))
    } catch (err) {
      return failFrom(err, IPC.prMerge)
    }
  })

  ipcMain.handle(IPC.prDiff, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PrDiffRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(
        await prDiff(req.workspacePath, {
          path: req.path,
          ignoreWhitespace: req.ignoreWhitespace,
          number: req.number
        })
      )
    } catch (err) {
      return failFrom(err, IPC.prDiff)
    }
  })

  ipcMain.handle(IPC.prClose, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PrCloseRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await prClose(req.workspacePath, req.number))
    } catch (err) {
      return failFrom(err, IPC.prClose)
    }
  })

  ipcMain.handle(IPC.prReady, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PrReadyRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await prReady(req.workspacePath, req.number))
    } catch (err) {
      return failFrom(err, IPC.prReady)
    }
  })

  ipcMain.handle(IPC.prEditTitle, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PrEditTitleRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await prEditTitle(req.workspacePath, req.title, req.number))
    } catch (err) {
      return failFrom(err, IPC.prEditTitle)
    }
  })

  // ── PR review threads, open PR list, PR checkout ──
  ipcMain.handle(IPC.prReviewThreads, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PrReviewThreadsRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await prReviewThreads(req.workspacePath, req.number))
    } catch (err) {
      return failFrom(err, IPC.prReviewThreads)
    }
  })

  ipcMain.handle(IPC.prReviewThreadResolve, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PrReviewThreadResolveRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await prReviewThreadResolve(req.workspacePath, req.threadId, req.resolved))
    } catch (err) {
      return failFrom(err, IPC.prReviewThreadResolve)
    }
  })

  ipcMain.handle(IPC.prReviewThreadReply, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PrReviewThreadReplyRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await prReviewThreadReply(req.workspacePath, req.threadId, req.body))
    } catch (err) {
      return failFrom(err, IPC.prReviewThreadReply)
    }
  })

  ipcMain.handle(IPC.prList, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PrListRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await prList(req.workspacePath))
    } catch (err) {
      return failFrom(err, IPC.prList)
    }
  })

  ipcMain.handle(IPC.prCheckout, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    let workspacePath: string | null = null
    try {
      const req = PrCheckoutRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      // A task working in this checkout would find its files swapped under it.
      const running = listActiveRuns().filter((run) => workspacePathsEqual(run.workspacePath, req.workspacePath))
      if (running.length > 0) {
        return fail(
          `A task is running in this checkout. Stop it or wait for it to finish before checking out pull request #${req.number}.`
        )
      }
      workspacePath = req.workspacePath
      return ok(await prCheckout(req.workspacePath, req.number))
    } catch (err) {
      return failFrom(err, IPC.prCheckout)
    } finally {
      if (workspacePath) {
        invalidateGitStatusCache(workspacePath)
        emitGitStatusChanged(workspacePath)
      }
    }
  })

  ipcMain.handle(IPC.prCheckLog, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PrCheckLogRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await prCheckLog(req.workspacePath, req.url))
    } catch (err) {
      return failFrom(err, IPC.prCheckLog)
    }
  })

  ipcMain.handle(IPC.prCheckRerun, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PrCheckRerunRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await prCheckRerun(req.workspacePath, req.url))
    } catch (err) {
      return failFrom(err, IPC.prCheckRerun)
    }
  })

  ipcMain.handle(IPC.prCleanupMerged, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    let workspacePath: string | null = null
    try {
      const req = PrCleanupMergedRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      // Switching branches under a running task would swap its files, as a checkout does.
      const running = listActiveRuns().filter((run) => workspacePathsEqual(run.workspacePath, req.workspacePath))
      if (running.length > 0) {
        return fail('A task is running in this checkout. Stop it or wait for it to finish before cleaning up the branch.')
      }
      workspacePath = req.workspacePath
      return ok(await prCleanupMerged(req.workspacePath, req.number))
    } catch (err) {
      return failFrom(err, IPC.prCleanupMerged)
    } finally {
      if (workspacePath) {
        invalidateGitStatusCache(workspacePath)
        emitGitStatusChanged(workspacePath)
      }
    }
  })

  ipcMain.handle(IPC.prComment, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PrCommentRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await prComment(req.workspacePath, req.number, req.body))
    } catch (err) {
      return failFrom(err, IPC.prComment)
    }
  })

  ipcMain.handle(IPC.prCommentsAll, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PrNumberRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      try {
        return ok(await prAllComments(req.workspacePath, req.number))
      } catch (err) {
        return failExpected(formatError(err), IPC.prCommentsAll)
      }
    } catch (err) {
      return failFrom(err, IPC.prCommentsAll)
    }
  })

  ipcMain.handle(IPC.prLeaveMergeQueue, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PrNumberRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      try {
        return ok(await prLeaveMergeQueue(req.workspacePath, req.number))
      } catch (err) {
        return failExpected(formatError(err), IPC.prLeaveMergeQueue)
      }
    } catch (err) {
      return failFrom(err, IPC.prLeaveMergeQueue)
    }
  })

  ipcMain.handle(IPC.prEditBody, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PrEditBodyRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await prEditBody(req.workspacePath, req.number, req.body, req.expected))
    } catch (err) {
      return failFrom(err, IPC.prEditBody)
    }
  })

  ipcMain.handle(IPC.prReviewers, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PrReviewersRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await prEditReviewers(req.workspacePath, req.number, req.add, req.remove))
    } catch (err) {
      return failFrom(err, IPC.prReviewers)
    }
  })

  ipcMain.handle(IPC.prReviewerSuggestions, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PrReviewerSuggestionsRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await prReviewerSuggestions(req.workspacePath))
    } catch (err) {
      return failFrom(err, IPC.prReviewerSuggestions)
    }
  })

  ipcMain.handle(IPC.prAutoMerge, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PrAutoMergeRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await prSetAutoMerge(req.workspacePath, req.number, req.enable, req.method ?? 'squash'))
    } catch (err) {
      return failFrom(err, IPC.prAutoMerge)
    }
  })

  ipcMain.handle(IPC.githubAuthStatus, async (event) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok(await githubAuthStatus())
    } catch (err) {
      return failFrom(err, IPC.githubAuthStatus)
    }
  })

  ipcMain.handle(IPC.githubAuthStart, async (event, raw: unknown) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GithubAuthStartRequestSchema.parse(raw)
      return ok(await startGithubAuth({ fresh: req?.fresh === true }))
    } catch (err) {
      return failFrom(err, IPC.githubAuthStart)
    }
  })

  ipcMain.handle(IPC.githubAuthCancel, async (event) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      cancelGithubAuth()
      return ok(await githubAuthStatus())
    } catch (err) {
      return failFrom(err, IPC.githubAuthCancel)
    }
  })

  ipcMain.handle(IPC.githubAuthLogout, async (event) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok(await logoutGithubAuth())
    } catch (err) {
      return failFrom(err, IPC.githubAuthLogout)
    }
  })

  ipcMain.handle(IPC.githubCliInstall, async (event) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok(await installGithubCli())
    } catch (err) {
      return failFrom(err, IPC.githubCliInstall)
    }
  })

  ipcMain.handle(IPC.prReview, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PrReviewRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(
        await reviewPullRequest(req.workspacePath, req.event, req.body, req.number)
      )
    } catch (err) {
      return failFrom(err, IPC.prReview)
    }
  })

  ipcMain.handle(
    IPC.githubIssuesList,
    async (event, raw): Promise<IpcResult<GithubIssuesListResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = GithubIssuesListRequestSchema.parse(raw)
        if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
        return ok(await listGithubIssues(req.workspacePath))
      } catch (err) {
        return failFrom(err, IPC.githubIssuesList)
      }
    }
  )

  ipcMain.handle(
    IPC.githubIssueCreate,
    async (event, raw): Promise<IpcResult<GithubIssueCreateResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = GithubIssueCreateRequestSchema.parse(raw)
        if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
        return ok(await createGithubIssue(req.workspacePath, req.title, req.body))
      } catch (err) {
        return failFrom(err, IPC.githubIssueCreate)
      }
    }
  )

  ipcMain.handle(IPC.githubIssueView, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GithubIssueViewRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await viewGithubIssue(req.workspacePath, req.number))
    } catch (err) {
      return failFrom(err, IPC.githubIssueView)
    }
  })

  ipcMain.handle(IPC.processMetrics, async (event) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok(collectProcessMetrics())
    } catch (err) {
      return failFrom(err, IPC.processMetrics)
    }
  })
}
