import type { AgentToolName } from '../schemas/tools'
import { toolGitStatusAsync, toolGitDiffAsync } from './gitHelpers'
import { patchTouchedPaths, toolApplyPatchAsync } from './applyPatch'
import { getWriteCheckpoint } from '../checkpoints'
import { commitPaths } from '@main/git/git'
import {
  prCreate,
  prCheckLog,
  prView,
  prReviewThreads,
  parseActionsJobUrl,
  reviewPullRequest,
  listGithubIssues,
  createGithubIssue,
  viewGithubIssue
} from '@main/git/gh'
import { wrapUntrustedContent } from '../untrustedContent'
import { readTrimmed } from './argAccess'
import { invalidateAfterWorkspaceMutation, throwIfAborted, toolOk, toolFail } from './index'
import type { ToolHandler } from './index'
import type { PrReviewThread, PrView } from '../../../shared/ipc'

/** Conclusions GitHub reports for a check that failed (the PR panel's own set). */
const FAILED_CHECK_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'])
/** Job logs read per call: each is a `gh run view` of up to megabytes. */
const CHECK_LOGS_READ = 3
/** One comment's text as handed over; a pasted log can run to megabytes. */
const DISCUSSION_BODY_MAX = 4_000
/** The whole discussion as handed over: unresolved threads and reviews come first, so a cut takes the rest. */
const DISCUSSION_MAX = 40_000

function clip(text: string, max: number): string {
  const body = text.trim()
  return body.length > max ? `${body.slice(0, max)}\n[... ${body.length - max} more characters on GitHub]` : body
}

function threadPlace(thread: PrReviewThread): string {
  const line = thread.line ?? thread.originalLine
  const span = thread.startLine && line && thread.startLine !== line ? `${thread.startLine}-${line}` : line ? String(line) : ''
  return `${thread.path}${span ? `:${span}` : ''}${thread.diffSide === 'LEFT' ? ' (old side)' : ''}${thread.isOutdated ? ' (outdated: the code moved since)' : ''}`
}

/**
 * A pull request's discussion, most actionable first: what reviewers asked
 * (their latest reviews and the inline threads still open), then the
 * conversation, then the threads already resolved, by place only.
 */
function formatPrDiscussion(pr: PrView, threads: { threads: PrReviewThread[]; totalCount: number; truncated: boolean } | null): string {
  const out: string[] = [
    `Pull request #${pr.number} ${pr.title} (${pr.state.toLowerCase()}${pr.isDraft ? ', draft' : ''}) ${pr.headRefName} -> ${pr.baseRefName}`,
    pr.url,
    '',
    'Description:',
    clip(pr.body, DISCUSSION_BODY_MAX) || '(no description)'
  ]
  const reviews = pr.latestReviews.filter((r) => r.body.trim() || r.state.toUpperCase() !== 'COMMENTED')
  if (reviews.length > 0) {
    out.push('', `Latest review from each reviewer (${reviews.length}):`)
    for (const r of reviews) {
      out.push(`--- ${r.author}: ${r.state.toLowerCase().replace(/_/g, ' ')}${r.submittedAt ? ` ${r.submittedAt}` : ''}`)
      if (r.body.trim()) out.push(clip(r.body, DISCUSSION_BODY_MAX))
    }
  }
  if (pr.reviewRequests.length > 0) out.push('', `Review requested from: ${pr.reviewRequests.join(', ')}`)
  const open = threads?.threads.filter((t) => !t.isResolved) ?? []
  const resolved = threads?.threads.filter((t) => t.isResolved) ?? []
  if (threads === null) {
    out.push('', 'Inline review threads: GitHub did not return them.')
  } else if (open.length > 0) {
    out.push('', `Unresolved review threads (${open.length}):`)
    for (const t of open) {
      out.push('', `[${threadPlace(t)}]`)
      for (const c of t.comments) out.push(`--- ${c.author}${c.createdAt ? ` ${c.createdAt}` : ''}`, clip(c.body, DISCUSSION_BODY_MAX))
      if (t.commentCount > t.comments.length) out.push(`(${t.commentCount - t.comments.length} later replies are on GitHub)`)
    }
  } else {
    out.push('', 'Unresolved review threads: none.')
  }
  const comments = pr.comments ?? []
  const count = pr.commentCount ?? comments.length
  if (count > 0) {
    out.push('', `Conversation (${comments.length === count ? count : `latest ${comments.length} of ${count}`}, oldest first):`)
    for (const c of comments) {
      out.push(`--- ${c.author}${c.createdAt ? ` ${c.createdAt}` : ''}${c.minimized ? ' (hidden on GitHub)' : ''}`)
      if (!c.minimized) out.push(clip(c.body, DISCUSSION_BODY_MAX))
    }
  } else {
    out.push('', 'Conversation: no comments.')
  }
  if (resolved.length > 0) {
    out.push('', `Resolved review threads (${resolved.length}):`)
    for (const t of resolved) out.push(`- ${threadPlace(t)}${t.resolvedBy ? ` · resolved by ${t.resolvedBy}` : ''}`)
  }
  if (threads?.truncated) out.push('', `GitHub has ${threads.totalCount} review threads; the first ${threads.threads.length} are above.`)
  const text = out.join('\n')
  return text.length > DISCUSSION_MAX ? `${text.slice(0, DISCUSSION_MAX)}\n[... the rest of the discussion is on GitHub: ${pr.url}]` : text
}

export const gitGithubHandlers = {
  git_status: async (workspace, _args, signal) => {
    throwIfAborted(signal)
    const content = await toolGitStatusAsync(workspace)
    throwIfAborted(signal)
    return toolOk('git_status', 'git status', content)
  },
  git_diff: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const path = typeof args.path === 'string' ? args.path : undefined
    const staged = args.staged === true
    const result = await toolGitDiffAsync(workspace, { path, staged })
    throwIfAborted(signal)
    const summary = path ? `git diff ${path}` : staged ? 'git diff --staged' : 'git diff'
    // Match git_status: non-repo is informative ok content, not a hard tool failure.
    if (!result.ok && result.content === 'Not a git repository') {
      return toolOk('git_diff', summary, result.content)
    }
    if (!result.ok) return toolFail('git_diff', summary, result.content)
    return toolOk('git_diff', summary, result.content)
  },
  git_commit: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const message = readTrimmed(args, 'message')
    if (!message) return toolFail('git_commit', 'git commit', 'Commit message is required')
    const push = args.push === true
    const extraPaths = Array.isArray(args.paths)
      ? args.paths.filter((p): p is string => typeof p === 'string')
      : []
    try {
      // Scope staging to files this run actually changed (plus any paths the
      // model names explicitly) so unrelated user edits are not swept into
      // the commit. Refuse an empty scope — never fall back to staging all.
      const touched = new Set<string>([...(context.mutationPaths ?? []), ...extraPaths])
      if (touched.size === 0) {
        return toolFail(
          'git_commit',
          'git commit',
          'No run-touched files to commit. Pass paths: [...] for explicit paths, or edit/delete files in this run first.'
        )
      }
      const summary = push ? 'git commit + push' : 'git commit'
      const lines: string[] = []
      const outcome = await commitPaths(workspace, message, push, [...touched])
      const committed = outcome.committed
      const pushed = outcome.pushed
      lines.push(
        outcome.detail,
        `committed: ${outcome.committed}`,
        `pushed: ${outcome.pushed}`,
        `message: ${message}`
      )
      if (outcome.skipped.length > 0) {
        const shown = outcome.skipped.slice(0, 20)
        const more = outcome.skipped.length - shown.length
        lines.push(
          `left uncommitted (${outcome.skipped.length} unrelated dirty path${outcome.skipped.length === 1 ? '' : 's'}): ${shown.join(', ')}${more > 0 ? `, +${more} more` : ''}`,
          'To include any of these, call git_commit again with paths: [...].'
        )
      }
      if (committed) invalidateAfterWorkspaceMutation(workspace)
      return toolOk('git_commit', summary, lines.join('\n'))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return toolFail('git_commit', 'git commit', msg)
    }
  },
  git_apply: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    // Snapshot every file the patch names first, like the edit tools do, so
    // the write shows in Changes, can be undone, and dates the run's checks.
    const cp = args.check === true || context.skipWriteCheckpoint ? undefined : getWriteCheckpoint(context.runDir)
    if (cp) {
      // Same extraction the dispatch guard reads (index.ts): one parser, so the
      // undo record covers exactly the writes the path_scope check approved.
      const patchText = typeof args.patch === 'string' ? args.patch : ''
      for (const touched of patchTouchedPaths(patchText)) {
        try {
          await cp.recordPrior(touched.path, touched.kind, { nonEditTool: true })
        } catch {
          // A path outside the workspace: git apply refuses it too.
        }
      }
    }
    const result = await toolApplyPatchAsync(workspace, args, signal)
    throwIfAborted(signal)
    if (!result.ok) return toolFail('git_apply', result.summary, result.content)
    invalidateAfterWorkspaceMutation(workspace)
    return toolOk('git_apply', result.summary, result.content)
  },
  github_pr_create: async (workspace, args, signal) => {
    throwIfAborted(signal)
    try {
      const result = await prCreate(workspace, { draft: args.draft !== false })
      throwIfAborted(signal)
      return toolOk(
        'github_pr_create',
        result.url,
        [result.detail, result.url].filter(Boolean).join('\n')
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return toolFail('github_pr_create', 'gh pr create', msg)
    }
  },
  github_pr_review: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const event = args.event as 'approve' | 'request-changes' | 'comment'
    try {
      const result = await reviewPullRequest(
        workspace,
        event,
        typeof args.body === 'string' ? args.body : undefined,
        typeof args.number === 'number' ? args.number : undefined
      )
      throwIfAborted(signal)
      return toolOk('github_pr_review', event, result.detail)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return toolFail('github_pr_review', 'gh pr review', msg)
    }
  },
  github_pr_checks: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const number = typeof args.number === 'number' ? args.number : undefined
    const summary = number ? `checks on #${number}` : 'checks'
    try {
      const pr = await prView(workspace, number)
      throwIfAborted(signal)
      if (!pr) return toolOk('github_pr_checks', summary, 'This branch has no pull request on GitHub.')
      // The title, check names, descriptions and step names are written by
      // whoever opened the PR or wrote the workflow — a fork's, for a fork PR —
      // so all of it reaches the model inside the untrusted fence.
      const report = [`Pull request #${pr.number} ${pr.title} (${pr.state.toLowerCase()}) ${pr.headRefName} -> ${pr.baseRefName}`, pr.url]
      if (pr.checks.length === 0) report.push('No CI checks reported.')
      for (const check of pr.checks) {
        const verdict = (check.conclusion || check.state || 'unknown').toLowerCase()
        report.push(`- ${check.name}: ${verdict}${check.description ? ` (${check.description})` : ''}${check.url ? ` ${check.url}` : ''}`)
      }
      const lines = [
        wrapUntrustedContent(report.join('\n'), { source: 'github', origin: pr.url || `pull request #${pr.number}`, kind: 'pr_checks' })
      ]
      const failed = pr.checks.filter((c) => FAILED_CHECK_CONCLUSIONS.has((c.conclusion ?? '').toUpperCase()))
      let read = 0
      for (const check of failed) {
        if (!check.url || !parseActionsJobUrl(check.url)) continue
        if (read >= CHECK_LOGS_READ) {
          lines.push('', `More failed checks have logs; call again after fixing these, or read them with gh run view.`)
          break
        }
        read += 1
        throwIfAborted(signal)
        try {
          const log = await prCheckLog(workspace, check.url)
          throwIfAborted(signal)
          const text = [
            `Check: ${check.name}`,
            ...(log.step ? [`Failing step: ${log.step}`] : []),
            log.truncated ? 'Last lines of the log:' : 'Log:',
            log.excerpt || '(the job logged nothing)'
          ].join('\n')
          lines.push('', `Log of failed check ${read}:`, wrapUntrustedContent(text, { source: 'github', origin: check.url, kind: 'ci_log' }))
        } catch (err) {
          // Stopped: no more downloads, and no "could not be read" for a Stop.
          throwIfAborted(signal)
          lines.push('', `Log of failed check ${read} (${check.url}) could not be read: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      return toolOk('github_pr_checks', `#${pr.number}`, lines.join('\n'))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return toolFail('github_pr_checks', summary, msg)
    }
  },
  github_pr_comments: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const number = typeof args.number === 'number' ? args.number : undefined
    const summary = number ? `comments on #${number}` : 'comments'
    try {
      const pr = await prView(workspace, number)
      throwIfAborted(signal)
      if (!pr) return toolOk('github_pr_comments', summary, 'This branch has no pull request on GitHub.')
      let threads: Awaited<ReturnType<typeof prReviewThreads>> = null
      try {
        threads = await prReviewThreads(workspace, pr.number)
      } catch {
        // Said in the text; the rest of the discussion still helps.
        threads = null
      }
      throwIfAborted(signal)
      // Every word here was written by someone on GitHub — on a public
      // repository, anyone — so all of it reaches the model inside the fence.
      return toolOk(
        'github_pr_comments',
        `#${pr.number}`,
        wrapUntrustedContent(formatPrDiscussion(pr, threads), { source: 'github', origin: pr.url || `pull request #${pr.number}`, kind: 'pr_discussion' })
      )
    } catch (err) {
      throwIfAborted(signal)
      const msg = err instanceof Error ? err.message : String(err)
      return toolFail('github_pr_comments', summary, msg)
    }
  },
  github_issue: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const action = args.action as 'list' | 'view' | 'create'
    try {
      if (action === 'view') {
        const number = typeof args.number === 'number' ? args.number : 0
        if (!number) return toolFail('github_issue', 'view', 'number is required when action is view')
        const issue = await viewGithubIssue(workspace, number)
        throwIfAborted(signal)
        const text = [
          `#${issue.number} ${issue.title}`,
          `State: ${issue.state.toLowerCase()} · by ${issue.author}${issue.labels.length ? ` · labels: ${issue.labels.join(', ')}` : ''}`,
          issue.url,
          '',
          issue.body.trim() || '(no description)',
          ...(issue.commentCount > 0
            ? [
                '',
                `Comments (${issue.comments.length === issue.commentCount ? issue.commentCount : `latest ${issue.comments.length} of ${issue.commentCount}`}):`,
                ...issue.comments.map((c) => `--- ${c.author}${c.createdAt ? ` ${c.createdAt}` : ''}\n${c.body.trim()}`)
              ]
            : [])
        ].join('\n')
        return toolOk(
          'github_issue',
          `#${issue.number}`,
          wrapUntrustedContent(text, { source: 'github', origin: issue.url || `issue #${issue.number}`, kind: 'issue' })
        )
      }
      if (action === 'list') {
        const result = await listGithubIssues(workspace)
        throwIfAborted(signal)
        const lines = result.issues.map(
          (issue) => `#${issue.number} ${issue.state} ${issue.title} ${issue.url}`
        )
        // Anyone can title an issue on a public repository.
        return toolOk(
          'github_issue',
          'list',
          lines.length > 0
            ? wrapUntrustedContent(lines.join('\n'), { source: 'github', origin: 'open issues', kind: 'issue_list' })
            : 'No open issues.'
        )
      }
      const title = typeof args.title === 'string' ? args.title.trim() : ''
      if (!title) return toolFail('github_issue', 'create', 'title is required when action is create')
      const result = await createGithubIssue(
        workspace,
        title,
        typeof args.body === 'string' ? args.body : undefined
      )
      throwIfAborted(signal)
      return toolOk('github_issue', result.url, `${result.detail}\n${result.url}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return toolFail('github_issue', `gh issue ${action}`, msg)
    }
  }
} satisfies Partial<Record<AgentToolName, ToolHandler>>
